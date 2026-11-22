import path from 'node:path';
import { VERSION as STOCK_VERSION } from '@oh-my-pi/pi-utils';
import { findScopedSettings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery';
import { perCallModelEnabled } from '@oh-my-pi/pi-coding-agent/task/settings';
import { assertPerCallModelApproved } from '@oh-my-pi/pi-coding-agent/task/model-approval';
import { discoverExtensionPaths } from '@oh-my-pi/pi-coding-agent/extensibility/extensions';
import { roles, choices, eligible, validateCatalog, validAgent, configPath, readBindings, saveBindings } from './store.mjs';
const stop = code => { throw new Error(code); };
export function assertRuntime() {
  if (!Bun.semver.satisfies(STOCK_VERSION, '>=19.0.1')) stop('UNSUPPORTED_OMP_VERSION: requires stable OMP >=19.0.1');
}
function scoped(ctx) {
  assertRuntime();
  const s=findScopedSettings(ctx.cwd); if(!s || path.resolve(s.getCwd())!==path.resolve(ctx.cwd) || !path.isAbsolute(s.getAgentDir())) stop('ACTIVE_PROFILE_UNVERIFIED'); return s;
}
function value(s,id) { const h=lookup(id); if(!h)stop('STOCK_SETTING_UNAVAILABLE: '+id); return h.get(s); }
export async function workerDescriptors(ctx) {
  const s=scoped(ctx),disabled=value(s,'task.disabledAgents');
  const {agents}=await discoverAgents(ctx.cwd);
  return agents.filter(a=>validAgent(a.name) && !disabled.includes(a.name));
}
function selected(ctx,b) { return ctx.models.list().find(m=>m.provider===b.provider && m.id===b.id); }
async function assertDiscovery(ctx,s) {
  const discovered=await discoverExtensionPaths(value(s,'extensions'),ctx.cwd,value(s,'disabledExtensions'));
  if(discovered.some(p=>/^runtime-routing\.[cm]?[jt]s$/i.test(path.basename(p)))) stop('LEGACY_ROUTING_SOURCE_CONFLICT');
}
export async function preflight(ctx,cfg) {
  const s=scoped(ctx); validateCatalog(ctx,cfg); await assertDiscovery(ctx,s);
  const descriptors=(await workerDescriptors(ctx)).filter(a=>a.name===cfg.workerAgent);
  if(descriptors.length!==1) stop('WORKER_DESCRIPTOR_UNAVAILABLE_OR_AMBIGUOUS');
  if(!perCallModelEnabled(s,'task')) stop('STOCK_TASK_PER_CALL_MODEL_NOT_ENABLED');
  if(Object.hasOwn(value(s,'task.agentModelOverrides'), cfg.workerAgent)) stop('STOCK_AGENT_MODEL_OVERRIDE_CONFLICT');
  const d=descriptors[0], ex=selected(ctx,cfg.roles.executor), worker=selected(ctx,cfg.roles.worker);
  try { assertPerCallModelApproved(worker, { settings:s, agentName:d.name,agentModel:d.model,agentSource:d.source,parentModelPattern:`${ex.provider}/${ex.id}` },ctx.modelRegistry); } catch { stop('WORKER_MODEL_NOT_APPROVED_BY_STOCK'); }
  const chains=value(s,'retry.fallbackChains');
  if(value(s,'retry.modelFallback') && Object.values(chains).some(x=>Array.isArray(x)&&x.length)) stop('STOCK_RETRY_MODEL_FALLBACK_CONFIGURED');
  for(const role of roles) { const m=selected(ctx,cfg.roles[role]);
    if(value(s,'contextPromotion.enabled') && m.contextPromotionTarget) stop('STOCK_CONTEXT_PROMOTION_CONFIGURED');
    if(value(s,'compaction.enabled') && m.compactionModel) stop('STOCK_ALTERNATE_COMPACTION_MODEL_CONFIGURED');
  }
  return cfg;
}
export async function loadBindings(ctx) {
  if(ctx.agent?.kind!=='main')stop('ROOT_SESSION_REQUIRED');
  const cfg=readBindings(scoped(ctx).getAgentDir());return cfg ? preflight(ctx,cfg) : null;
}
const cancel=Symbol('cancel');
const opts={timeout:120000};
async function pick(ctx,title,options){ if(!options.length)stop('NO_AVAILABLE_CHOICES');const a=await ctx.ui.select(title,options,opts);if(a===undefined)throw cancel;if(!options.includes(a))stop('UNRECOGNIZED_CHOICE');return a; }
function projection(m){return `${m.provider}/${m.id}`;}
function humanError(e){return e===cancel?'Đã hủy; không lưu.':String(e?.message||'SETUP_FAILED').replace(/[\r\n]/g,' ').slice(0,350);}
export function registerSettings(pi, canEdit, assertSource) {
  pi.registerCommand('routing-doctor',{description:'Kiểm tra profile, model và điều kiện routing; không gọi model',handler:async(_args,ctx)=>{
    try { if(ctx.agent?.kind!=='main')stop('ROOT_SESSION_REQUIRED');assertSource(ctx);const dir=scoped(ctx).getAgentDir(),file=configPath(dir),cfg=readBindings(dir);
      if(!cfg){await assertDiscovery(ctx,scoped(ctx));ctx.ui.notify(`Chưa cấu hình: ${file}. Không phát hiện bridge cũ trong discovery. Dùng /routing-setup. Không gọi model.`,'info');return;}
      const summary=roles.map(k=>`${k}: ${projection(cfg.roles[k])} [${cfg.roles[k].effort??'OMP chọn'}]`).join('; ');
      let status;try{await preflight(ctx,cfg);status='Đã thấy trong catalog; preflight policy đạt.';}catch(e){status='HOLD: '+humanError(e);}
      ctx.ui.notify(`Profile: ${dir} • revision ${cfg.revision} • ${summary} • agent ${cfg.workerAgent}. ${status} Model hiện tại: ${ctx.models.current()?projection(ctx.models.current()):'chưa chọn'}. Chưa xác minh thuê bao, chi phí hoặc lượt chạy.`,status.startsWith('HOLD')?'warning':'info');
    }catch(e){ctx.ui.notify(humanError(e),'error');}
  }});
  pi.registerCommand('routing-setup',{description:'Chọn model và worker cho profile này; không gọi model/không sửa quyền',handler:async(_args,ctx)=>{
    try {
      if(ctx.agent?.kind!=='main'||!ctx.hasUI||!ctx.isIdle()||canEdit(ctx)!==true)stop('SETUP_REQUIRES_IDLE_ROOT_AND_UI');
      assertSource(ctx);
      const dir=scoped(ctx).getAgentDir(),current=readBindings(dir),rev=current?.revision??0;
      const models=ctx.models.list().filter(eligible), by=new Map();
      for(const m of models){ const id=projection(m); by.set(id,by.has(id)?null:m); }
      const ids=[...by.keys()].filter(k=>by.get(k)).sort(); if(!ids.length)stop('NO_AVAILABLE_CHAT_MODELS');
      const shared='Dùng một model cho cả ba vai';const style=await pick(ctx,'Chọn cách cấu hình',[shared,'Chọn riêng cho từng vai']);
      const newRoles={};for(const k of (style===shared?['planner']:roles)) {
        const alias='Chọn từ vai OMP (@plan, @task, …)';let id=await pick(ctx,`Model cho ${style===shared?'cả ba vai':k}`,[...ids,alias]);
        if(id===alias){const a=await ctx.ui.input('Vai OMP để tham khảo','@plan',opts);if(a===undefined)throw cancel;if(!/^@[a-zA-Z][\w-]{0,63}$/.test(a))stop('INVALID_NATIVE_ROLE');const m=ctx.models.resolve(a);if(!m||!by.get(projection(m)))stop('NATIVE_ROLE_HAS_NO_ELIGIBLE_MATCH');id=await pick(ctx,`Chọn rõ model cho ${a} (không kế thừa fallback hay effort)`,[projection(m)]);}
        const m=by.get(id);const auto='Để OMP chọn',ef=await pick(ctx,`Mức suy luận — ${id}`,[auto,...choices(m)]);newRoles[k]={provider:m.provider,id:m.id,...(ef===auto?{}:{effort:ef})};
      }
      if(style===shared){newRoles.executor={...newRoles.planner};newRoles.worker={...newRoles.planner};}
      const desc=await workerDescriptors(ctx);const names=desc.map(a=>a.name).filter((n,i,arr)=>arr.indexOf(n)===i&&arr.lastIndexOf(n)===i).sort();if(!names.length)stop('NO_WORKER_DESCRIPTOR');
      const workerAgent=await pick(ctx,'Chọn agent cho nhiệm vụ con (không cấp quyền)',names);
      const summary=roles.map(k=>`${k} → ${projection(newRoles[k])} (${newRoles[k].effort??'OMP chọn'})`).join('\n');
      if(await ctx.ui.confirm('Lưu lựa chọn routing?',`${dir}\n${summary}\nWorker: ${workerAgent}\nRevision ${rev} → ${rev+1}. Không gọi model hoặc thêm grant.`,opts)!==true)throw cancel;
      if(!ctx.isIdle()||canEdit(ctx)!==true||scoped(ctx).getAgentDir()!==dir)stop('SESSION_CHANGED_BEFORE_SAVE');
      assertSource(ctx);
      if(!(await workerDescriptors(ctx)).some(a=>a.name===workerAgent))stop('WORKER_DESCRIPTOR_CHANGED');
      const draft={roles:newRoles,workerAgent};validateCatalog(ctx,{...draft,schemaVersion:1,revision:rev+1});
      const result=saveBindings(dir,draft,rev);ctx.ui.notify(`Đã lưu revision ${result.revision}. Chạy /routing-doctor; chưa xác minh inference/quyền. Dùng phiên mới cho cấu hình này.`,'info');
    }catch(e){ctx.ui.notify(humanError(e),e===cancel?'info':'error');}
  }});
}
