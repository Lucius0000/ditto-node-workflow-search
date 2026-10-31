import {createHash} from 'node:crypto';
export const JSON_RECOVERY_PROTOCOL='prompt-json-terminal-closers-v1';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function uniqueRecovery<T>(candidates:ReadonlyMap<string,T>):[string,T]{if(candidates.size!==1)throw Error('Terminal JSON recovery requires exactly one legal JSON text; found '+candidates.size);return [...candidates][0]!;}
/** Choose syntax uniquely before applying any schema or business validator. */
export function parsePromptJSON(original:string){
 const result=(text:string,value:unknown,removed:{index:number;character:string}[])=>({value,syntax:{protocol:JSON_RECOVERY_PROTOCOL,recovered:removed.length>0,originalSha256:sha(original),text,sha256:sha(text),removed}});
 try{return result(original,JSON.parse(original),[]);}catch{}
 const text=original.trimEnd(),run=/[}\]]+$/.exec(text);if(!run)throw Error('Strict JSON failed; no terminal closing segment');
 const start=run.index,candidates=new Map<string,{value:unknown;removed:{index:number;character:string}[]}>();
 const attempt=(indices:number[])=>{const candidate=text.slice(0,start)+[...text.slice(start)].filter((_,i)=>!indices.includes(start+i)).join('');if(candidates.has(candidate))return;try{candidates.set(candidate,{value:JSON.parse(candidate),removed:indices.map(index=>({index,character:text[index]!}))});}catch{}};
 for(let i=start;i<text.length;i++){attempt([i]);for(let j=i+1;j<text.length;j++)attempt([i,j]);}
 const [candidate,entry]=uniqueRecovery(candidates);return result(candidate,entry.value,entry.removed);
}
