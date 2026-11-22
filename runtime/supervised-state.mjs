import { checkRecord } from '../store.mjs';
import manifest from '../package.json' with {type:'json'};
const matches = (role, e) => role && e.provider === role.provider && e.model === role.id;
const served = (s, value) => value?.identity === `${s.profile.roles.worker.provider}/${s.profile.roles.worker.id}` && (value.effort === null || typeof value.effort === 'string') && (!s.profile.roles.worker.effort || s.profile.roles.worker.effort === value.effort);
function validProfile(p) { try { checkRecord(p); return true; } catch { return false; } }
export function validatePlan(plan, requireAgent = false) {
  if (!plan || Object.keys(plan).some(k => !['goal', 'tasks', 'decisions'].includes(k)) || typeof plan.goal !== 'string' || !plan.goal.trim() || plan.goal.length > 4000 || !Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > 30 || !Array.isArray(plan.decisions) || plan.decisions.some(x => typeof x !== 'string' || !x.trim() || x.length > 4000)) throw Error('INVALID_ROUTING_PLAN');
  const ids = plan.tasks.map((t, i) => t?.id ?? `task-${i + 1}`);
  if (new Set(ids).size !== ids.length) throw Error('INVALID_TASK_IDS');
  const tasks = plan.tasks.map((t, i) => {
    if (!t || Object.keys(t).some(k => !['id', 'step', 'assignee', 'checks', 'agent', 'dependsOn'].includes(k)) || !/^[a-zA-Z0-9_-]{1,80}$/.test(ids[i]) || typeof t.step !== 'string' || !t.step.trim() || t.step.length > 4000 || t.assignee !== 'worker' || !Array.isArray(t.checks) || !t.checks.length || t.checks.some(c => typeof c !== 'string' || !c.trim() || c.length > 4000) || ((requireAgent || t.agent !== undefined) && (typeof t.agent !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(t.agent))) || (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.some(id => !ids.slice(0, i).includes(id))))) throw Error('INVALID_ROUTING_TASK');
    return { ...structuredClone(t), id: ids[i], dependsOn: t.dependsOn || [] };
  });
  return { ...structuredClone(plan), tasks };
}
export function createState() {
  return { version: 3, packageVersion: manifest.version, minimumReaderVersion: 3, profile: null, ownerSession: null, phase: 'idle', generation: 0, plan: null, master: null, tasks: {}, attempts: {}, invocations: {}, activeCalls: [], currentTask: null, mode: 'normal', plannerObserved: false, pending: null, lastCompletion: null, original: null, approved: false, finished: false, diagnostics: [] };
}
const fail = message => { throw Error(message); };
const root = (s, e, role) => { const m = s.profile?.roles[role]; if (e.root !== true || !s.ownerSession || e.sessionId !== s.ownerSession || !m || e.provider !== m.provider || e.model !== m.id) fail('ROOT_ROLE_REQUIRED'); };
const idle = s => { if (s.activeCalls.length) fail('NATIVE_TASK_ACTIVE'); };
const pause = (s, reason) => { if (s.phase !== 'paused') s.resumePhase = s.phase; s.phase = 'paused'; s.pending = null; s.pauseReason = reason; return s; };
export function parseChildResult(text) {
  if (typeof text !== 'string' || text.length > 16000) fail('INVALID_CHILD_RESULT');
  let r;
  try { r = JSON.parse(text); } catch { fail('INVALID_CHILD_RESULT'); }
  if (!r || Array.isArray(r) || Object.keys(r).some(k => !['taskId', 'attemptId', 'status', 'kind', 'evidence', 'scope', 'missing'].includes(k)) || typeof r.taskId !== 'string' || typeof r.attemptId !== 'string' || !['completed', 'blocked'].includes(r.status) || typeof r.evidence !== 'string' || r.evidence.length > 8000 || (r.status === 'blocked' && (r.kind !== 'local_scope' || r.scope !== r.taskId || typeof r.missing !== 'string' || !r.missing.trim() || r.missing.length > 4000)) || (r.status === 'completed' && ['kind', 'scope', 'missing'].some(k => k in r))) fail('INVALID_CHILD_RESULT');
  return r;
}
function validateCheckpoint(s) {
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  const check = ok => { if (!ok) fail('INVALID_ROUTING_STATE'); };
  check(s.version === 3 && s.minimumReaderVersion === 3 && s.packageVersion === manifest.version);
  check(s.profile === null ? s.phase === 'idle' : validProfile(s.profile) && typeof s.ownerSession === 'string' && !!s.ownerSession);
  check(integer(s.generation) && ['idle', 'planning', 'execution', 'coordination', 'awaiting_approval', 'localrepair', 'awaitapproval', 'localexec', 'paused', 'done'].includes(s.phase));
  check(['normal', 'local'].includes(s.mode) && typeof s.approved === 'boolean');
  check(object(s.tasks) && object(s.attempts) && object(s.invocations) && Array.isArray(s.activeCalls));
  check(s.activeCalls.length <= 1 && new Set(s.activeCalls).size === s.activeCalls.length);
  check(!s.legacy && typeof s.plannerObserved === 'boolean');
  if (s.original !== null) check(object(s.original) && typeof s.original.provider === 'string' && !!s.original.provider && typeof s.original.id === 'string' && !!s.original.id && !Object.keys(s.original).some(k => !['provider','id','effort'].includes(k)));
  const phase = s.phase === 'paused' ? s.resumePhase : s.phase;
  check(typeof s.finished === 'boolean' && (!s.finished || ['coordination', 'done'].includes(phase)) && (phase !== 'done' || s.finished));
  const completions = s.completions === undefined ? [] : s.completions;
  check(Array.isArray(completions) && completions.every(id => typeof id === 'string' && !!id) && new Set(completions).size === completions.length);
  check(s.lastCompletion === (completions.at(-1) ?? null) && (phase !== 'done' || completions.length > 0));
  if (s.plan === null) {
    check(!s.finished && completions.length === 0);
    check(['idle', 'planning'].includes(phase) && s.master === null && !Object.keys(s.tasks).length && !Object.keys(s.attempts).length && !Object.keys(s.invocations).length && !s.activeCalls.length && s.currentTask === null && !s.repairPending);
    return;
  }
  const plan = validatePlan(s.plan, true);
  check(plan.tasks.every(t => t.agent === s.profile.workerAgent));
  check(object(s.master) && typeof s.master.id === 'string' && !!s.master.id && integer(s.master.revision) && s.master.revision > 0 && s.master.objective === plan.goal);
  check(Object.keys(s.tasks).length === plan.tasks.length);
  for (const p of plan.tasks) {
    const t = s.tasks[p.id];
    check(object(t) && ['id', 'step', 'assignee', 'agent'].every(k => t[k] === p[k]) && JSON.stringify(t.checks) === JSON.stringify(p.checks) && JSON.stringify(t.dependsOn) === JSON.stringify(p.dependsOn));
    check(['pending', 'running', 'completed', 'blocked'].includes(t.status) && integer(t.generation) && object(t.repair));
    const r = t.repair;
    check(integer(r.revision) && integer(r.count) && r.count <= 2 && r.count === r.revision && t.generation === r.revision && Array.isArray(r.steps));
    check(r.approvedRevision === null || (integer(r.approvedRevision) && r.approvedRevision === r.revision));
    if (r.revision) check(typeof r.id === 'string' && !!r.id && r.steps.length > 0 && r.steps.every(x => typeof x === 'string' && !!x.trim()) && Array.isArray(r.decisions) && r.decisions.every(x => typeof x === 'string'));
    else check(r.steps.length === 0 && r.approvedRevision === null);
    if (r.revision) check(r.approvedRevision === r.revision || (r.decisions.length > 0 && t.status === 'blocked' && s.repairPending === t.id && phase === 'awaitapproval'));
    const attempts = Object.values(s.attempts).filter(a => a?.taskId === t.id);
    if (t.status === 'running') check(s.currentTask === t.id && attempts.some(a => a.generation === t.generation && ['intent', 'active', 'unresolved', 'error', 'cancelled'].includes(a.status)));
    if (['completed', 'blocked'].includes(t.status)) check(attempts.some(a => a.status === t.status && a.result?.evidence === t.evidence && (t.status === 'blocked' || a.generation === t.generation)));
  }
  check(s.currentTask === null || s.tasks[s.currentTask]?.status === 'running');
  for (const [id, a] of Object.entries(s.attempts)) {
    const t = s.tasks[a?.taskId];
    check(object(a) && a.id === id && !!t && a.agent === t.agent && integer(a.generation) && a.generation <= t.generation && ['intent', 'not_spawned', 'active', 'unresolved', 'error', 'cancelled', 'completed', 'blocked'].includes(a.status));
    check(['intent', 'not_spawned'].includes(a.status) ? a.invocationId === null : typeof a.invocationId === 'string' && s.invocations[a.invocationId]?.attemptId === id);
    if (a.rejection) check(object(a.rejection) && a.rejection.attemptId === id && a.rejection.taskId === a.taskId && integer(a.rejection.generation) && typeof a.rejection.toolCallId === 'string' && !!a.rejection.toolCallId && typeof a.rejection.reason === 'string' && !!a.rejection.reason && typeof a.rejection.conflict === 'boolean');
    if (a.status === 'not_spawned') check(!!a.rejection && !a.nativeId);
    check(s.activeCalls.includes(a.invocationId) === (a.status === 'active'));
    if (['completed', 'blocked'].includes(a.status)) {
      const r = parseChildResult(JSON.stringify(a.result));
      check(r.taskId === a.taskId && r.attemptId === id && r.status === a.status && typeof a.nativeId === 'string' && !!a.nativeId);
      check(served(s,a.serving));
    }
  }
  for (const [id, v] of Object.entries(s.invocations)) check(object(v) && s.attempts[v.attemptId]?.invocationId === id && s.attempts[v.attemptId]?.taskId === v.taskId);
  for (const id of s.activeCalls) check(typeof id === 'string' && s.attempts[s.invocations[id]?.attemptId]?.status === 'active');
  check(s.activeCalls.length <= 1);
  for (const t of Object.values(s.tasks)) if (t.repair.revision > 0 && t.status !== 'blocked') check(t.repair.approvedRevision === t.repair.revision);
  check(typeof s.finished === 'boolean' && (phase !== 'done' || s.finished));
  if (s.completions !== undefined) check(Array.isArray(s.completions) && s.completions.every(id => typeof id === 'string' && id.length > 0) && new Set(s.completions).size === s.completions.length);
  check(s.lastCompletion === ((s.completions || []).at(-1) ?? null));
  if (s.repairPending) check(s.tasks[s.repairPending]?.status === 'blocked');
  if (['localrepair', 'awaitapproval', 'localexec'].includes(phase)) check(!!s.repairPending && s.mode === 'local');
  if (phase === 'localexec') check(s.tasks[s.repairPending].repair.approvedRevision === s.tasks[s.repairPending].repair.revision && s.tasks[s.repairPending].repair.revision > 0);
  if (phase === 'awaitapproval') check(s.tasks[s.repairPending].repair.revision > 0 && s.tasks[s.repairPending].repair.approvedRevision === null);
  if (['coordination', 'done'].includes(phase)) check(Object.values(s.tasks).every(t => t.status === 'completed'));
  if (plan.decisions.length && (Object.keys(s.attempts).length || ['execution', 'coordination', 'done', 'localrepair', 'awaitapproval', 'localexec'].includes(phase))) check(s.approved);
}
export function transition(current, e) {
  if (['restore', 'resume'].includes(e.type)) {
    if (current?.version !== 3) fail('LEGACY_ROUTING_STATE_REQUIRES_PRIOR_READER');
    validateCheckpoint(current);
    const s = structuredClone(current);
    s.resumePhase = current.resumePhase || current.phase;
    s.generation++;
    return pause(s, 'restore-unresolved');
  }
  if (current?.version !== 3) fail('INVALID_ROUTING_STATE');
  if (['user_resume', 'dispatch', 'task_call', 'continue_repair', 'pre_spawn_rejected', 'reconcile_pre_spawn'].includes(e.type)) validateCheckpoint(current);
  const s = structuredClone(current);
  if (e.type === 'user_resume') {
    idle(s);
    if (e.authorized !== true || s.phase !== 'paused' || s.finished || Object.values(s.tasks).some(t => t.status === 'running') || Object.values(s.attempts).some(a => a.rejection?.conflict || (a.status === 'not_spawned' && a.rejection.generation !== s.generation) || ['intent', 'active', 'unresolved', 'error', 'cancelled'].includes(a.status))) fail('UNRESOLVED_CHECKPOINT');
    const t = s.tasks[s.repairPending];
    const repairPhase = t?.repair.revision > 0 && t.repair.approvedRevision !== t.repair.revision ? 'awaitapproval' : t?.repair.revision > 0 && ['awaitapproval', 'localexec'].includes(current.resumePhase) ? 'localexec' : 'localrepair';
    s.phase = s.repairPending ? repairPhase : !s.plan ? 'planning' : Object.values(s.tasks).every(t => t.status === 'completed') ? 'coordination' : s.plan.decisions.length && !s.approved ? 'awaiting_approval' : 'execution';
    s.mode = s.repairPending ? 'local' : 'normal'; s.pending = null; return s;
  }
  if (e.type === 'pre_spawn_rejected') {
    root(s, e, 'executor'); idle(s);
    const a = s.attempts[e.attemptId];
    if (s.phase !== 'execution' || e.generation !== s.generation || !a || a.status !== 'intent' || a.rejection || a.invocationId !== null || a.nativeId || a.taskId !== s.currentTask || a.taskId !== e.taskId || typeof e.toolCallId !== 'string' || !e.toolCallId || s.invocations[e.toolCallId] || typeof e.reason !== 'string' || !e.reason) fail('INVALID_RECONCILIATION_EVIDENCE');
    a.rejection = { attemptId: a.id, taskId: a.taskId, generation: s.generation, toolCallId: e.toolCallId, reason: e.reason, conflict: false };
    return pause(s, 'pre-spawn-rejected');
  }
  if (e.type === 'pre_spawn_conflict') {
    const matches = Object.values(s.attempts).filter(a => a.rejection?.toolCallId === e.toolCallId);
    if (!matches.length) return s;
    for (const a of matches) a.rejection.conflict = true;
    return pause(s, 'pre-spawn-conflict');
  }
  if (e.type === 'reconcile_pre_spawn') {
    idle(s);
    const a = s.attempts[e.attemptId], r = a?.rejection, t = a && s.tasks[a.taskId];
    if (e.authorized !== true || s.phase !== 'paused' || s.legacy || !a || !r || r.conflict || r.generation !== s.generation || a.generation !== t.generation || a.invocationId !== null || a.nativeId || Object.values(s.invocations).some(v => v.attemptId === a.id) || s.invocations[r.toolCallId] || !['intent', 'not_spawned'].includes(a.status)) fail('UNSUPPORTED_OR_AMBIGUOUS_RECONCILIATION');
    if (a.status === 'not_spawned') return s;
    if (s.currentTask !== t.id || t.status !== 'running') fail('UNSUPPORTED_OR_AMBIGUOUS_RECONCILIATION');
    a.status = 'not_spawned'; t.status = 'pending'; s.currentTask = null;
    return s;
  }
  if (e.type === 'cancel' || e.type === 'error') return pause(s, e.type);
  if (e.type === 'start') {
    idle(s);
    if (!['idle', 'done'].includes(s.phase)) fail('START_OUTSIDE_IDLE');
    if (!validProfile(e.profile) || typeof e.sessionId !== 'string' || !e.sessionId) fail('INVALID_BINDING_SNAPSHOT');
    return { ...createState(), generation: s.generation + 1, phase: 'planning', original: e.original, profile: structuredClone(e.profile), ownerSession: e.sessionId };
  }
  if (e.type === 'submit_plan') {
    idle(s);
    root(s, e, 'planner');
    if (s.mode === 'local' || !['planning', 'coordination'].includes(s.phase) || Object.keys(s.attempts).length) fail('MASTER_REWRITE_FORBIDDEN');
    const p = validatePlan(e.plan);
    if (p.tasks.some(t => t.agent !== s.profile.workerAgent)) fail('ROUTING_AGENT_UNPLANNED');
    s.plan = p; s.approved = false;
    s.master = { id: `master-${s.generation}`, revision: (s.master?.revision || 0) + 1, objective: p.goal };
    s.tasks = Object.fromEntries(p.tasks.map(t => [t.id, { ...t, status: 'pending', generation: 0, repair: { steps: [], revision: 0, count: 0, approvedRevision: null } }]));
    return s;
  }
  if (e.type === 'dispatch') {
    root(s, e, 'executor'); idle(s);
    if (s.phase !== 'execution' || s.currentTask || (s.plan?.decisions.length && !s.approved)) fail('DISPATCH_NOT_ALLOWED');
    const t = Object.values(s.tasks).find(t => t.status === 'pending' && t.dependsOn.every(id => s.tasks[id].status === 'completed'));
    if (!t || t.id !== e.taskId || t.agent !== e.agent || typeof e.attemptId !== 'string' || !e.attemptId || s.attempts[e.attemptId]) fail('INVALID_DISPATCH');
    t.status = 'running'; s.currentTask = t.id;
    s.attempts[e.attemptId] = { id: e.attemptId, taskId: t.id, generation: t.generation, agent: t.agent, status: 'intent', invocationId: null };
    return s;
  }
  if (e.type === 'task_call') {
    root(s, e, 'executor'); idle(s);
    const a = s.attempts[e.attemptId];
    if (s.phase !== 'execution' || a?.rejection) fail('DISPATCH_NOT_ALLOWED');
    if (!a || a.status !== 'intent' || a.taskId !== s.currentTask || a.agent !== e.agent || e.taskId !== a.taskId || typeof e.toolCallId !== 'string' || !e.toolCallId || s.invocations[e.toolCallId]) fail('INVALID_NATIVE_CORRELATION');
    a.status = 'active'; a.invocationId = e.toolCallId;
    s.invocations[e.toolCallId] = { attemptId: a.id, taskId: a.taskId }; s.activeCalls.push(e.toolCallId);
    return s;
  }
  if (e.type === 'settlement_conflict') return pause(s, 'native-settlement-conflict');
  if (e.type === 'terminal_wait_unproven') return pause(s, 'native-wait-terminal-unproven');
  if (e.type === 'native_pending') {
    const mapping = s.invocations[e.toolCallId], a = mapping && s.attempts[mapping.attemptId];
    if (!a || a.status !== 'active' || typeof e.nativeId !== 'string' || !e.nativeId || (a.nativeId && a.nativeId !== e.nativeId)) fail('INVALID_NATIVE_CORRELATION');
    a.nativeId = e.nativeId; return s;
  }
  if (e.type === 'task_result') {
    const mapping = s.invocations[e.toolCallId], a = mapping && s.attempts[mapping.attemptId];
    if (a && ['completed', 'blocked'].includes(a.status) && a.nativeId === e.nativeId && !e.aborted && !e.error) {
      try {
        const result = parseChildResult(e.text);
        if (Object.keys(result).length === Object.keys(a.result).length && Object.keys(result).every(key => result[key] === a.result[key])) return s;
      } catch {}
    }
    if (!a || a.status !== 'active' || !s.activeCalls.includes(e.toolCallId)) { s.diagnostics.push('unknown-or-duplicate-result'); return pause(s, 'unresolved-result'); }
    if (a.nativeId && a.nativeId !== e.nativeId) return pause(s, 'native-id-mismatch');
    s.activeCalls = s.activeCalls.filter(id => id !== e.toolCallId);
    if (e.aborted || e.error) { a.status = e.aborted ? 'cancelled' : 'error'; return pause(s, e.approvalRefused ? 'native-approval-refused' : a.status); }
    let r;
    try { r = parseChildResult(e.text); } catch { a.status = 'unresolved'; return pause(s, 'invalid-child-result'); }
    const t = s.tasks[a.taskId];
    if (r.taskId !== a.taskId || r.attemptId !== a.id || a.generation !== t.generation || t.status === 'completed' || typeof e.nativeId !== 'string' || !e.nativeId) { a.status = 'unresolved'; return pause(s, 'unresolved-result'); }
    if (!served(s,e.serving)) return pause(s,'worker-model-unverified');
    a.serving = structuredClone(e.serving); a.nativeId = e.nativeId; a.status = r.status; a.result = r; t.status = r.status; t.evidence = r.evidence; s.currentTask = null;
    if (r.status === 'blocked') { t.blocker = r; s.repairPending = t.id; }
    return s;
  }
  if (e.type === 'agent_end') {
    idle(s);
    if (s.phase === 'paused') return s;
    if (s.repairPending && s.phase === 'execution') { s.mode = 'local'; s.phase = 'localrepair'; s.pending = `repair:${s.repairPending}`; }
    return s;
  }
  if (e.type === 'submit_task_repair') {
    root(s, e, 'planner'); idle(s);
    const t = s.tasks[e.taskId];
    if (s.phase !== 'localrepair' || s.repairPending !== e.taskId || !t || t.status !== 'blocked' || e.masterId !== s.master.id || e.revision !== t.repair.revision + 1 || typeof e.repairId !== 'string' || !e.repairId || !Array.isArray(e.steps) || !e.steps.length || e.steps.some(x => typeof x !== 'string' || !x.trim() || x.length > 4000) || !Array.isArray(e.decisions) || e.decisions.some(x => typeof x !== 'string' || !x.trim() || x.length > 4000)) fail('INVALID_LOCAL_REPAIR');
    if (t.repair.count >= 2 || JSON.stringify(t.repair.steps) === JSON.stringify(e.steps)) return pause(s, 'repair-budget-or-no-progress');
    t.repair = { id: e.repairId, steps: [...e.steps], decisions: [...e.decisions], revision: e.revision, count: t.repair.count + 1, approvedRevision: e.decisions.length ? null : e.revision };
    t.generation++;
    s.phase = e.decisions.length ? 'awaitapproval' : 'localexec';
    return s;
  }
  if (e.type === 'approve_repair') {
    idle(s); const t = s.tasks[e.taskId];
    if (e.authorized !== true || s.phase !== 'awaitapproval' || e.taskId !== s.repairPending || !t || e.revision !== t.repair.revision || e.masterId !== s.master.id) fail('INVALID_REPAIR_APPROVAL');
    t.repair.approvedRevision = e.revision; s.phase = 'localexec'; return s;
  }
  if (e.type === 'continue_repair') {
    root(s, e, 'executor'); idle(s); const t = s.tasks[s.repairPending];
    if (s.phase !== 'localexec' || !t || t.repair.approvedRevision !== t.repair.revision) fail('REPAIR_NOT_APPROVED');
    t.status = 'pending'; s.mode = 'normal'; s.phase = 'execution'; s.repairPending = null; s.pending = null; return s;
  }
  if (e.type === 'approve') {
    idle(s); if (e.authorized !== true || s.phase !== 'awaiting_approval') fail('APPROVAL_OUTSIDE_GATE');
    s.approved = true; s.phase = 'execution'; s.pending = `${s.generation}:approved`; return s;
  }
  if (e.type === 'finish') {
    root(s, e, 'planner');
    idle(s); if (s.finished || s.mode === 'local' || s.phase !== 'coordination' || Object.values(s.tasks).some(t => t.status !== 'completed')) fail('FINISH_OUTSIDE_COORDINATION');
    s.finished = true; return s;
  }
  if (e.type === 'assistant_observed') {
    if (['planning', 'coordination'].includes(s.phase) && matches(s.profile?.roles.planner, e) && !['error', 'aborted'].includes(e.stopReason)) s.plannerObserved = true;
    return s;
  }
  if (e.type === 'continuation_consumed') {
    if (s.pending && e.generation === s.generation && e.source === 'custom' && e.customType === 'routing-supervised-v1' && e.phase === s.phase && e.token === s.pending) s.pending = null;
    return s;
  }
  if (e.type === 'completion' && e.id !== undefined && e.id !== null && (typeof e.id !== 'string' || !e.id)) fail('INVALID_COMPLETION_ID');
  if (e.type !== 'completion' || s.phase === 'paused' || e.willContinue || e.awaitingAsyncWork || s.pending || !e.id || s.completions?.includes(e.id)) return s;
  idle(s);
  if (e.aborted || e.error) return pause(s, 'completion-error');
  if (['planning', 'coordination'].includes(s.phase)) {
    if (!s.plannerObserved || !s.plan) return s;
    s.phase = s.phase === 'coordination' && s.finished ? 'done' : s.plan.decisions.length && !s.approved ? 'awaiting_approval' : 'execution';
  } else if (s.phase === 'execution' && matches(s.profile?.roles.executor, e)) {
    if (Object.values(s.tasks).some(t => t.status !== 'completed')) return pause(s, 'incomplete-master');
    s.phase = 'coordination'; s.plannerObserved = false;
  } else return s;
  s.lastCompletion = e.id; s.completions = [...(s.completions || []), e.id];
  if (['execution', 'coordination'].includes(s.phase)) s.pending = `${s.generation}:${e.id}:${s.phase}`;
  return s;
}
export function phaseRole(s) {
  if (s.activeCalls.length) return null;
  if (['execution','localexec'].includes(s.phase)) return 'executor';
  if (['planning','coordination','localrepair'].includes(s.phase)) return 'planner';
  return null;
}
export const phaseModel = s => s.profile?.roles[phaseRole(s)];
