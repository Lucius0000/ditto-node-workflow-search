import { createHash } from 'node:crypto';
import type { BenchmarkTask } from '../domain.js';
import { isTaskContextNode, supersededEvidenceNodes, type CapabilityNode, type CapabilitySource } from './capability-schema.js';

type Output = Record<string, any>;
export interface EvidenceBinding {readonly sourceNodeId:string;readonly consumerNodeId:string;readonly contentHash:string;}
export class CapabilityBindingError extends Error {readonly candidateFailure=true;constructor(message:string){super(message);this.name='CapabilityBindingError';}}
const text=(value:unknown):string=>typeof value==='string'?value:JSON.stringify(value);
/** Public fields and typed projections only: never arbitrary paths or task metadata. */
export function sourceOf(source:CapabilitySource,task:BenchmarkTask,outputs:Readonly<Record<string,Output>>):unknown {
 let value:unknown;
 if(source.from==='literal')return source.value;
 if(source.from==='task')value=task[source.field];
 else {const output=outputs[source.nodeId];if(!output)throw new CapabilityBindingError(`Unavailable source ${source.nodeId}`);
  switch(source.view){
   case 'context':value={...output};break;
   case 'memory-records':value=output.records.map((record:any)=>record.memory??record);break;
   case 'memory-ids':value=output.records.map((record:any)=>(record.memory??record).id);break;
   case 'external-result':case 'observation':{const {__bKind,__bNode,...external}=output;value=external;break;}
   case 'answer-text':value=(output.message??output.result??output.revisedResult)?.content;break;
  }
 }
 if(source.from==='task'&&source.extract){if(typeof value!=='string'||value.length>65536)throw new CapabilityBindingError('Numeric source exceeds the declared input limit');const numbers=value.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g)??[];value=numbers[source.extract.index];if(value===undefined)throw new CapabilityBindingError('Requested public numeric position does not exist');}
 if(value===undefined)throw new CapabilityBindingError('Source has no projected content');return value;
}
function contextOf(source:CapabilitySource,task:BenchmarkTask,outputs:Readonly<Record<string,Output>>):Output {const value=sourceOf(source,task,outputs);if(!value||typeof value!=='object'||!Array.isArray((value as Output).items))throw new CapabilityBindingError('Source is not Context');const {__bKind,__bNode,selection,...context}=value as Output;return context;}
function publicItems(value:unknown,id:string):{id:string;content:unknown}[] {
 if(value&&typeof value==='object'&&Array.isArray((value as Output).items))return (value as Output).items.map((item:any,i:number)=>({id:`${id}-${i}`,content:item.content}));
 if(Array.isArray(value))return value.map((item,i)=>({id:`${id}-${i}`,content:item&&typeof item==='object'&&'content' in item?item.content:item}));
 return [{id,content:value}];
}
export function extendedNodeInput(node:CapabilityNode,task:BenchmarkTask,outputs:Readonly<Record<string,Output>>):unknown {
 const config=node.config;const read=(name:string)=>sourceOf(config[name],task,outputs);
 switch(node.type){
  case 'CONTEXT.LOAD':return isTaskContextNode(node)?undefined:{sources:publicItems(read('sourcesSource'),`${node.id}-source`)};
  case 'CONTEXT.SELECT':return {context:contextOf(config.contextSource,task,outputs),purpose:'infer',strategy:{kind:'default'},...(config.querySource?{query:read('querySource')}:{}),...(config.limit?{limit:config.limit}:{}),...(config.maxTokens?{maxTokens:config.maxTokens}:{})};
  case 'CONTEXT.UPDATE':return {context:contextOf(config.contextSource,task,outputs),add:publicItems(read('addSource'),`${node.id}-add`),...(config.removeIds?{removeIds:config.removeIds}:{})};
  case 'CONTEXT.COMPRESS':return {context:contextOf(config.contextSource,task,outputs),...(config.maxItems?{maxItems:config.maxItems}:{}),...(config.maxTokens?{maxTokens:config.maxTokens}:{})};
  case 'MEMORY.WRITE':return {memories:publicItems(read('contentSource'),`${node.id}-memory`).map(item=>({content:item.content,metadata:{sourceNodeId:config.contentSource.nodeId??'public-task'}}))};
  case 'MEMORY.GET':return {ids:read('idsSource')};
  case 'MEMORY.SEARCH':return {query:read('querySource'),...(config.limit?{limit:config.limit}:{})};
  case 'INTERACTION.ACT.TOOL':{const args=config.arguments;let arguments_:Record<string,unknown>;
   if(config.tool==='bounded_arithmetic'){const tokens=args.tokens.map((source:CapabilitySource)=>sourceOf(source,task,outputs));if(tokens.some((token:unknown)=>typeof token!=='string'&&typeof token!=='number'))throw new CapabilityBindingError('Arithmetic tokens must be public text or numbers');arguments_={expression:tokens.join(' ')};}
   else arguments_={text:sourceOf(args.text,task,outputs),needle:sourceOf(args.needle,task,outputs)};
   return {call:{id:`${task.id}:${node.id}`,name:config.tool,arguments:arguments_}};
  }
  case 'INTERACTION.OBSERVE':return {result:read('resultSource')};
 }
}
/** Context chain leaves and latest reads only; evidence never becomes an answer. */
export function projectEvidence(consumer:CapabilityNode,outputs:Readonly<Record<string,Output>>):{hasB:boolean;text:string;context?:any;bindings:readonly EvidenceBinding[]} {
 const entries=Object.entries(outputs);const hasB=entries.some(([,output])=>output.__bKind==='evidence'&&!isTaskContextNode(output.__bNode));
 if(!hasB)return {hasB:false,text:'',bindings:[]};
 const superseded=supersededEvidenceNodes(entries.flatMap(([,output])=>output.__bNode?[output.__bNode as CapabilityNode]:[]));
 const memory=new Map<string,{producer:string;record:unknown}>();
 const items:{id:string;content:unknown;source?:string}[]=[];
 for(const [id,output]of entries){if(output.__bKind!=='evidence'||superseded.has(id))continue;
  if(Array.isArray(output.items)){for(const item of output.items)items.push({id:`${id}:${item.id}`,content:item.content,source:id});}
  else if(Array.isArray(output.records)){for(const item of output.records){const record=item.memory??item;memory.set(record.id,{producer:id,record});}if(!output.records.length)items.push({id,content:{kind:'memory-search',results:[]},source:id});}
  else {const {__bKind,__bNode,...evidence}=output;items.push({id,content:evidence,source:id});}
 }
 for(const {producer,record}of memory.values())items.push({id:`${producer}:${(record as Output).id}`,content:record,source:producer});
 const bindings=items.map(item=>({sourceNodeId:item.source!,consumerNodeId:consumer.id,contentHash:createHash('sha256').update(JSON.stringify(item.content)).digest('hex')}));
 return {hasB:true,text:`\n\nWorking evidence (public context, task-local memory, and actual tool results; not candidate answers):\n${items.map(item=>`[${item.id}] ${text(item.content)}`).join('\n')}`,context:{id:`b-evidence:${consumer.id}`,items},bindings};
}
