// Bounded metadata storage. No transcripts, tracker invocation or task scanning.
import {open, readFile, rename, mkdir, unlink, lstat, opendir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
export const LIMIT = 262144;
export async function json(file, limit=LIMIT) {
  const fd=await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s=await fd.stat();
    if(!s.isFile() || s.size>limit) throw Error('source-bound');
    const b=Buffer.alloc(limit+1); const {bytesRead}=await fd.read(b,0,b.length,0);
    if(bytesRead>limit) throw Error('source-bound');
    return JSON.parse(b.subarray(0,bytesRead).toString());
  } finally {await fd.close();}
}
export async function atomic(directory, name, value) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const s=await lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('unsafe-output');
  if(name.startsWith('admission-')){
    let existing=false,count=0,scanned=0;const entries=await opendir(directory);
    for await(const entry of entries){
      if(++scanned>256)throw Error('output-directory-capacity');
      if(entry.name===name)existing=true;
      if(entry.name.startsWith('admission-')&&entry.name.endsWith('.json'))count++;
    }
    if(!existing&&count>=64)throw Error('admission-cache-capacity');
  }
  const bytes=JSON.stringify(value);
  if(Buffer.byteLength(bytes)>LIMIT)throw Error('snapshot-bound');
  const next=join(directory,name+'.next');
  const fd=await open(next,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(bytes);}finally{await fd.close();}
  await rename(next,join(directory,name));
}
export const safe = s => typeof s==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(s)&&s!=='.'&&s!=='..';
export async function lifetime(pid=process.pid) {
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('pid');
  const [stat,ns]=await Promise.all([readFile(`/proc/${pid}/stat`,'utf8'), import('node:fs/promises').then(fs=>fs.readlink(`/proc/${pid}/ns/pid`))]);
  return {pid,startTicks:stat.slice(stat.lastIndexOf(') ')+2).split(' ')[19],pidNamespace:ns};
}
export async function remove(directory,name){try{await unlink(join(directory,name));}catch{}}

export class NativeTaskMissing extends Error {}
export async function nativeTask(file) {
  try{return await json(file);}catch(error){if(error.code==='ENOENT')throw new NativeTaskMissing('native-task-missing');throw error;}
}
