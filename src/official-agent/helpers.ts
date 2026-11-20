import {defineWorker,type WorkerNodes} from '@codesoul-co/ditto/worker';
import {createHash} from 'node:crypto';
import {BindingContractError,ModelOutputFormatError} from '../graph-agent/bindings.js';
import {progressHistory,layeredHistory,type ToolProgressTracker} from './progress.js';
import {automationDecisionAttempt} from './decision-protocol.js';
import {automationReview,automationReviewFeedback} from './automation-review.js';

export const DATA_TRANSFORM_NODE='HOST.DATA.TRANSFORM';
/** Trusted data primitives absent from the official expression language. No Graph/Loop scheduling or executable candidate text. */
export function transformOfficialData(input:any,progress?:ToolProgressTracker):any{
 const value=input?.value;
 switch(input?.operation){
  case'automation-review':return automationReview(input,progress);
  case'automation-review-feedback':return automationReviewFeedback(input);
  case'json':return JSON.stringify(value);
  case'text':return typeof value==='string'?value:JSON.stringify(value);
  case'parse':{
   if(typeof value!=='string')throw new BindingContractError('HOST.DATA.TRANSFORM parse requires string value');
   try{return JSON.parse(value);}catch{
    if(input.sourceKind==='model-json')throw new ModelOutputFormatError('Model did not produce its declared JSON artifact');
    throw new BindingContractError('HOST.DATA.TRANSFORM parse received invalid non-model JSON');
   }
  }
  case'decision':{
   let d:any;try{d=JSON.parse(value);}catch{throw new ModelOutputFormatError('Task-world decision must be strict JSON');}
   if(!d||typeof d!=='object'||typeof d.done!=='boolean'||typeof d.tool!=='string'||!d.arguments||typeof d.arguments!=='object'||Array.isArray(d.arguments))throw new ModelOutputFormatError('Decision requires done:boolean, tool:string and arguments:object');
   if(d.done&&d.tool!==''||!d.done&&(!Array.isArray(input.allowedTools)||!input.allowedTools.includes(d.tool)))throw new ModelOutputFormatError('Decision tool is not a permitted official tool (empty when done)');
   return{done:d.done,tool:d.tool,arguments:d.arguments,finalAnswer:typeof d.finalAnswer==='string'?d.finalAnswer:'End of declared agent execution.'};
  }
  case'decision-attempt':{
   if(!Array.isArray(input.allowedTools)||input.allowedTools.some((tool:unknown)=>typeof tool!=='string'))throw new BindingContractError('Decision attempt requires registered tool names');
   const prior=input.protocolFailures??0,maximum=input.maxProtocolFailures??2;
   if(!Number.isSafeInteger(prior)||prior<0||!Number.isSafeInteger(maximum)||maximum<1||maximum>3)throw new BindingContractError('Invalid protocol recovery budget');
   const result=automationDecisionAttempt(value,input.allowedTools);
   if(!result.valid&&prior>=maximum-1)throw new ModelOutputFormatError('Decision protocol recovery exhausted: '+result.protocol.error!.message);
   return result;
  }
  case'concat':if(!Array.isArray(value)||value.some(v=>v!==null&&typeof v==='object'))throw new BindingContractError('Text concat requires scalar array');return value.map(v=>v==null?'':String(v)).join('');
  case'memory-ids':{const records=Array.isArray(value)?value:value?.items;if(!Array.isArray(records))throw new BindingContractError('Memory ID projection requires records');return records.map((v:any)=>v.id??v.memory?.id);}
  case'coalesce':if(!Array.isArray(value))throw new BindingContractError('Coalesce requires array');return value.find(v=>v!==null&&v!==undefined)??null;
  case'tool-history':case'tool-history-progress':case'tool-history-layered':{
   const decision=input.decision;
   if(!Array.isArray(input.history)||typeof input.evidence!=='string'||!value||typeof value!=='object'||Array.isArray(value)||value.source!==input.tool||!value.message||!['success','failed','cancelled','timeout','unknown'].includes(value.status))throw new BindingContractError('Tool history requires native observation, source-labeled evidence and prior message history');
   if(!decision||decision.done!==false||decision.tool!==input.tool||!decision.arguments||typeof decision.arguments!=='object'||Array.isArray(decision.arguments))throw new BindingContractError('Tool history decision must identify the actually invoked interface and object arguments');
   const executedDecision={done:false,tool:decision.tool,arguments:structuredClone(decision.arguments)};
   if(input.operation==='tool-history-progress')return progressHistory(input,progress);
   if(input.operation==='tool-history-layered')return layeredHistory(input,progress);
   // Tool transport status and business response text are evidence, never task-completion signals.
   return{complete:false,history:[...input.history,{role:'assistant',content:JSON.stringify(executedDecision),metadata:{toolExecutedDecision:true}},{role:'user',content:input.evidence}]};
  }
  case'bfcl-history':{
   // A full public snapshot already contains the revealed conversation and schemas.
   // Retain one such snapshot plus subsequent observations, without selecting any action.
   if(!Array.isArray(input.history)||typeof input.evidence!=='string'||!value||typeof value!=='object')throw new BindingContractError('BFCL history requires public observation, evidence and message history');
   const snapshot=Array.isArray(value.history)&&Array.isArray(value.functions)&&Number.isInteger(value.turn);
   const previous=snapshot?input.history.filter((message:any)=>message.metadata?.bfclObservationError===true):input.history;
   const decision=input.decision;
   if(decision!==undefined&&(!decision||decision.done!==false||decision.tool!==input.tool||!decision.arguments||typeof decision.arguments!=='object'||Array.isArray(decision.arguments)))throw new BindingContractError('BFCL history decision must identify the actually executed interface and object arguments');
   // The next model must see which business function and exact arguments produced each result.
   // The parsed decision's finalAnswer is a host default and is not part of the executed action.
   const executedDecision=decision?{done:false,tool:decision.tool,arguments:structuredClone(decision.arguments)}:undefined;
   const actionSignature=executedDecision?createHash('sha256').update(JSON.stringify(executedDecision)).digest('hex'):undefined;
   const signature=createHash('sha256').update(JSON.stringify(value)).digest('hex');
   const prior=input.history.at(-1)?.metadata?.bfclObservation;
   const reads=input.tool==='bfcl_state'?(prior?.tool==='bfcl_state'&&prior.signature===signature?prior.unchangedReads+1:1):0;
   const repeats=executedDecision?.tool==='bfcl_call'?(prior?.tool==='bfcl_call'&&prior.actionSignature===actionSignature&&prior.signature===signature?(prior.identicalExecutions??1)+1:1):0;
   const feedback=`Actual last executed interface: ${input.tool??'public observation'}.`+(reads?` Consecutive reads of this unchanged public state: ${reads}. This state has already been supplied; reading it again does not reveal another turn or unlock functions. Use the available evidence to choose a useful business call or a truthful current-turn reply.`:'')+(repeats>1?` Consecutive executions of the identical business arguments with the same returned observation: ${repeats}. These were real executions, not cached results. Repeating a write may repeat its effects. Use the actual observation and public schema to decide whether another call is useful; an unchanged error alone is not evidence that repeating it will help.`:'')+(Array.isArray(value.observations)&&value.observations.includes('None')?' Raw observation "None" is preserved. It can be a function\'s no-value return; by itself it proves neither failure nor successful completion of the task. Consult the public schema and, if necessary, a useful available verification operation; do not repeat a write solely to obtain a non-empty return.':'');
   const errorMetadata=value.error?{bfclObservationError:true}:{};
   return {complete:value.complete===true,history:[...previous,...(executedDecision?[{role:'assistant',content:JSON.stringify(executedDecision),metadata:{...errorMetadata,bfclExecutedDecision:true}}]:[]),{role:'user',content:feedback+'\n'+input.evidence,metadata:{...errorMetadata,bfclObservation:{tool:input.tool??'observation',signature,unchangedReads:reads,identicalExecutions:repeats,...(actionSignature?{actionSignature}:{})}}}]};
  }
  case'evidence':return `Evidence supplied by declared upstream nodes (source labels identify origin, not correctness):\nSource: ${JSON.stringify(input.provenance??[])}\nValue:\n${JSON.stringify(value)}`;
  default:throw new BindingContractError('Unknown HOST.DATA.TRANSFORM operation');
 }
}
export function createOfficialDataWorker(progress?:ToolProgressTracker){return defineWorker({type:'host-data',nodes:{[DATA_TRANSFORM_NODE]:async(input:unknown)=>transformOfficialData(input,progress)} as WorkerNodes});}
