// Read-only authenticated OmO 5.1.69 RPC. Fixed commands; bounded frames/time.
import {createConnection} from 'node:net';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {json} from './io.mjs';
export class Rpc {
  constructor(endpoint,keyRoot){this.endpoint=endpoint;this.keyRoot=keyRoot;this.pending=new Map();this.n=0;this.closed=false;}
  close(){this.closed=true;this.socket?.destroy();for(const p of this.pending.values())p.reject(Error('disconnected'));this.pending.clear();}
  async connect(){
    const s=this.socket=createConnection(this.endpoint);s.setEncoding('utf8');let buffer='';
    s.on('error',()=>this.close());s.on('close',()=>this.close());
    s.on('data',chunk=>{try{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>262144)throw Error('frame-bound');
      let count=0;
      while(buffer.includes('\n')){
        if(++count>256)throw Error('frame-count');
        const at=buffer.indexOf('\n'),row=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
        const p=this.pending.get(row.id);if(p){this.pending.delete(row.id);p.resolve(row);}
      }
    }catch{this.close();}});
    await new Promise((resolve,reject)=>{
      const t=setTimeout(()=>{this.close();reject(Error('connect-timeout'));},750);
      s.once('connect',()=>{clearTimeout(t);resolve();});s.once('error',e=>{clearTimeout(t);reject(e);});
    });
    const nonce=randomBytes(32).toString('hex'),p=await this.send('get_protocol_info',{observe:true,auth:{client_nonce:nonce}}),a=p.data?.auth;
    if(!a||!/^[A-Za-z0-9_-]{1,128}$/.test(a.launch_id))throw Error('auth');
    const path=join(this.keyRoot,a.launch_id),st=await lstat(path);
    if(st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('key');
    const k=await json(path,8192);
    if(k.endpoint!==this.endpoint||k.launch_id!==a.launch_id||!/^([a-f0-9]{2}){32}$/i.test(k.key))throw Error('key-scope');
    const mac=xs=>createHmac('sha256',Buffer.from(k.key,'hex')).update(xs.join('\n')).digest();
    const expected=mac(['senpi-rpc-server',a.launch_id,nonce,a.server_nonce]),proof=Buffer.from(a.server_proof??'','hex');
    if(proof.length!==expected.length||!timingSafeEqual(proof,expected))throw Error('proof');
    const r=await this.send('authenticate',{client_proof:mac(['senpi-rpc-client',a.launch_id,a.server_nonce,nonce]).toString('hex')});
    if(!r.success)throw Error('authentication');return p;
  }
  send(type,fields={}){
    if(!['get_protocol_info','authenticate','list_sessions','get_state'].includes(type))throw Error('read-only-command');
    if(this.closed||this.pending.size>=4)return Promise.reject(Error('closed-or-capacity'));
    const id='bdi-'+(++this.n);
    return new Promise((resolve,reject)=>{
      const t=setTimeout(()=>{this.pending.delete(id);reject(Error('timeout'));},750);
      this.pending.set(id,{resolve:r=>{clearTimeout(t);resolve(r);},reject:e=>{clearTimeout(t);reject(e);}});
      this.socket.write(JSON.stringify({id,type,...fields})+'\n');
    });
  }
}
export async function hosted(task,keyRoot){
  const h=task.host_session;if(!h||typeof h.socket!=='string'||!h.socket.startsWith('/'))return null;
  const c=new Rpc(h.socket,keyRoot);
  const deadline=setTimeout(()=>c.close(),1500);
  try{
    const p=await c.connect();
    const r=await c.send('list_sessions',{include_workers:true,include_context:true});
    if(!r.success||!Array.isArray(r.data?.sessions)||r.data.sessions.length>256)return null;
    const rows=r.data.sessions.filter(x=>x.durableSessionId===task.child_session_id&&x.sessionPath===h.session_path&&x.context?.task_id===task.task_id&&
      (x.context.parent_session_id===task.parent_session_id||(task.depth===1&&task.root_session_id===task.parent_session_id&&x.context.root_session_id===task.parent_session_id)));
    if(rows.length!==1)return null;
    const row=rows[0],v=await c.send('get_state',{sessionId:row.sessionId,observe:true});
    if(!v.success||v.data?.sessionId!==task.child_session_id)return null;
    const l=v.data.lifecycle;
    if(!l||l.restoring||!l.persisted)return null;
    return {observedAt:new Date().toISOString(),session:task.child_session_id,identity:`host:${p.data.instanceId}:${task.child_session_id}:${l.activityRevision?.instanceId??'unknown'}`,
      model:v.data.model?`${v.data.model.provider}/${v.data.model.id}`:null,
      presence:v.data.isStreaming?'live_busy':'live_idle',execution:l.runPaused===true?'inactive':v.data.isStreaming===true?'active':'inactive',
      source:'authenticated-host-baseline'};
  }finally{clearTimeout(deadline);c.close();}
}
