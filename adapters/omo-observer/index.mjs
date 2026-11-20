// Optional OmO 5.1.69 observation package. Metadata only; no registered tools.
import {randomUUID,createHash} from 'node:crypto';
import {isAbsolute,resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {json,atomic,lifetime,remove,safe,nativeTask,NativeTaskMissing} from './io.mjs';
import {hosted} from './rpc.mjs';
import {bindWorkPolicy} from './work-policy.mjs';
const BARREL=Symbol.for('omo.senpi-task.senpiBarrel');
const HUB=Symbol.for('bdi.omo.observation.v1');
const CAP=128,TTL=3000;
const bounded=s=>typeof s==='string'&&s.length<=512?s:null;
const model=s=>s?.model?.id?bounded(`${s.model.provider}/${s.model.id}`):null;
const stamp=t=>JSON.stringify([t.task_id,t.parent_session_id,t.created_at,t.child_session_id??null,t.pid??null,t.notification?.run_epoch??null,t.status]);
// Hints only schedule authoritative reads; they never establish execution.
export function selectAdmissions(list,cursor={active:0,idle:0}){
  const valid=list.filter(a=>!a.invalid),active=valid.filter(a=>['running','pending'].includes(a.statusHint)).reverse();
  const idle=valid.filter(a=>!['running','pending'].includes(a.statusHint));
  const take=(items,start,count)=>Array.from({length:Math.min(count,items.length)},(_,i)=>items[(start+i)%items.length]);
  const hot=take(active,cursor.active,8),cold=take(idle,cursor.idle,8-hot.length);
  return {scan:[...hot,...cold],cursor:{active:active.length?(cursor.active+hot.length)%active.length:0,idle:idle.length?(cursor.idle+cold.length)%idle.length:0}};
}
const hint=status=>['running','pending'].includes(status)?status:'other';
export function installTap(AgentSession, hub){
  const p=AgentSession?.prototype;if(typeof p?._emit!=='function')return false;
  if(p._emit[HUB])return true;
  const original=p._emit;
  function wrapper(...args){
    // Preserve original throws, return values and promise identity exactly.
    const result=Reflect.apply(original,this,args);
    try{if(hub.users!==0)hub.observe(this);}catch{/* Observation never affects native execution. */}
    return result;
  }
  Object.defineProperty(wrapper,HUB,{value:true});p._emit=wrapper;return true;
}
function hub(){
  if(globalThis[HUB])return globalThis[HUB];
  const h={objects:new Map(),ids:new WeakMap(),serial:0,users:0};
  h.observe=session=>{
    const id=session.sessionManager?.getSessionId?.();if(!safe(id))return;
    if(!h.ids.has(session))h.ids.set(session,++h.serial);
    if(h.objects.size>=CAP&&!h.objects.has(h.ids.get(session)))h.objects.delete(h.objects.keys().next().value);
    h.objects.set(h.ids.get(session),{ref:new WeakRef(session),object:h.ids.get(session)});
  };
  return globalThis[HUB]=h;
}
export async function admissionFromResult(event,ctx,taskDirectory){
  if(event.isError)return [];
  // Only dedicated custom metadata entries are inspected, never message content.
  const branch=ctx.sessionManager.getBranch().slice(-128);
  const start=branch.findLast(x=>x.type==='custom'&&x.customType==='qrclip-beads-dispatch-start'&&x.data?.toolCallId===event.toolCallId);
  const end=branch.findLast(x=>x.type==='custom'&&x.customType==='qrclip-beads-dispatch-result'&&x.data?.toolCallId===event.toolCallId);
  if(!start||!end||end.data?.failures?.length)return [];
  const attempts=start.data.attempts,items=Array.isArray(event.details?.items)?event.details.items:[event.details];
  if(!Array.isArray(attempts)||attempts.length>16||attempts.length!==items.length)return [];
  const parent=ctx.sessionManager.getSessionId(),out=[];
  for(let i=0;i<items.length;i++){
    const item=items[i],a=attempts[i];
    if(!safe(item?.task_id)||!safe(parent)||!safe(a?.id)||!safe(a?.attempt)||!bounded(event.toolCallId)||!['pending','running','completed'].includes(item.status))continue;
    const t=await json(join(taskDirectory,item.task_id+'.json'));
    if(t.task_id!==item.task_id||t.parent_session_id!==parent||!bounded(t.created_at))continue;
    out.push({bead:a.id,attempt:a.attempt,toolCall:event.toolCallId,task:t.task_id,parent,created:t.created_at,
      initialChild:bounded(t.child_session_id),runEpoch:Number.isSafeInteger(t.notification?.run_epoch)&&t.notification.run_epoch>=0?t.notification.run_epoch:null,
      invalid:false,statusHint:hint(t.status)});
  }
  return out;
}
function ownWorker(ctx,activeRun,identity,life){
  const session=ctx.sessionManager.getSessionId();if(!safe(session))return null;
  const idle=ctx.isIdle();
  return {...life,session,identity,observedAt:new Date().toISOString(),model:ctx.model?.id?bounded(`${ctx.model.provider}/${ctx.model.id}`):null,
    presence:idle===true?'live_idle':idle===false?'live_busy':'unknown',
    execution:typeof activeRun!=='boolean'?'unknown':activeRun&&idle===false?'active':'inactive',source:'public-context'};
}
export default async function install(pi){
  let directory=process.env.BDI_OBSERVER_DIRECTORY,taskDirectory=process.env.BDI_TASK_DIRECTORY,project=process.env.BDI_PROJECT;
  let privateVersion=process.env.BDI_OMO_PRIVATE_VERSION,projectDirectory=null;
  let workPolicyExecutable;
  // Host launches filter arbitrary variables. The installed user settings
  // take precedence so environment-only observation cannot override policy.
  const settingsFile=join(dirname(fileURLToPath(import.meta.url)),'settings.json');
  const missing=Symbol('missing-settings');
  const configured=await json(settingsFile,8192).catch(error=>{
    if(error instanceof Error&&error.code==='ENOENT')return missing;
    return null;
  });
  if(configured!==missing){
    if(!configured||typeof configured!=='object'||Array.isArray(configured))return;
    ({directory,taskDirectory,project,privateVersion,projectDirectory,workPolicyExecutable}=configured);
    if(typeof projectDirectory!=='string'||!isAbsolute(projectDirectory))return;
  }
  if(typeof directory!=='string'||typeof taskDirectory!=='string'||!isAbsolute(directory)||!isAbsolute(taskDirectory)||!bounded(project))return;
  let workPolicy;
  if(workPolicyExecutable!==undefined){
    if(typeof workPolicyExecutable!=='string')return;
    try{workPolicy=await bindWorkPolicy(workPolicyExecutable,projectDirectory,taskDirectory);}
    catch(error){if(!(error instanceof Error))throw error;return;}
    if(!workPolicy)return;
    taskDirectory=workPolicy.taskDirectory;
    privateVersion=undefined;
  }
  const scope={project,taskDirectory:resolve(taskDirectory)},epoch=randomUUID(),h=hub();
  h.users++;
  const state={ctx:null,activeRun:null,admissions:new Map(),sequence:0,busy:false,dirty:false,stopped:false,loaded:false,cursor:{active:0,idle:0},baselines:new Map(),pending:0,session:null};
  const name=`frame-${process.pid}-${epoch}.json`;
  const sameSession=(ctx,session)=>!state.stopped&&state.ctx?.cwd===ctx.cwd&&state.session===session;
  let life=null;
  lifetime().then(x=>{life=x;}).catch(()=>{});
  const keyRoot=process.env.OMO_AGENT_DIR?join(process.env.OMO_AGENT_DIR,'rpc/keys'):null;
  const persistName=parent=>'admission-'+createHash('sha256').update(JSON.stringify([scope,parent])).digest('hex')+'.json';
  async function save(){
    if(!state.ctx)return;
    await atomic(directory,persistName(state.ctx.sessionManager.getSessionId()),{version:1,scope,parent:state.ctx.sessionManager.getSessionId(),admissions:[...state.admissions.values()]});
  }
  async function load(){
    if(state.loaded||!state.ctx)return;state.loaded=true;
    const parent=state.ctx.sessionManager.getSessionId();
    try{
      const old=await json(join(directory,persistName(parent)));
      if(old.version!==1||JSON.stringify(old.scope)!==JSON.stringify(scope)||old.parent!==parent||!Array.isArray(old.admissions)||old.admissions.length>CAP)return;
      for(const a of old.admissions)if(safe(a.task)&&a.parent===parent&&safe(a.bead)&&safe(a.attempt)&&bounded(a.created)&&bounded(a.toolCall)&&
        (a.runEpoch===undefined||a.runEpoch===null||(Number.isSafeInteger(a.runEpoch)&&a.runEpoch>=0)))state.admissions.set(JSON.stringify([a.bead,a.attempt,a.task]),a);
    }catch{/* A missing cache is expected for future assignments. */}
  }
  async function sample(){
    if(!state.ctx)return;
    if(state.stopped||state.busy){state.dirty=true;return;}state.busy=true;state.dirty=false;
    try{
      const context=state.ctx,session=state.session;
      if(workPolicy&&(!await workPolicy.permitted(context.cwd)||!sameSession(context,session))){
        state.baselines.clear();
        await remove(directory,name);
        return;
      }
      await load();
      if(privateVersion==='5.1.69')installTap(globalThis[BARREL]?.module?.AgentSession,h);
      const workers=[];
      // At most 128 exact admitted task files, no directory or session enumeration.
      // Four concurrent baselines bound both read pressure and RPC fanout.
      const list=[...state.admissions.values()],deadline=Date.now()+1500;
      const selected=selectAdmissions(list,state.cursor),scan=selected.scan;state.cursor=selected.cursor;
      let offset=0,changed=false;
      async function next(){for(;;){const a=scan[offset++];if(!a||Date.now()>deadline)return;if(a.invalid)continue;
        try{
          const t=await nativeTask(join(taskDirectory,a.task+'.json'));
          if(t.task_id!==a.task||t.parent_session_id!==a.parent||t.created_at!==a.created){a.invalid=true;changed=true;state.baselines.delete(a.task);continue;}
          a.statusHint=hint(t.status);
          let w=null;
          if(t.host_session){if(keyRoot)w=await hosted(t,keyRoot);}
          else if(t.execution_mode==='in-process'&&t.child_session_id){
            const matches=[...h.objects.values()].filter(e=>e.ref.deref()?.sessionManager?.getSessionId?.()===t.child_session_id);
            const entry=matches.length===1?matches[0]:null,s=entry?.ref.deref();
            if(s?.sessionManager?.getSessionId?.()===t.child_session_id){
              const l=s.lifecycle;
              if(l&&!l.restoring&&l.persisted)w={session:t.child_session_id,identity:`emitter:${epoch}:${entry.object}:${l.activityRevision?.instanceId??'unknown'}`,
                model:model(s),presence:s.isStreaming?'live_busy':'live_idle',
                execution:l.runPaused===true?'inactive':s.isStreaming===true?'active':'inactive',source:'private-emitter-baseline'};
            }
          }
          const runEpoch=Number.isSafeInteger(t.notification?.run_epoch)&&t.notification.run_epoch>=0?t.notification.run_epoch:null;
          if(w&&a.runEpoch!==runEpoch){a.runEpoch=runEpoch;changed=true;}
          if(w&&!w.observedAt)w.observedAt=new Date().toISOString();
          const after=await nativeTask(join(taskDirectory,a.task+'.json'));
          if(stamp(t)!==stamp(after)){state.baselines.delete(a.task);continue;}
          if(w)state.baselines.set(a.task,{...w,task:a.task,parent:a.parent,created:a.created,child:t.child_session_id??null,runEpoch,
            observedAt:w.observedAt});else state.baselines.delete(a.task);
        }catch(error){
          state.baselines.delete(a.task);
          // Observed removal revokes continuity, including across provider reload.
          if(error instanceof NativeTaskMissing){a.invalid=true;changed=true;}
        }
      }}
      await Promise.all(Array.from({length:Math.min(4,list.length)},next));
      if(!sameSession(context,session))return;
      if(changed)await save();
      if(!sameSession(context,session))return;
      const allowed=new Set(list.filter(a=>!a.invalid).map(a=>a.task));
      for(const [task,w] of state.baselines){if(!allowed.has(task)||Date.now()-Date.parse(w.observedAt)>TTL)state.baselines.delete(task);else workers.push(w);}
      while(state.baselines.size>CAP)state.baselines.delete(state.baselines.keys().next().value);
      if(state.ctx&&life){const w=ownWorker(state.ctx,state.activeRun,`process:${life.pid}:${life.startTicks}:${epoch}`,life);if(w)workers.unshift(w);}
      await atomic(directory,name,{version:1,scope,epoch,sequence:++state.sequence,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+TTL).toISOString(),admissions:list,workers:workers.slice(0,CAP),coverage:'guarded-future-assignments; sampled-current-state; preview-not-attached'});
    }catch{/* Previous frame expires; errors are never relabelled as live. */}
    finally{state.busy=false;if(state.stopped)await remove(directory,name);}
  }
  let wakeTimer=null;
  const wake=()=>{if(state.stopped)return;state.dirty=true;if(!wakeTimer)wakeTimer=setTimeout(()=>{wakeTimer=null;void sample();},250);};
  const taskListener=e=>{if(e?.name==='omo.task.updated'){
    // Late completion events cannot demote a currently active task. Positive
    // hints trigger a read; only the native file may demote a scheduling hint.
    for(const task of (Array.isArray(e.data?.tasks)?e.data.tasks:[]).slice(0,256)){
      if(!['running','pending'].includes(task?.status))continue;
      for(const a of state.admissions.values())if(a.parent===e.data?.parent_session_id&&a.task===task.task_id)a.statusHint=task.status;
    }
    wake();
  }};
  const unsubscribeTask=pi.events.on('senpi:extension-rpc-event',taskListener);
  for(const event of ['session_start','agent_start','agent_end','model_select'])pi.on(event,(_e,ctx)=>{
    if(!workPolicy&&projectDirectory&&ctx.cwd!==projectDirectory&&!ctx.cwd?.startsWith(projectDirectory+'/')){
      state.ctx=null;state.session=null;state.admissions.clear();state.baselines.clear();state.cursor={active:0,idle:0};state.loaded=false;state.activeRun=null;void remove(directory,name);return;
    }
    const previous=state.session;
    if(previous&&previous!==ctx.sessionManager.getSessionId()){state.admissions.clear();state.baselines.clear();state.cursor={active:0,idle:0};state.loaded=false;state.activeRun=null;}
    state.session=ctx.sessionManager.getSessionId();state.ctx=ctx;
    if(event==='agent_start')state.activeRun=true;
    if(event==='agent_end')state.activeRun=false;
    wake();
  });
  pi.on('tool_result',(e,ctx)=>{
    if(state.pending>=16||!state.ctx||ctx.sessionManager.getSessionId()!==state.session)return;
    const items=Array.isArray(e.details?.items)?e.details.items:[e.details];
    if(items.length>16||!items.some(i=>safe(i?.task_id)))return;
    const event={toolCallId:e.toolCallId,isError:e.isError,details:{items:items.map(i=>({task_id:i?.task_id,status:i?.status}))}};
    const parent=ctx.sessionManager.getSessionId();state.pending++;
    // Other tool_result hooks may still be writing the guard receipt. Do not
    // block them or depend on extension registration order. Retry metadata only.
    void (async()=>{try{
      for(let retry=0;retry<16&&!state.stopped;retry++){
        await new Promise(r=>setTimeout(r,250));
        if(!sameSession(ctx,parent)||ctx.sessionManager.getSessionId()!==parent)return;
        if(workPolicy&&!await workPolicy.permitted(ctx.cwd))return;
        if(!sameSession(ctx,parent))return;
        const entries=await admissionFromResult(event,ctx,taskDirectory);if(!entries.length)continue;
        await load();
        if(!sameSession(ctx,parent))return;
        for(const a of entries){
          const key=JSON.stringify([a.bead,a.attempt,a.task]),old=state.admissions.get(key);
          if(old?.invalid)continue;
          if(state.admissions.size>=CAP&&!state.admissions.has(key))state.admissions.delete(state.admissions.keys().next().value);
          state.admissions.set(key,a);
        }
        state.cursor.active=0;await save();wake();return;
      }
    }catch{/* No verified admission is safer than a guessed one. */}finally{state.pending--;}})();
  });
  // Baselines have a 1s coalescing cadence, not a growing event history.
  const timer=setInterval(()=>{void sample();},1000);timer.unref();
  pi.on('session_shutdown',async()=>{
    if(state.stopped)return;state.stopped=true;h.users--;clearInterval(timer);clearTimeout(wakeTimer);
    try{if(typeof unsubscribeTask==='function')unsubscribeTask();else pi.events.off?.('senpi:extension-rpc-event',taskListener);}catch{/* Native disposal may already have removed this registration. */}
    await remove(directory,name);
  });
}
