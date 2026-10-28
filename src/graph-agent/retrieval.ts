import {createRetrievalWorker,RetrievalTargetRegistry,RetrievalError} from '@codesoul-co/ditto-retrieval';
import type {BenchmarkTask} from '../domain.js';

/** One immutable lexical index per task attempt. No files, network, labels or prior tasks. */
export function createTaskRetrieval(task:BenchmarkTask){
 const segments=task.prompt.split(/\n+|(?<=[.!?])\s+/u).map(text=>text.trim()).filter(Boolean);
 const provider={async search(input:any,context:any){
  context?.signal?.throwIfAborted();
  if(input.target.name!=='task-public')throw new RetrievalError('TARGET_NOT_FOUND','Only the current public task target is authorized');
  if(typeof input.query.content!=='string')throw new RetrievalError('INVALID_INPUT','Task retrieval query.content must be text');
  const words=[...new Set((input.query.content.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[]) as string[])];
  const candidates=segments.map((content,index)=>({id:`task-segment-${index}`,content,score:words.reduce((score,word)=>score+Number(content.toLocaleLowerCase().includes(word)),0),source:{target:'task-public',ref:`segment:${index}`}}))
   .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,input.limit??5);
  return{candidates,strategy:'lexical',target:{name:'task-public'},metadata:{source:'current-public-task',segments:segments.length}};
 }};
 const providers=new RetrievalTargetRegistry({'task-public':{defaultStrategy:'lexical',providers:{lexical:provider}}});
 return{worker:createRetrievalWorker({providers}),targets:Object.freeze([{name:'task-public',strategy:'lexical',scope:'current-public-task'}])};
}
