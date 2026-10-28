import {mkdir,readFile,writeFile,appendFile,cp} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {renameArtifact} from '../run/atomic.js';

export const artifactHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
export const caseFile=(caseId:string):string=>createHash('sha256').update(caseId).digest('hex');

/** Serial atomic publication keeps parallel cases and provider accounting coherent. */
export class UnifiedRunStore{
 readonly directory:string;
 #queue:Promise<void>=Promise.resolve();
 constructor(directory:string){this.directory=resolve(directory);}
 path(name:string):string{
  const result=resolve(this.directory,name),rel=relative(this.directory,result);
  if(rel.startsWith('..')||isAbsolute(rel))throw Error('Artifact path escapes run directory');return result;
 }
 async read<T>(name:string):Promise<T>{return JSON.parse(await readFile(this.path(name),'utf8')) as T;}
 async optional<T>(name:string):Promise<T|undefined>{try{return await this.read<T>(name);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
 async lines<T>(name:string):Promise<readonly T[]>{try{return (await readFile(this.path(name),'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as T);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
 write(name:string,value:unknown):Promise<void>{
  const text=JSON.stringify(value,null,2)+'\n';
  const operation=this.#queue.then(async()=>{const target=this.path(name);await mkdir(dirname(target),{recursive:true});const tmp=target+'.'+randomUUID()+'.tmp';await writeFile(tmp,text,'utf8');await renameArtifact(tmp,target);});
  this.#queue=operation.catch(()=>undefined);return operation;
 }
 append(name:string,value:unknown):Promise<void>{
  const text=JSON.stringify(value)+'\n';const operation=this.#queue.then(async()=>{const target=this.path(name);await mkdir(dirname(target),{recursive:true});await appendFile(target,text,'utf8');});this.#queue=operation.catch(()=>undefined);return operation;
 }
 async snapshot(root:string):Promise<void>{
  for(const name of ['src','scripts','prompts','package.json','package-lock.json','requirements-provider.txt']){
   try{await cp(resolve(root,name),this.path('code-snapshot/'+name),{recursive:true,errorOnExist:true,force:false});}
   catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
 }
 async flush():Promise<void>{await this.#queue;}
}
