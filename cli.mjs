#!/usr/bin/env node
import { configPath, jsonBytes, readBindings, readBounded, saveBindings, validateDraft } from './store.mjs';

const guide=`routing-config show --agent-dir ABS\nrouting-config validate --agent-dir ABS --input ABS\nrouting-config apply --agent-dir ABS --input ABS --expected-revision N [--replace-invalid-sha256 HEX]\nInput: {workerAgent:string,roles:{planner:{provider,id,effort?},executor:{provider,id,effort?},worker:{provider,id,effort?}}}.\nOffline only. No model/auth lookup, prompts, native grants or settings changes outside this file.`;
try {
  const [verb,...args]=process.argv.slice(2);
  if(verb==='--help'||verb==='-h')console.log(guide);
  else {
    if(!['show','validate','apply'].includes(verb))throw Error('EXPECTED_SHOW_VALIDATE_OR_APPLY (see --help)');
    const allowed=verb==='show'?['--agent-dir']:verb==='validate'?['--agent-dir','--input']:['--agent-dir','--input','--expected-revision','--replace-invalid-sha256'];
    const opts=new Map();for(let i=0;i<args.length;i+=2){const [k,v]=args.slice(i,i+2);if(!allowed.includes(k)||opts.has(k)||!v||v.startsWith('--'))throw Error('INVALID_OR_DUPLICATE_OPTION');opts.set(k,v);}
    const dir=opts.get('--agent-dir'),file=configPath(dir);let record, outcome;
    if(verb==='show'){record=readBindings(dir);outcome=record?'configured':'unconfigured';}
    else {
      const input=opts.get('--input');if(!input)throw Error('INPUT_REQUIRED');const draft=validateDraft(jsonBytes(readBounded(input)));
      if(verb==='validate'){record=draft;outcome='valid-draft';}
      else{const revision=opts.get('--expected-revision');if(!/^(0|[1-9]\d*)$/.test(revision??''))throw Error('EXPECTED_REVISION_REQUIRED');record=saveBindings(dir,draft,Number(revision),opts.get('--replace-invalid-sha256'));outcome='saved';}
    }
    console.log(JSON.stringify({outcome,file,record,scope:'offline-only: catalog, native grants and inference not checked'},null,2));
  }
} catch(e) {console.error(e?.code??e?.message??'ROUTING_CONFIG_ERROR');process.exitCode=2;}
