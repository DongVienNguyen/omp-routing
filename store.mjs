// Shared by the stock extension and the offline CLI; intentionally no provider/auth dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const roles = Object.freeze(['planner', 'executor', 'worker']);
export const efforts = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const limit = 16384;
const fail = code => { throw new Error(code); };
const hash = data => createHash('sha256').update(data).digest('hex');
const known = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k));
const plainId = s => typeof s === 'string' && s.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/.test(s);
export const validAgent = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(s);
export function validateDraft(draft) {
  if (!known(draft, ['roles', 'workerAgent']) || !validAgent(draft.workerAgent) || !known(draft.roles, roles)) fail('INVALID_BINDINGS');
  for (const key of roles) {
    const b = draft.roles[key];
    if (!known(b, ['provider', 'id', 'effort']) || !plainId(b.provider) || b.provider.includes('/') || !plainId(b.id) || ('effort' in b && !efforts.includes(b.effort))) fail(`INVALID_BINDING_${key.toUpperCase()}`);
  }
  return draft;
}
export function checkRecord(record) {
  if (!known(record, ['schemaVersion', 'revision', 'roles', 'workerAgent']) || record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) fail('UNKNOWN_BINDINGS_FORMAT');
  validateDraft({roles: record.roles, workerAgent: record.workerAgent});
  return record;
}
function directory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== path.normalize(dir)) fail('ABSOLUTE_PHYSICAL_DIRECTORY_REQUIRED');
  const parts = []; for (let p = path.resolve(dir); ; p = path.dirname(p)) { parts.push(p); if (p === path.dirname(p)) break; }
  for (const p of parts.reverse()) { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || path.relative(p, fs.realpathSync(p)) !== '') fail('UNSAFE_BINDINGS_DIRECTORY'); }
  return dir;
}
export function configPath(dir) { return path.join(directory(dir), 'routing', 'model-bindings.v1.json'); }
function existing(p) { try { return fs.lstatSync(p); } catch(e) { if (e.code === 'ENOENT') return null; throw e; } }
export function readBounded(p) {
  if (!path.isAbsolute(p)) fail('ABSOLUTE_FILE_REQUIRED');
  directory(path.dirname(p)); const s = fs.lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit || path.relative(p, fs.realpathSync(p)) !== '') fail('UNSAFE_OR_OVERSIZE_BINDINGS_FILE');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const f = fs.fstatSync(fd); if (!f.isFile() || f.dev !== s.dev || f.ino !== s.ino || f.nlink !== 1 || f.size !== s.size) fail('BINDINGS_FILE_CHANGED');
    const b = Buffer.alloc(f.size + 1); let n=0; while(n<b.length) {const got=fs.readSync(fd,b,n,b.length-n,null); if(!got)break; n+=got;}
    if(n!==s.size) fail('BINDINGS_FILE_CHANGED'); return b.subarray(0,n);
  } finally { fs.closeSync(fd); }
}
export function jsonBytes(b) { try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b)); } catch { fail('INVALID_BINDINGS_JSON'); } }
function bytes(dir) {
  const p=configPath(dir); if (!existing(path.dirname(p))) return null;
  directory(path.dirname(p)); return existing(p) ? readBounded(p) : null;
}
export function readBindings(dir) {
  const b=bytes(dir); if(!b)return null;
  try { return checkRecord(jsonBytes(b)); } catch(e) { throw new Error(`${e.message}; sha256=${hash(b)}`); }
}
export function saveBindings(dir, draft, expectedRevision, replaceInvalidDigest) {
  validateDraft(draft);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER || (replaceInvalidDigest !== undefined && !/^[0-9a-f]{64}$/.test(replaceInvalidDigest))) fail('EXPECTED_REVISION_OR_DIGEST_INVALID');
  const p=configPath(dir), parent=path.dirname(p), lock=path.join(parent,'.writer.lock');
  try { fs.mkdirSync(parent,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
  directory(parent); const lockFd=fs.openSync(lock,'wx',0o600);
  const tmp=path.join(parent,`.stage-${randomUUID()}`); let staged=false;
  try {
    const before=bytes(dir); let revision=0, invalid=false;
    if(before){ try { revision=checkRecord(jsonBytes(before)).revision; } catch { invalid=true; } }
    if(invalid ? (hash(before)!==replaceInvalidDigest || expectedRevision!==0) : replaceInvalidDigest!==undefined) fail('INVALID_RECORD_REPAIR_REQUIRES_MATCHED_DIGEST');
    if(revision!==expectedRevision) fail('STALE_BINDINGS_REVISION');
    const record=checkRecord({schemaVersion:1,revision:revision+1,roles:draft.roles,workerAgent:draft.workerAgent});
    const out=Buffer.from(JSON.stringify(record,null,2)+'\n'); const fd=fs.openSync(tmp,'wx',0o600);staged=true;
    try { fs.writeFileSync(fd,out);fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
    const now=bytes(dir); if((now===null)!==(before===null) || (now && !now.equals(before)) || !readBounded(tmp).equals(out)) fail('BINDINGS_DRIFT');
    fs.renameSync(tmp,p);staged=false;
    if(!readBounded(p).equals(out)) fail('BINDINGS_REPLACE_UNCERTAIN');
    return record;
  } finally {try{if(staged) fs.unlinkSync(tmp);}finally{fs.closeSync(lockFd);fs.unlinkSync(lock);}}
}
export function eligible(model) { return !!model && plainId(model.provider) && !model.provider.includes('/') && plainId(model.id) && model.supportsTools !== false; }
export function choices(model) { return model.reasoning && !model.thinking?.unverified ? efforts.filter(e=>model.thinking?.efforts?.includes(e)) : []; }
export function validateCatalog(ctx, record) {
  checkRecord(record); const models=ctx.models.list();
  for(const role of roles){const b=record.roles[role],hits=models.filter(m=>m.provider===b.provider && m.id===b.id);
    if(hits.length!==1 || !eligible(hits[0])) fail(`MODEL_UNAVAILABLE_OR_AMBIGUOUS_${role.toUpperCase()}`);
    if(b.effort && !choices(hits[0]).includes(b.effort)) fail(`UNSUPPORTED_OR_UNVERIFIED_EFFORT_${role.toUpperCase()}`);
  }
  return record;
}
