import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createState, transition, phaseRole, phaseModel, validatePlan, parseChildResult } from './supervised-state.mjs';

const resultContract = 'Return only strict JSON text (maximum 16000 characters), no markdown or extra keys. taskId and attemptId are STRING values copied from dispatch. evidence is a STRING, not an array/object, maximum 8000 characters. Completed shape: {"taskId":"<taskId>","attemptId":"<attemptId>","status":"completed","evidence":"<text>"}; completed forbids kind, scope, missing. Blocked shape: {"taskId":"<taskId>","attemptId":"<attemptId>","status":"blocked","kind":"local_scope","scope":"<taskId>","missing":"<nonblank text>","evidence":"<text>"}; scope must equal taskId; missing is a nonblank STRING, maximum 4000 characters. For terminal yield use {data: <this exact object>}, never yield error or a section.';

const dispatchInstruction = 'Bind the approved task with routing_dispatch. On the next request call native task with exactly the returned nativeTaskCall.arguments. Do not add or change fields. Only the supervisor supplies the worker model and strict result contract.';

// Only project known provider wire formats. Never change the registered native tool or
// its validation/approval. The execution guard below also applies to nonconforming clients.
function routedPayload(payload, bound, remember) {
  if (!Array.isArray(payload?.tools)) return;
  const named = t => (t?.type === 'function' && t.function || t)?.name === 'task';
  if (payload.tools.filter(named).length !== 1) return;
  let changed = false;
  const tools = payload.tools.map(tool => {
    const nested = tool?.type === 'function' && tool.function;
    const spec = nested || tool;
    if (spec?.name !== 'task') return tool;
    const key = spec.input_schema ? 'input_schema' : 'parameters';
    const schema = spec[key], batch = schema?.properties?.tasks, item = batch?.items;
    if (!item?.properties || !schema.properties.context ||
      (item.required !== undefined && !Array.isArray(item.required)) ||
      (schema.required !== undefined && !Array.isArray(schema.required))) return tool;
    const { outputSchema: _schema, schemaMode: _mode, ...properties } = item.properties;
    const required = item.required?.filter(k => k !== 'outputSchema' && k !== 'schemaMode');
    const field = properties.steps ? 'steps' : properties.task ? 'task' : null;
    const compatible = field && properties.agent && properties.solutionSpace &&
      (required ?? []).every(k => ['agent', 'solutionSpace', field].includes(k)) &&
      (schema.required ?? []).every(k => ['context', 'tasks'].includes(k));
    if (compatible && bound?.field === field) {
      const itemProperties = Object.fromEntries(Object.entries(bound.args.tasks[0]).map(([k, value]) =>
        [k, Array.isArray(value) ? { type:'array', items:{type:'string',enum:[...new Set(value)]} } : { type:'string', enum:[value] }]));
      const exact = { type:'object', additionalProperties:false, required:['context','tasks'], properties:{
        context:{type:'string',enum:[bound.args.context]}, tasks:{type:'array',
          items:{type:'object',additionalProperties:false,required:Object.keys(itemProperties),properties:itemProperties}} } };
      const presented = { ...spec, description:'Execute the bound routing dispatch with the exact arguments shown.', [key]:exact };
      changed = true; remember(field, true);
      return nested ? { ...tool, function:presented } : presented;
    }
    if (compatible) remember(field, false);
    if (!Object.hasOwn(item.properties, 'outputSchema') && !Object.hasOwn(item.properties, 'schemaMode') &&
      required?.length === item.required?.length) return tool;
    const projected = { ...item, properties, ...(required && { required }) };
    const presented = { ...spec,
      [key]: { ...schema, properties: { ...schema.properties, tasks: { ...batch, items: projected } } } };
    changed = true;
    return nested ? { ...tool, function: presented } : presented;
  });
  if (changed) return { ...payload, tools };
}

function workerResultSchema(taskId, attemptId) {
  const properties = { taskId: { type: 'string', const: taskId }, attemptId: { type: 'string', const: attemptId }, evidence: { type: 'string', maxLength: 8000 } };
  return { oneOf: [
    { type: 'object', additionalProperties: false, required: ['taskId', 'attemptId', 'status', 'evidence'], properties: { ...properties, status: { const: 'completed' } } },
    { type: 'object', additionalProperties: false, required: ['taskId', 'attemptId', 'status', 'evidence', 'kind', 'scope', 'missing'], properties: { ...properties, status: { const: 'blocked' }, kind: { const: 'local_scope' }, scope: { type: 'string', const: taskId }, missing: { type: 'string', maxLength: 4000, pattern: '\\S' } } },
  ] };
}

const rootContext = ctx => ctx.agent?.kind === 'main' && !ctx.agent.parentId;
const selector = m => `${m.provider}/${m.id}${m.effort ? ':' + m.effort : ''}`;
const routingTools = ['routing_submit_plan','routing_finish','routing_dispatch','routing_submit_task_repair','routing_continue_repair'];
const modelMatches = (m, b) => b && m?.provider === b.provider && m.id === b.id;
const ownTools = phase => ({planning:['routing_submit_plan'],coordination:['routing_finish'],execution:['routing_dispatch'],localrepair:['routing_submit_task_repair'],localexec:['routing_continue_repair']}[phase] || []);

export default function registerRouting(pi, entryPath, { loadBindings, assertRuntime, preflight }) {
  const entryType = 'routing-supervised-v1', T = pi.typebox.Type;
  let state = createState(), root, held, busy = false, freshPrompt = false, appendUncertain = false;
  // Authority is the original native task call, never an async job ID. A wait
  // already open on that attempt can synchronize its commit, not attest its origin.
  const calls = new Map(), seenCalls = new Set(), jobOwners = new Map();
  const owns = ctx => Boolean(rootContext(ctx) && root && ctx.sessionManager.getSessionId() === root);
  const auth = ctx => ({root: owns(ctx), sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, model: ctx.model?.id});
  const inventory = () => pi.getAllTools();
  const claim = {};
  const probe = 'portable-routing:active-factories:v1';
  pi.events.on(probe, event => { if (event?.session === root) event.seen.add(claim); });
  const assertSource = ctx => {
    if (appendUncertain) throw Error('ROUTING_CHECKPOINT_WRITE_UNCERTAIN');
    if (!owns(ctx) || held) throw Error(held || 'ROUTING_NOT_OWNED');
    assertRuntime();
    const seen = new Set(); pi.events.emit(probe, { session:root, seen });
    if (seen.size !== 1 || !seen.has(claim)) throw Error('DUPLICATE_ROUTING_SOURCE');
    const tools = inventory();
    for (const name of routingTools) {
      const rows = tools.filter(x => x.name === name);
      if (rows.length !== 1 || rows[0].sourceInfo?.source !== 'extension' || path.relative(entryPath, rows[0].sourceInfo.path) !== '') throw Error('ROUTING_TOOL_SOURCE_CONFLICT');
    }
  };
  const requireNative = name => {
    const rows = inventory().filter(t => t.name === name);
    if (rows.length !== 1 || rows[0].sourceInfo?.source !== 'builtin' || !pi.getActiveTools().includes(name)) throw Error(`NATIVE_TOOL_UNAVAILABLE: ${name}`);
  };
  const roleGuard = (ctx, role) => {
    assertSource(ctx); const b = state.profile?.roles[role];
    if (!b || !modelMatches(ctx.model,b) || (b.effort && pi.getThinkingLevel() !== b.effort) || phaseRole(state) !== role) throw Error('ROUTING_PHASE_ROLE_MISMATCH');
  };
  // ctx.model is the selected model, not proof of which assistant produced a tool call.
  let author;
  // Awaited stock hook: finalized provider message before tool dispatch; no rewrite.
  pi.on('assistant_message', ({message:m},ctx) => {
    if (!owns(ctx) || m?.role !== 'assistant') return;
    author = {root,generation:state.generation,phase:state.phase,provider:m.provider,id:m.model,
      calls: Array.isArray(m.content) ? m.content.filter(c=>c?.type==='toolCall').map(c=>[c.id,c.name,
        c.name === 'task' && boundTask && projectedAttempt === boundTask.id && isDeepStrictEqual(c.arguments,boundTask.args) ? boundTask.id : null]) : []};
  });
  const authored = (role,id,name) => {
    if (!author || !id || author.root !== root || author.generation !== state.generation || author.phase !== state.phase ||
        !modelMatches(author,state.profile?.roles[role]) || author.calls.filter(c=>c[0]===id).length!==1 ||
        !author.calls.some(([call,tool])=>call===id && tool===name)) throw Error('ROUTING_NATIVE_CALL_AUTHOR_UNVERIFIED');
  };
  let taskField, boundTask, projectedAttempt;
  pi.on('before_provider_request', (event, ctx) => {
    if (!owns(ctx) || state.phase !== 'execution') return;
    taskField = undefined; projectedAttempt = undefined;
    const intent = boundTask && state.attempts[boundTask.id];
    const bound = intent?.status === 'intent' && !intent.rejection && intent.taskId === state.currentTask ? boundTask : undefined;
    return routedPayload(event.payload, bound, (field, projected) => {
      taskField = field;
      if (projected) projectedAttempt = bound.id;
    });
  });
  const save = next => {
    if (appendUncertain) throw new Error('ROUTING_CHECKPOINT_WRITE_UNCERTAIN');
    try { pi.appendEntry(entryType, next); state = next; }
    catch (error) {
      appendUncertain = true;
      state = transition(state, { type: 'error' });
      for (const a of Object.values(state.attempts)) if (a.rejection) a.rejection.conflict = true;
      throw error;
    }
  };
  const plannedModel = (agent, ctx) => {
    assertSource(ctx);
    if (state.phase === 'paused') throw new Error('ROUTING_SESSION_PAUSED: reconcile checkpoint and work performed outside task ledger before explicit /routing resume; do not retry worker or auto-resume');
    if (state.phase !== 'execution') throw new Error(`ROUTING_PHASE_NOT_EXECUTING: ${state.phase}`);
    if (state.activeCalls.length > 1) throw new Error('ROUTING_CONCURRENT_TASKS_BLOCKED');
    if (state.plan?.decisions.length && !state.approved) throw new Error('ROUTING_EXECUTION_NOT_APPROVED');
    const task = state.tasks[state.currentTask];
    if (typeof agent !== 'string' || !task || task.agent !== agent || task.status !== 'running') throw new Error('ROUTING_AGENT_UNPLANNED');
    if (task.assignee !== 'worker' || agent !== state.profile.workerAgent) throw Error('ROUTING_AGENT_MODEL_MISMATCH');
    return selector(state.profile.roles.worker);
  };
  const restore = async ctx => {
    if (!state.original || state.legacy || state.activeCalls.length || Object.values(state.attempts).some(a => ['intent', 'active', 'unresolved'].includes(a.status))) return;
    await selectModel(ctx, state.original);
    await expose([]);
    save({ ...state, original: null });
  };
  const pause = async ctx => { save(transition(state, { type: 'cancel' })); if (!state.activeCalls.length) await restore(ctx); };
  const selectModel = async (ctx,b) => {
    const model = ctx.models.list().find(m => modelMatches(m,b));
    if (!model || (!modelMatches(ctx.model,b) && !await pi.setModel(model))) throw Error('ROUTING_MODEL_UNAVAILABLE');
    if (b.effort !== undefined && pi.getThinkingLevel() !== b.effort) pi.setThinkingLevel(b.effort);
    if (!modelMatches(ctx.models.current(),b) || (b.effort !== undefined && pi.getThinkingLevel() !== b.effort)) throw Error('ROUTING_MODEL_READBACK_MISMATCH');
  };
  // Only toggle our own default-inactive tools. Never restore a formerly active native tool.
  const expose = async names => {
    const active=pi.getActiveTools(); const next=[...active.filter(t=>!routingTools.includes(t)),...names];
    if (!isDeepStrictEqual(active,next)) await pi.setActiveTools(next);
  };
  const apply = async ctx => {
    assertSource(ctx); const selected = phaseModel(state);
    if (!selected) return;
    await selectModel(ctx,selected);
    await expose(ownTools(state.phase));
  };
  // ponytail: restore phase ownership at each turn; mid-request model changes need native serialization.
  pi.on('turn_start', async (_event, ctx) => {
    if (!owns(ctx)) return;
    const selected = phaseModel(state);
    if (!selected) return;
    try { await apply(ctx); } catch(error) { await pause(ctx); throw error; }
  });
  const queue = async ctx => {
    await apply(ctx);
    // A matching native custom message, not the selected model, proves delivery.
    pi.sendMessage({ customType: entryType, display: false, content: `Continue routing phase ${state.phase}.${state.phase === 'execution' ? ` Runtime approval: ${state.approved}. ${dispatchInstruction} Never replay completed tasks. Approved tasks: ${JSON.stringify(state.tasks)}` : ''}`, details: { token: state.pending, generation: state.generation, phase: state.phase } }, { deliverAs: 'nextTurn', triggerTurn: true });
  };
  pi.registerCommand('routing', { description:'Personal routing status and explicit phase decisions', handler: async (args, ctx) => {
    if (!owns(ctx)) return 'Routing supervisor inactive in child session.';
    if (held) { ctx.ui?.notify?.(held, 'warning'); return held; }
    if (args.trim()) assertSource(ctx);
    if (args.trim() === 'cancel') await pause(ctx);
    if (args.trim().startsWith('reconcile ')) {
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) throw new Error('INVALID_RECONCILIATION_COMMAND');
      save(transition(state, { type: 'reconcile_pre_spawn', authorized: true, attemptId: parts[1] }));
    }
    if (args.trim() === 'resume') {
      const checkpoint = state, next = transition(checkpoint, { type: 'user_resume', authorized: true });
      await preflight(ctx, checkpoint.profile);
      assertSource(ctx);
      if (state !== checkpoint) throw Error('ROUTING_CHECKPOINT_CHANGED');
      requireNative('task');
      save(next.original ? next : { ...next, original: { provider: ctx.model.provider, id: ctx.model.id, effort: pi.getThinkingLevel() } });
      try { await queue(ctx); } catch (error) { await pause(ctx); throw error; }
    }
    if (args.trim() === 'approve' && state.phase === 'awaiting_approval') {
      save(transition(state, { type: 'approve', authorized:true, generation: state.generation }));
      try { await queue(ctx); } catch (error) { await pause(ctx); throw error; }
    }
    if (args.trim().startsWith('approve-repair ')) {
      const [, taskId, revision] = args.trim().split(/\s+/);
      save(transition(state, { type: 'approve_repair', authorized: true, taskId, revision: Number(revision), masterId: state.master?.id }));
      try { await queue(ctx); } catch (error) { await pause(ctx); throw error; }
    }
    const text = `kind: ${ctx.agent?.kind ?? 'legacy'}; owned: ${owns(ctx)}; phase: ${state.phase}; generation: ${state.generation}; pending: ${state.pending || 'none'}${state.phase === 'awaiting_approval' ? `; decisions: ${JSON.stringify(state.plan.decisions)}; /routing approve or /routing cancel` : ''}`;
    ctx.ui?.notify?.(text, 'info');
    return text;
  } });
  pi.on('before_subagent_spawn', (event,ctx) => {
    if (!owns(ctx) || ['idle','done'].includes(state.phase)) return;
    try {
      const model = plannedModel(event.agent,ctx);
      if (event.invocationKind !== 'task' || !state.activeCalls.length || event.modelRole !== undefined || !isDeepStrictEqual(event.patterns,[model])) throw Error('UNBOUND_NATIVE_SPAWN');
      // Observe native per-call selection; never replace its model/grants.
    } catch(error) { return {block:true,reason:error.message}; }
  });
  pi.on('tool_call', (event, ctx) => {
    if (!owns(ctx)) return;
    if (held) return {block:true, reason:held};
    if (!['idle','done'].includes(state.phase)) {
      const permitted = ownTools(state.phase).includes(event.toolName) || (state.phase === 'execution' && ['task','wait'].includes(event.toolName));
      if (event.parentToolCallId !== undefined) return {block:true,reason:'ROUTING_NESTED_TOOL_CALL'};
      if (!permitted) return {block:true,reason:'ROUTING_PHASE_TOOL_UNAVAILABLE'};
      if (['task','wait'].includes(event.toolName)) { try { assertSource(ctx); requireNative(event.toolName); authored('executor',event.toolCallId,event.toolName); } catch(error) { return {block:true,reason:error.message}; } }
    }
    if (!['task','wait'].includes(event.toolName)) return;
    const reused = seenCalls.has(event.toolCallId);
    seenCalls.add(event.toolCallId);
    if (event.toolName === 'wait') {
      const r = calls.get(state.activeCalls[0]);
      if (!current(r) || !r.receipt) return;
      if (r.waitId || reused || typeof event.toolCallId !== 'string' || !event.toolCallId || !emptyWait(event.input)) return hold();
      r.waitId = event.toolCallId; r.synchronized = null;
      return;
    }
    if (['idle', 'done'].includes(state.phase)) return;
    let admissionFailed = false;
    try {
      if (Object.values(state.attempts).some(a => a.rejection?.toolCallId === event.toolCallId)) {
        save(transition(state, { type: 'pre_spawn_conflict', toolCallId: event.toolCallId }));
        throw new Error('ROUTING_REJECTED_CALL_REUSED');
      }
      if (reused) {
        if (state.activeCalls.includes(event.toolCallId)) save(transition(state, { type: 'settlement_conflict' }));
        throw new Error('ROUTING_NATIVE_CALL_REUSED');
      }
      // Native task input is a custom tool Record; batch entries carry agent, not model.
      const tasks = event.input?.tasks;
      if (!Array.isArray(tasks) || tasks.length !== 1) throw new Error('ROUTING_SEQUENTIAL_TASK_REQUIRED');
      for (const task of tasks) {
         if (!task || typeof task !== 'object' || Array.isArray(task)) throw Error('INVALID_ROUTING_TASK');
         const selected = plannedModel(task.agent,ctx);
         if ((Object.hasOwn(task,'model') && task.model !== selected) || Object.hasOwn(task,'effort') || ['model','effort','agent'].some(k=>Object.hasOwn(event.input,k))) throw Error('ROUTING_WORKER_MODEL_OWNED');
         if (task.outputSchema != null || task.schemaMode != null) throw Error('ROUTING_RESULT_CONTRACT_OWNED');
      }
      const attempt = Object.values(state.attempts).find(a => a.taskId === state.currentTask && a.status === 'intent');
      if (!attempt) throw new Error('ROUTING_DISPATCH_REQUIRED');
      if (boundTask?.id !== attempt.id || projectedAttempt !== attempt.id) throw Error('ROUTING_BOUND_TEMPLATE_NOT_PRESENTED');
      const expected = boundTask.args;
      const authoredAttempt = author.calls.find(([id]) => id === event.toolCallId)[2];
      if (authoredAttempt !== attempt.id || !isDeepStrictEqual(event.input, expected)) throw Error('ROUTING_BOUND_TEMPLATE_MISMATCH');
      const input = { context: `${expected.context}\n\n${resultContract}\nDispatch IDs: ${JSON.stringify({ taskId: attempt.taskId, attemptId: attempt.id })}`, tasks: [{ ...expected.tasks[0], model: selector(state.profile.roles.worker), outputSchema: workerResultSchema(attempt.taskId, attempt.id), schemaMode: 'strict' }] };
      admissionFailed = true;
      save(transition(state, { type: 'task_call', ...auth(ctx), taskId: state.currentTask, attemptId: attempt?.id, agent: tasks[0].agent, toolCallId: event.toolCallId }));
      calls.set(event.toolCallId, { call: event.toolCallId, attemptId: attempt.id, agent: attempt.agent });
      return { input };
    } catch (error) {
      const attempt = Object.values(state.attempts).find(a => a.taskId === state.currentTask && a.status === 'intent');
      try {
        if (!admissionFailed && state.phase === 'execution' && attempt && !attempt.rejection && typeof event.toolCallId === 'string' && event.toolCallId) {
          save(transition(state, { type: 'pre_spawn_rejected', ...auth(ctx), generation: state.generation, taskId: attempt.taskId, attemptId: attempt.id, toolCallId: event.toolCallId, reason: error.message }));
        }
      } catch {
        // Persistence failure cannot authorize reconciliation or dispatch in this process.
        state = transition(state, { type: 'error' });
      }
      return { block: true, reason: error.message };
    }
  });
  const active = r => r && state.activeCalls.includes(r.call) &&
    state.invocations[r.call]?.attemptId === r.attemptId && state.attempts[r.attemptId]?.status === 'active';
  const current = r => state.phase === 'execution' && active(r);
  const hold = () => save(transition(state, { type: 'settlement_conflict' }));
  const emptyWait = input => input != null && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).length;
  const ownedContract = (input, r) => {
    const t = input?.tasks?.length === 1 && input.tasks[0];
    return t?.agent === r.agent && t.model === selector(state.profile.roles.worker) && t.schemaMode === 'strict' &&
      isDeepStrictEqual(t.outputSchema, workerResultSchema(state.attempts[r.attemptId].taskId, r.attemptId));
  };
  const strict = s => s?.source === 'caller' && s.mode === 'strict' && s.status === 'valid' && s.data;
  const join = r => {
    if (!current(r) || !r.receipt || !r.final) return;
    if (!isDeepStrictEqual(r.receipt, r.final.handle) || jobOwners.get(r.receipt.job) !== r.call) return hold();
    if (r.waitId || r.synchronized === null) return;
    if (r.synchronized && !isDeepStrictEqual(r.synchronized, r.final.data)) return hold();
    save(transition(state, { type: 'task_result', toolCallId: r.call, nativeId: r.receipt.child, serving:r.final.serving, text: JSON.stringify(r.final.data) }));
  };
  const handle = details => {
    const p = details?.progress?.length === 1 && details.progress[0], j = details?.async;
    return p?.index === 0 && typeof p.id === 'string' && p.id && j?.type === 'task' &&
      typeof j.jobId === 'string' && j.jobId ? { child: p.id, job: j.jobId } : null;
  };
  const servingReceipt = row => ({identity:row.resolvedModelIdentity, effort:row.resolvedThinkingLevel ?? null});
  const servingWorker = row => {
    const b = state.profile.roles.worker;
    return row?.resolvedModelIdentity === `${b.provider}/${b.id}` && row.resolvedModelIsFallback !== true && (!b.effort || row.resolvedThinkingLevel === b.effort);
  };
  pi.on('tool_execution_update', (event, ctx) => {
    const r = calls.get(event.toolCallId);
    if (!owns(ctx) || event.toolName !== 'task' || !current(r)) return;
    const details = event.partialResult?.details, h = handle(details);
    if (details?.async?.type === 'task' && details.async.jobId) r.observedAsync = true;
    if (!h || details.progress[0].agent !== r.agent) return;
    const p = details.progress[0];
    if (details.async.state === 'failed' && ['failed', 'aborted'].includes(p.status)) {
      save(transition(state, { type: 'task_result', toolCallId: r.call, nativeId: h.child, error: true, aborted: p.status === 'aborted' })); return;
    }
    if (details.async.state !== 'completed' || p.status !== 'completed') return;
    if (!ownedContract(event.args, r) || !servingWorker(p)) return hold();
    const items = p.extractedToolData?.yield;
    if (!Array.isArray(items) || items.length !== 1 || items[0]?.status !== 'success' ||
      (items[0].type !== undefined && items[0].type !== 'result') || items[0].complete !== undefined ||
      items[0].schemaOverridden !== undefined || items[0].error !== undefined) return hold();
    let data;
    try { data = parseChildResult(JSON.stringify(items[0].data)); } catch { return hold(); }
    const a = state.attempts[r.attemptId];
    if (data.taskId !== a.taskId || data.attemptId !== a.id) return hold();
    const final = { handle:h, data, serving: servingReceipt(p) };
    if (r.final && !isDeepStrictEqual(r.final, final)) return hold();
    r.final = final; join(r);
  });
  // Stock approval can throw before the wrapper emits tool_result. Only settle
  // the original call; a loop boundary alone says nothing about its outcome.
  const failNativeCall = (event, ctx, approvalRefused) => {
    if (!owns(ctx) || event.toolName !== 'task' || event.parentToolCallId !== undefined) return;
    const r = calls.get(event.toolCallId);
    if (!active(r) || r.observedAsync || r.receipt || state.attempts[r.attemptId].nativeId) return;
    const job = event.result?.details?.async;
    if (job?.type === 'task' && job.jobId) return;
    save(transition(state, { type: 'task_result', toolCallId: r.call, error: true, approvalRefused }));
  };
  pi.on('tool_approval_resolved', (event, ctx) => {
    if (event.sessionId === root && event.approved === false) failNativeCall(event, ctx, true);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    if (event.isError === true) failNativeCall(event, ctx, false);
  });
  pi.on('tool_result', (event, ctx) => {
    if (!owns(ctx) || event.parentToolCallId !== undefined) return;
    if (event.toolName === 'wait') {
      const r = calls.get(state.activeCalls[0]);
      if (!current(r) || !r.waitId || event.toolCallId !== r.waitId) return;
      r.waitId = undefined;
      r.synchronized = undefined; // No commit on an unrelated wake; future original evidence may settle normally.
      const d = event.details;
      if (!emptyWait(event.input)) return hold();
      if (event.isError || d?.interrupted) return;
      if (d?.op !== 'wait' || !Array.isArray(d.jobs)) return hold();
      const rows = d.jobs.filter(j => j?.id === r.receipt.job);
      if (!rows.length) return;
      const j = rows[0];
      if (rows.length !== 1 || j.type !== 'task' || j.agentUrlId !== r.receipt.child) return hold();
      if (['running', 'queued'].includes(j.status)) return;
      const unproven = () => save(transition(state, { type: 'terminal_wait_unproven' }));
      if (j.status !== 'completed') return unproven();
      let data;
      try { data = parseChildResult(JSON.stringify(strict(j.structured))); } catch { return unproven(); }
      if (data.attemptId !== r.attemptId || data.taskId !== state.attempts[r.attemptId].taskId) return unproven();
      r.synchronized = data; join(r); return;
    }
    if (event.toolName !== 'task') return;
    if (Object.values(state.attempts).some(a => a.rejection?.toolCallId === event.toolCallId)) {
      save(transition(state, { type: 'pre_spawn_conflict', toolCallId: event.toolCallId })); return;
    }
    const r = calls.get(event.toolCallId);
    const d = event.details, h = handle(d);
    if (h && !event.isError && d.results?.length === 0) {
      const prior = jobOwners.get(h.job);
      if (prior !== undefined && prior !== event.toolCallId) {
        jobOwners.set(h.job, null);
        const active = calls.get(state.activeCalls[0]);
        if (current(r) || (current(active) && active.receipt?.job === h.job)) return hold();
      } else jobOwners.set(h.job, event.toolCallId);
    }
    if (!current(r)) return;
    if (!event.isError && !ownedContract(event.input, r)) return hold();
    if (!event.isError && d?.results?.length === 0 && h && d.progress[0].agent === r.agent) {
      if (r.receipt && !isDeepStrictEqual(r.receipt, h)) return hold();
      if (!r.receipt) {
        save(transition(state, { type: 'native_pending', toolCallId: r.call, nativeId: h.child }));
        r.receipt = h;
      }
      join(r); return;
    }
    const result = d?.results?.length === 1 ? d.results[0] : null;
    const data = strict(result?.structuredOutput);
    save(transition(state, { type: 'task_result', toolCallId: r.call, nativeId: result?.id,
      serving: result && servingReceipt(result), text: data ? JSON.stringify(data) : undefined, aborted: result?.aborted,
      error: event.isError || !result || !servingWorker(result) || !!result.error || result.exitCode !== 0 || result.agent !== r.agent }));
  });
  // The shared extension bus is not a source of worker results or native handles.
  pi.events.on('task:subagent:lifecycle', payload => {
    if (root && Object.values(state.attempts).some(a => a.rejection?.toolCallId === payload.parentToolCallId))
      save(transition(state, { type: 'pre_spawn_conflict', toolCallId: payload.parentToolCallId }));
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!rootContext(ctx)) return;
    root = ctx.sessionManager.getSessionId();
    author = undefined;
    taskField = undefined; boundTask = undefined; projectedAttempt = undefined;
    calls.clear(); seenCalls.clear(); jobOwners.clear(); appendUncertain=false; held=undefined; state=createState();
    const branch=ctx.sessionManager.getBranch();
    const saved = branch.filter(e => e.type==='custom' && e.customType===entryType).at(-1);
    freshPrompt = !saved && !branch.some(e=>e.type==='message');
    if (!saved) return;
    freshPrompt = false;
    try {
      if (saved.data?.ownerSession !== root || saved.data?.version !== 3) throw Error('LEGACY_OR_FOREIGN_CHECKPOINT_HOLD');
      for (const id of Object.keys(saved.data.invocations ?? {})) seenCalls.add(id);
      const restored=transition(saved.data,{type:'restore'});
      assertSource(ctx); save(restored);
    } catch(error) { held = error.message; ctx.ui?.notify?.(held,'warning'); }
  });
  const start = async ctx => {
    author = undefined;
    freshPrompt = false;
    calls.clear();
    let profile;
    try { profile=await loadBindings(ctx); if (!profile) return false; assertSource(ctx); requireNative('task'); }
    catch(error) { ctx.ui?.notify?.(`Routing HOLD: ${error.message}`, 'warning'); throw error; }
    const original = { provider:ctx.model.provider, id:ctx.model.id, effort:pi.getThinkingLevel() };
    try { save(transition(state,{type:'start',original,profile,sessionId:root})); await apply(ctx); return true; }
    catch(error) { if (state.phase!=='idle') await pause(ctx); throw error; }
  };
  pi.on('input', async (event, ctx) => {
    if (!owns(ctx)) return;
    if (event.source === 'extension') { freshPrompt = false; return; }
    // RPC emits input before stock slash-command dispatch. Only pass our exact command names.
    if (/^\/(?:routing(?:-doctor|-setup)?)(?: |$)/.test(event.text)) return;
    if (held) return { handled: true };
    if (!['idle', 'done'].includes(state.phase)) {
      pi.appendEntry(`${entryType}-deferred-input`, { text: event.text, images: event.images, source: event.source, phase: state.phase, generation: state.generation });
      ctx.ui?.notify?.('Routing active. New request recorded but not executed; cancel or finish routing, then resubmit.', 'warning');
      return { handled: true };
    }
    try { await start(ctx); } catch { return { handled: true }; }
  });
pi.on('before_agent_start', async (event, ctx) => {
    if (!owns(ctx) || held) return;
    // ponytail: native 18.20.2 has prompt/reason, no source/message identity; restored print needs explicit input until native exposes provenance.
    if (state.phase === 'idle' || state.phase === 'done') {
      if (!freshPrompt || event.reason !== 'prompt' || typeof event.prompt !== 'string' || !event.prompt.trim() || /^Continue routing phase \w+\.$/.test(event.prompt.trim())) return;
       if (!await start(ctx)) return;
    }
    if (state.phase === 'paused') return { message: { customType: `${entryType}-paused-instruction`, display: false, content: `Routing paused: ${state.pauseReason || 'unknown'}. Approval state: ${state.approved}. Do not dispatch workers, execute plan work directly, or claim missing approval. Reconcile checkpoint with actual completed work first; request explicit resume only after reconciliation. Do not replay tasks or auto-resume production work.` } };
    if (!phaseModel(state)) return;
    // nextTurn delivery can bypass this hook; acknowledge only from native messages.
    const context = JSON.stringify({ master: state.master, tasks: state.tasks, repairPending: state.repairPending, plan: state.plan });
    const content = state.phase === 'execution' ? `Executor executes ready tasks sequentially. ${dispatchInstruction} Never replay completed tasks. Context: ${context}`
      : state.phase === 'localrepair' ? `Planner repairs ONLY blocked task ${state.repairPending}. Submit routing_submit_task_repair with next revision, unique repairId, concrete steps, new major decisions. Preserve master, assignments and successful tasks. Context: ${context}`
      : state.phase === 'localexec' ? `Executor calls routing_continue_repair then executes only repaired task. Context: ${context}`
      : state.phase === 'coordination' ? `Planner coordination: use executor results already present in the conversation as evidence; do not require executor tools or repeat completed work. Verify authorized scope, required evidence and standing constraints. Standing constraints belong in checks; decisions contains only unresolved choices requiring user approval now, otherwise []. For inspection/report-only scope, finish when required evidence is sufficient even if production remains blocked; report that limitation without claiming deployment or repair. Never call routing_finish while required evidence is missing; report exactly what is missing. Do not submit a new plan when user forbids it. Preserve the existing master and successful tasks; do not rewrite the master to address missing evidence. Report missing work without claiming completion. Call routing_finish only when authorized scope is complete and supported by evidence. Context: ${context}`
      : `Planner ${state.phase}: ${state.plan ? 'Verify completed master; call routing_finish. Do not rewrite master.' : 'Submit routing_submit_plan with concrete ordered tasks and assignee worker and the single configured agent. User standing authorization: proceed automatically with routine work and scoped fixes requested in chat. Set decisions to [] when no unresolved major decision remains; do not ask generic plan approval or add routine execution/standing constraints to decisions. Put constraints in checks. Decisions must include unresolved major architecture/scope choices, destructive operations, migrations, production deployment, or material spending requiring specific human authorization. Never treat Planner model rank as human authorization. Preserve all tool approval and safety guards.'} Available: ${JSON.stringify({agent:state.profile.workerAgent,assignee:"worker"})}. Context: ${context}`;
    return { message: { customType: `${entryType}-instruction`, display: false, content } };
  });
  const text = T.String({ minLength: 1, maxLength: 4000 });
  const planner = ctx => roleGuard(ctx,'planner');
  const executor = ctx => roleGuard(ctx,'executor');
  const receipt = message => ({ content: [{ type: 'text', text: message }], details: {} });
  pi.registerTool({ sourcePath: entryPath, name: 'routing_dispatch', label: 'Bind logical task', approval: 'read', loadMode: 'essential', defaultInactive: true,
    description: dispatchInstruction,
    parameters: T.Object({ taskId: text }, { additionalProperties: false }),
    async execute(id, args, _signal, _update, ctx) {
      executor(ctx); authored('executor',id,'routing_dispatch'); const task = state.tasks[args.taskId], attemptId = `${state.generation}:${id}`;
      if (!taskField) throw Error('ROUTING_NATIVE_TASK_SCHEMA_UNAVAILABLE');
      save(transition(state, { type: 'dispatch', ...auth(ctx), taskId: args.taskId, agent: task?.agent, attemptId }));
      const steps = [task.step, ...task.repair.steps];
      const nativeTaskCall = { name: 'task', arguments: {
        context: JSON.stringify({ goal: state.plan.goal, taskId: task.id, attemptId, checks: task.checks }),
        tasks: [{ agent: task.agent, [taskField]: taskField === 'steps' ? steps : steps.join('\n'),
          solutionSpace: 'Perform only the bound task and its checks.' }],
      } };
      boundTask = { id:attemptId, field:taskField, args:nativeTaskCall.arguments };
      projectedAttempt = undefined;
      return receipt(JSON.stringify({ taskId: task.id, attemptId, agent: task.agent, step: task.step,
        repair: task.repair.steps, checks: task.checks, resultContract, nativeTaskCall }));
    },
  });
  pi.registerTool({ sourcePath: entryPath, name: 'routing_submit_task_repair', label: 'Plan task repair', approval: 'read', loadMode: 'essential', defaultInactive: true,
    description: 'Planner changes only blocked task repair steps; master objective, assignments and completed results remain immutable. At most two rounds. New major decisions require user approval of exact revision.',
    parameters: T.Object({ taskId: text, masterId: text, revision: T.Integer({ minimum: 1 }), repairId: text, steps: T.Array(text, { minItems: 1, maxItems: 30 }), decisions: T.Array(text) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      planner(ctx); authored('planner',_id,'routing_submit_task_repair'); save(transition(state, { ...args, type: 'submit_task_repair', ...auth(ctx) }));
      return receipt(state.phase === 'awaitapproval' ? `Approval required: /routing approve-repair ${args.taskId} ${args.revision}` : 'Repair persisted; finish response for safe handoff.');
    },
  });
  pi.registerTool({ sourcePath: entryPath, name: 'routing_continue_repair', label: 'Continue approved repair', approval: 'read', loadMode: 'essential', defaultInactive: true,
    description: 'Executor resumes blocked logical task with approved local repair; never replay completed tasks.', parameters: T.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) {
      executor(ctx); authored('executor',_id,'routing_continue_repair'); save(transition(state, { type: 'continue_repair', ...auth(ctx) })); await apply(ctx); return receipt('Local task ready; bind with routing_dispatch.');
    },
  });
  pi.registerTool({ sourcePath: entryPath, name: 'routing_submit_plan', label: 'Submit routing plan', approval: 'read', loadMode: 'essential', defaultInactive: true,
    description: 'Persist ordered execution tasks, assignee, checks, and major decisions requiring explicit user approval.',
    parameters: T.Object({ goal: text, tasks: T.Array(T.Object({
      step: text, agent: T.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }), assignee: T.Literal('worker'), checks: T.Array(text, { minItems: 1 }),
      dependsOn: T.Optional(T.Array(T.String({ pattern: '^task-[1-9][0-9]*$', maxLength: 80 }), { description: 'IDs of earlier prerequisite tasks. IDs are assigned by array order starting at task-1. Omit or use [] for none.' })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }), decisions: T.Array(text) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      planner(ctx); authored('planner',_id,'routing_submit_plan');
       const plan = validatePlan(args,true);
       save(transition(state,{type:'submit_plan', ...auth(ctx), plan}));
       return receipt('Plan persisted. Finish planner response before handoff.');
    },
  });
  pi.registerTool({ sourcePath: entryPath, name: 'routing_finish', label: 'Finish routing', approval: 'read', loadMode: 'essential', defaultInactive: true,
    description: 'Mark coordinated work complete after checking execution results.', parameters: T.Object({ summary: text }, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) {
      planner(ctx); authored('planner',_id,'routing_finish'); save(transition(state, { type: 'finish', ...auth(ctx), generation: state.generation }));
      return { content: [{ type: 'text', text: 'Completion persisted.' }], details: {} };
    },
  });
  pi.on('agent_end', async (event, ctx) => {
    if (!owns(ctx) || busy || event.willContinue || event.awaitingAsyncWork) return;
    if (state.activeCalls.length) return;
    const messages = event.messages || [];
    const last = messages.filter(message => message.role === 'assistant').at(-1);
    const terminalPhase = ['localexec', 'awaitapproval'].includes(state.phase) ? 'localrepair' : state.phase;
    const expected = phaseModel({ ...state, phase: terminalPhase });
    if (!last || !expected || last.provider !== expected.provider || last.model !== expected.id) return;
    const id = `${last.timestamp}:${last.provider}:${last.model}`;
    if (!Number.isFinite(last.timestamp) || state.completions?.includes(id) || id === state.lastCompletion) return;
    if (state.pending) {
      const marker = messages.slice(0, messages.indexOf(last)).filter(message => message.role === 'custom' && message.customType === entryType).at(-1);
      if (!marker || marker.details?.token !== state.pending || marker.details?.generation !== state.generation || marker.details?.phase !== terminalPhase) return;
    }
    busy = true;
    try {
      if (event.aborted || event.error || last.aborted || last.error || last.errorMessage || ['aborted', 'error'].includes(last.stopReason)) { await pause(ctx); return; }
      if (last.stopReason !== 'stop') return;
      if (state.pending) save(transition(state, { type: 'continuation_consumed', generation: state.generation, token: state.pending, phase: state.phase, source: 'custom', customType: entryType }));
      const beforeBoundary = state.phase;
      save(transition(state, { type: 'agent_end' }));
      if (state.phase === 'paused') { await restore(ctx); return; }
      if (state.phase !== beforeBoundary || state.phase === 'localexec') { await queue(ctx); return; }
      if (state.phase === 'awaitapproval') { ctx.ui?.notify?.(`Approve revision: /routing approve-repair ${state.repairPending} ${state.tasks[state.repairPending].repair.revision}`, 'warning'); return; }
      save(transition(state, { type: 'assistant_observed', generation: state.generation, provider: last.provider, model: last.model, stopReason: last.stopReason }));
      const next = transition(state, { type: 'completion', generation: state.generation, id, provider: last.provider, model: last.model });
      if (next.phase === state.phase) return;
      save(next);
      if (state.pending) await queue(ctx);
      else if (state.phase === 'done') await restore(ctx);
      else if (state.phase === 'awaiting_approval') ctx.ui?.notify?.(`Major decisions require /routing approve: ${JSON.stringify(state.plan.decisions)}`, 'warning');
    } catch (error) { await pause(ctx); ctx.ui?.notify?.(String(error), 'error'); }
    finally { busy = false; }
  });
  return { assertSource, canEdit:ctx => owns(ctx) && !held && !appendUncertain && ['idle','done'].includes(state.phase) && !busy };
}
