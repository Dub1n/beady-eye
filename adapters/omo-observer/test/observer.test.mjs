import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import install,{installTap,admissionFromResult,selectAdmissions} from '../index.mjs';
import {atomic,json,lifetime,nativeTask,NativeTaskMissing,safe} from '../io.mjs';
import {Rpc} from '../rpc.mjs';
const temp=async t=>{const d=await mkdtemp(join(tmpdir(),'bdi-observer-test-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;};
test('tap preserves original returns and throws even if observer fails',()=>{
  class Session{_emit(value){if(value==='throw')throw new TypeError('original');return value;}}
  let seen=0;const original=Session.prototype._emit;
  assert.equal(installTap(Session,{observe(){seen++;throw Error('observer');}}),true);
  const s=new Session(),p=Promise.resolve('unchanged');assert.equal(s._emit(p),p);assert.equal(seen,1);
  assert.throws(()=>s._emit('throw'),/original/);assert.equal(seen,1);
  const wrapped=Session.prototype._emit;installTap(Session,{observe(){}});assert.equal(Session.prototype._emit,wrapped);assert.notEqual(wrapped,original);
});
test('admission requires actual guard result and scoped native parent; no text attribution',async t=>{
  const dir=await temp(t);await writeFile(join(dir,'st_apple.json'),JSON.stringify({task_id:'st_apple',parent_session_id:'parent-a',created_at:'2026-01-01T00:00:00Z',prompt:'fruit-999 is not an assignment'}));
  const entries=[{type:'message',message:'fruit-999'}, {type:'custom',customType:'qrclip-beads-dispatch-start',data:{toolCallId:'call-a',attempts:[{id:'fruit-1',attempt:'attempt-a'}]}},{type:'custom',customType:'qrclip-beads-dispatch-result',data:{toolCallId:'call-a',failures:[]}}];
  const ctx={sessionManager:{getSessionId:()=> 'parent-a',getBranch:()=>entries}},event={toolCallId:'call-a',details:{task_id:'st_apple',status:'running'}};
  const rows=await admissionFromResult(event,ctx,dir);assert.equal(rows.length,1);assert.equal(rows[0].bead,'fruit-1');assert.equal(JSON.stringify(rows).includes('fruit-999'),false);
  for(const change of [()=>{event.isError=true;},()=>{event.isError=false;entries[2].data.failures=['failed'];},()=>{entries[2].data.failures=[];entries[2].data.toolCallId='other';}]){change();assert.deepEqual(await admissionFromResult(event,ctx,dir),[]);}
});
test('atomic snapshots are bounded and private',async t=>{
  const d=await temp(t);await atomic(d,'frame-test.json',{good:true});assert.deepEqual(await json(join(d,'frame-test.json')),{good:true});
  await assert.rejects(atomic(d,'frame-test.json',{large:'x'.repeat(262144)}),/bound/);
  await chmod(d,0o755);await assert.rejects(atomic(d,'frame-test.json',{}),/unsafe/);
});
test('RPC refuses every mutating or attaching command',()=>{
  const c=new Rpc('/invented/socket','/invented/keys');for(const type of ['attach_session','prompt','abort','new_session','task_send'])assert.throws(()=>c.send(type),/read-only/);c.close();
});
test('process lifetime carries namespace plus start ticks',{skip:process.platform!=='linux'},async()=>{
  const l=await lifetime();assert.equal(l.pid,process.pid);assert.match(l.startTicks,/^\d+$/);assert.match(l.pidNamespace,/^pid:/);
});
test('public observer publishes idle presence without invented active-run evidence, then active and shutdown',{skip:process.platform!=='linux'},async t=>{
  const d=await temp(t),old={...process.env};
  process.env.BDI_OBSERVER_DIRECTORY=d;process.env.BDI_TASK_DIRECTORY='/srv/orchard/tasks';process.env.BDI_PROJECT='orchard';delete process.env.BDI_OMO_PRIVATE_VERSION;
  t.after(()=>{process.env=old;});
  const handlers=new Map(),pi={events:new EventEmitter(),on:(n,f)=>handlers.set(n,f)};let idle=true;
  const ctx={sessionManager:{getSessionId:()=> 'parent-a',getBranch:()=>[]},isIdle:()=>idle,model:{provider:'invented',id:'gpt-6-luna'}};
  await install(pi);handlers.get('session_start')({},ctx);
  async function snapshot(predicate){const end=Date.now()+6000;while(Date.now()<end){const files=(await readdir(d)).filter(n=>n.startsWith('frame-'));if(files.length===1){const f=JSON.parse(await readFile(join(d,files[0]),'utf8'));if(predicate(f))return f;}await new Promise(r=>setTimeout(r,50));}assert.fail('public context baseline did not arrive');}
  let f=await snapshot(f=>f.workers[0]?.presence==='live_idle'&&f.workers[0]?.execution==='unknown');assert.equal(f.workers[0].presence,'live_idle');assert.equal(f.workers[0].execution,'unknown');assert.deepEqual(f.admissions,[]);
  idle=false;handlers.get('agent_start')({},ctx);f=await snapshot(f=>f.workers[0]?.execution==='active');assert.equal(f.workers[0].execution,'active');assert.equal(f.workers[0].presence,'live_busy');
  idle=true;handlers.get('agent_end')({},ctx);f=await snapshot(f=>f.workers[0]?.execution==='inactive');assert.equal(f.workers[0].execution,'inactive');
  await handlers.get('session_shutdown')();assert.equal(pi.events.listenerCount('senpi:extension-rpc-event'),0);assert.equal((await readdir(d)).some(n=>n.startsWith('frame-')),false);
});

test('only a missing native task is a continuity revocation; missing host credentials are not',async t=>{
 const dir=await temp(t);await assert.rejects(nativeTask(join(dir,'missing-task.json')),NativeTaskMissing);
 await assert.rejects(json(join(dir,'missing-key')),e=>e.code==='ENOENT'&&!(e instanceof NativeTaskMissing));
});

test('native filename IDs reject path traversal and separators',()=>{
 for(const id of ['../st_apple','st/apple','..','.','/absolute'])assert.equal(safe(id),false);
 assert.equal(safe('st_apple-1'),true);
});

test('production package defers guard lookup, follows current emitter getters, persists removal and survives reload',async t=>{
 const dir=await temp(t),tasks=join(dir,'tasks');await import('node:fs/promises').then(fs=>fs.mkdir(tasks));
 const oldEnv={...process.env},barrel=Symbol.for('omo.senpi-task.senpiBarrel'),oldBarrel=globalThis[barrel];
 Object.assign(process.env,{BDI_OBSERVER_DIRECTORY:dir,BDI_TASK_DIRECTORY:tasks,BDI_PROJECT:'orchard',BDI_OMO_PRIVATE_VERSION:'5.1.69'});
 t.after(()=>{process.env=oldEnv;globalThis[barrel]=oldBarrel;});
 class Session{constructor(id){this.sessionManager={getSessionId:()=>id};this.model={provider:'invented',id:'gpt-6-luna'};this.lifecycle={persisted:true,activityRevision:{instanceId:'activity-a'}};this.isStreaming=true;}_emit(){return 'original';}}
 globalThis[barrel]={module:{AgentSession:Session}};
 let native={task_id:'st_live',parent_session_id:'parent-live',created_at:'2026-01-01T00:00:00Z',child_session_id:'child-live-old',execution_mode:'in-process',status:'running',notification:{run_epoch:1}};
 const file=join(tasks,'st_live.json');await writeFile(file,JSON.stringify(native));
 const branch=[{type:'custom',customType:'qrclip-beads-dispatch-start',data:{toolCallId:'call-live',attempts:[{id:'fruit-1',attempt:'attempt-a'}]}}];
 const ctx={cwd:'/srv/orchard',sessionManager:{getSessionId:()=> 'parent-live',getBranch:()=>branch},isIdle:()=>true,model:{provider:'invented',id:'gpt-6.1-sol'}};
 const create=()=>{const handlers=new Map();return {handlers,pi:{events:new EventEmitter(),on:(n,f)=>handlers.set(n,f)}};};
 let {pi,handlers}=create();t.after(()=>handlers.get('session_shutdown')?.());await install(pi);handlers.get('session_start')({},ctx);
 handlers.get('tool_result')({toolCallId:'call-live',details:{task_id:'st_live',status:'running'}},ctx);
 await new Promise(r=>setTimeout(r,350));branch.push({type:'custom',customType:'qrclip-beads-dispatch-result',data:{toolCallId:'call-live',failures:[]}});
 async function frame(predicate){const end=Date.now()+6000;while(Date.now()<end){
  const names=(await readdir(dir)).filter(x=>x.startsWith('frame-'));
  if(names.length){const f=await json(join(dir,names[0]));if(predicate(f))return f;}
  await new Promise(r=>setTimeout(r,100));
 }assert.fail('bounded observer snapshot did not arrive');}
 const old=new Session('child-live-old');old._emit({type:'agent_start'});pi.events.emit('senpi:extension-rpc-event',{name:'omo.task.updated'});
 let f=await frame(f=>f.workers.some(w=>w.task==='st_live'));assert.equal(f.admissions.length,1);assert.equal(f.workers.find(w=>w.task==='st_live').session,'child-live-old');
 const cacheName='admission-'+createHash('sha256').update(JSON.stringify([{project:'orchard',taskDirectory:tasks},'parent-live'])).digest('hex')+'.json';
 let cache=await json(join(dir,cacheName));assert.equal(cache.scope.project,'orchard');assert.equal(cache.scope.taskDirectory,tasks);assert.equal(cache.admissions[0].runEpoch,1);
 native.child_session_id='child-live-new';await writeFile(file,JSON.stringify(native));const current=new Session('child-live-new');current._emit({type:'agent_start'});
 old._emit({type:'agent_end',sessionId:'child-live-new'});pi.events.emit('senpi:extension-rpc-event',{name:'omo.task.updated',data:{child_session_id:'child-live-old'}});
 f=await frame(f=>f.workers.some(w=>w.task==='st_live'&&w.session==='child-live-new'));assert.equal(f.workers.find(w=>w.task==='st_live').execution,'active');assert.equal(f.admissions[0].invalid,false);
 // A missing host socket/key is source unavailability, not task removal.
 native.host_session={socket:join(dir,'missing.sock'),session_path:'/srv/invented/session'};await writeFile(file,JSON.stringify(native));
 const sequence=f.sequence;f=await frame(f=>f.sequence>sequence&&!f.workers.some(w=>w.task==='st_live'));assert.equal(f.admissions[0].invalid,false);
 await rm(file);f=await frame(f=>f.admissions[0]?.invalid===true);cache=await json(join(dir,cacheName));assert.equal(cache.admissions[0].invalid,true);await handlers.get('session_shutdown')();
 ({pi,handlers}=create());await install(pi);handlers.get('session_start')({},ctx);
 f=await frame(f=>f.admissions[0]?.invalid===true);assert.equal(f.workers.some(w=>w.task==='st_live'),false);cache=await json(join(dir,cacheName));assert.equal(cache.admissions[0].invalid,true);await handlers.get('session_shutdown')();
});

test('persistent admission caches have a directory-wide capacity',async t=>{
 const dir=await temp(t);for(let i=0;i<64;i++)await atomic(dir,`admission-${i}.json`,{});
 await atomic(dir,'admission-1.json',{updated:true});await assert.rejects(atomic(dir,'admission-extra.json',{}),/capacity/);
});

test('shutdown handles a native unsubscribe-returning event bus without off()',async t=>{
 const dir=await temp(t),old={...process.env};Object.assign(process.env,{BDI_OBSERVER_DIRECTORY:dir,BDI_TASK_DIRECTORY:'/srv/orchard/tasks',BDI_PROJECT:'orchard'});t.after(()=>{process.env=old;});
 const handlers=new Map();let subscribed=false;const pi={on:(n,f)=>handlers.set(n,f),events:{on:()=>{subscribed=true;return ()=>{subscribed=false;};}}};
 await install(pi);assert.equal(subscribed,true);await handlers.get('session_shutdown')();assert.equal(subscribed,false);
});

test('bounded scheduling keeps current work ahead of history and traverses all idle records fairly',()=>{
 const past=Array.from({length:80},(_,i)=>({task:'past-'+i,statusHint:'other'}));
 const live=[{task:'long-running',statusHint:'running'},{task:'new-pending',statusHint:'pending'}];
 let cursor={active:0,idle:0};const seen=new Set();
 for(let i=0;i<14;i++){const next=selectAdmissions([...past,...live],cursor);cursor=next.cursor;assert.ok(next.scan.length<=8);
  assert.ok(live.every(a=>next.scan.includes(a)));next.scan.filter(a=>a.statusHint==='other').forEach(a=>seen.add(a.task));}
 assert.equal(seen.size,80);
 const many=Array.from({length:17},(_,i)=>({task:'current-'+i,statusHint:'running'}));cursor={active:0,idle:0};const all=new Set();
 for(let i=0;i<3;i++){const next=selectAdmissions(many,cursor);cursor=next.cursor;next.scan.forEach(a=>all.add(a.task));}
 assert.equal(all.size,17);assert.deepEqual(selectAdmissions([{task:'revoked',statusHint:'running',invalid:true}]).scan,[]);
});

test('fresh baselines survive a bounded scan rotation without renewal, and known removal revokes them',async t=>{
 const dir=await temp(t),tasks=join(dir,'tasks');await import('node:fs/promises').then(fs=>fs.mkdir(tasks));
 const saved={...process.env},symbol=Symbol.for('omo.senpi-task.senpiBarrel'),previous=globalThis[symbol];
 Object.assign(process.env,{BDI_OBSERVER_DIRECTORY:dir,BDI_TASK_DIRECTORY:tasks,BDI_PROJECT:'orchard',BDI_OMO_PRIVATE_VERSION:'5.1.69'});
 t.after(()=>{process.env=saved;globalThis[symbol]=previous;});
 class Session{constructor(id){this.sessionManager={getSessionId:()=>id};this.model={provider:'invented',id:'worker-model'};this.lifecycle={persisted:true,activityRevision:{instanceId:'activity-cache'}};this.isStreaming=true;}_emit(){}}
 globalThis[symbol]={module:{AgentSession:Session}};
 const attempts=[],items=[],sessions=[];
 for(let i=0;i<9;i++){
  const task='st_cache_'+i,child='cache-child-'+i;
  await writeFile(join(tasks,task+'.json'),JSON.stringify({task_id:task,parent_session_id:'parent-cache',created_at:'2026-01-01T00:00:00Z',status:'running',child_session_id:child,execution_mode:'in-process'}));
  attempts.push({id:'fruit-'+i,attempt:'attempt-'+i});items.push({task_id:task,status:'running'});sessions.push(new Session(child));
 }
 const branch=[{type:'custom',customType:'qrclip-beads-dispatch-start',data:{toolCallId:'call-cache',attempts}},{type:'custom',customType:'qrclip-beads-dispatch-result',data:{toolCallId:'call-cache',failures:[]}}];
 const handlers=new Map(),pi={events:new EventEmitter(),on:(n,f)=>handlers.set(n,f)};
 const ctx={sessionManager:{getSessionId:()=> 'parent-cache',getBranch:()=>branch},isIdle:()=>true,model:{provider:'invented',id:'coordinator-model'}};
 await install(pi);t.after(()=>handlers.get('session_shutdown')());handlers.get('session_start')({},ctx);
 handlers.get('tool_result')({toolCallId:'call-cache',details:{items}},ctx);
 await new Promise(r=>setTimeout(r,350));sessions.forEach(s=>s._emit({type:'agent_start'}));
 async function wait(predicate){const deadline=Date.now()+8000;while(Date.now()<deadline){
  const names=(await readdir(dir)).filter(n=>n.startsWith('frame-'));if(names.length){const f=await json(join(dir,names[0]));if(predicate(f))return f;}
  await new Promise(r=>setTimeout(r,50));
 }assert.fail('bounded cache observation did not arrive');}
 const first=await wait(f=>f.workers.filter(w=>w.task).length===9),at=new Map(first.workers.filter(w=>w.task).map(w=>[w.task,w.observedAt]));
 pi.events.emit('senpi:extension-rpc-event',{name:'omo.task.updated',data:{parent_session_id:'parent-cache',tasks:[{task_id:'st_cache_0',status:'completed'}]}});
 const next=await wait(f=>f.sequence>first.sequence&&f.workers.filter(w=>w.task).length===9);
 assert.ok(next.workers.filter(w=>w.task).some(w=>at.get(w.task)===w.observedAt),'unscanned baselines retain their original observation time');
 assert.ok(next.workers.filter(w=>w.task).every(w=>w.execution==='active'),'a late event cannot replace authoritative current execution');
 await rm(join(tasks,'st_cache_0.json'));
 const removed=await wait(f=>f.admissions.some(a=>a.task==='st_cache_0'&&a.invalid));assert.equal(removed.workers.some(w=>w.task==='st_cache_0'),false);
});
