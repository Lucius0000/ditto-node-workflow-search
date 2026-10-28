import {Worker} from 'node:worker_threads';
import type {RegisteredTool,JsonObject} from '@codesoul-co/ditto';
import {CODING_EXECUTION_POLICY} from '../coding/policy.js';
import {timeBudgetCleanupRegistrar} from '../execution/time-budget.js';
import type {ToolDefinition} from './schema.js';

export function generatedTools(definitions:readonly ToolDefinition[]):{tools:RegisteredTool[];close():Promise<void>} {
 const workers=new Set<Worker>();
 return {tools:definitions.map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema,effects:[],
  validate(args:JsonObject){
   const schema=tool.inputSchema;
   for(const key of schema.required??[])if(!Object.hasOwn(args,key))throw Error(`Missing generated tool argument ${key}`);
   if(schema.additionalProperties===false)for(const key of Object.keys(args))if(!Object.hasOwn(schema.properties??{},key))throw Error(`Unexpected generated tool argument ${key}`);
   for(const [key,rule]of Object.entries(schema.properties??{})as[string,any][]){if(!Object.hasOwn(args,key))continue;const v=args[key];
    const valid=rule.type==='number'?typeof v==='number'&&Number.isFinite(v):rule.type==='integer'?Number.isSafeInteger(v):rule.type==='array'?Array.isArray(v):rule.type==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):!rule.type||typeof v===rule.type;
    if(!valid)throw Error(`Invalid generated tool argument ${key}: expected ${rule.type}`);
   }
  },
  async execute(args:JsonObject,execution:any){
   execution.signal?.throwIfAborted();
   const worker=new Worker(new URL('../coding/tool-worker.js',import.meta.url),{workerData:{source:tool.executeSource,args},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});workers.add(worker);
   const register=timeBudgetCleanupRegistrar();
   try{return await new Promise<any>((resolve,reject)=>{
    let settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);execution.signal?.removeEventListener('abort',abort);
     const termination=worker.terminate();register(termination);void termination.then(()=>error?reject(error):resolve({status:'success',structuredContent:{result:value}}));};
    const abort=()=>finish(execution.signal.reason instanceof Error?execution.signal.reason:new Error('Generated tool canceled'));
    const timer=setTimeout(()=>finish(new Error('Generated tool execution limit exceeded')),CODING_EXECUTION_POLICY.toolWallMs);
    execution.signal?.addEventListener('abort',abort,{once:true});
    if(execution.signal?.aborted)abort();
    worker.once('message',reply=>reply.ok?finish(undefined,reply.value):finish(new Error(reply.error)));
    worker.once('error',error=>finish(error));worker.once('exit',code=>{if(!settled)finish(new Error(`Generated tool exited ${code}`));});
   });}finally{workers.delete(worker);}
  },
 })),async close(){await Promise.all([...workers].map(w=>w.terminate()));workers.clear();}};
}
