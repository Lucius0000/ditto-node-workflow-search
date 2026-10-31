import type {DatasetName} from '../domain.js';
import type {GraphDefinition} from '../graph-agent/schema.js';
import type {ExperimentRuntime} from '../ditto/runtime.js';
import {currentTimeBudgetSignal,withWorkflowTimeBudget} from '../execution/time-budget.js';
import {GENERATION} from '../protocol.js';
import {UnifiedRunStore,artifactHash} from '../unified/store.js';
import {PROMPT_PROTOCOL,PROMPT_GUIDE,SYSTEMS,editablePaths,immutableProjection,parsePromptProposal,validateTaskIdRules,strategyHash,type SystemArm} from './contract.js';
import {dispatchContext} from './dispatch.js';

export async function proposePrompt(options:{runtime:ExperimentRuntime;store:UnifiedRunStore;dataset:DatasetName;arm:SystemArm;id:string;parentId:string;parent:GraphDefinition;feedback:unknown;knownHashes:readonly string[];publicTaskIds?:readonly string[]}){
 const {runtime,store,id,parent,dataset,arm}=options,path='proposals/'+id+'.json';
 const binding=artifactHash({parent,dataset,arm,parentId:options.parentId,feedback:options.feedback,knownHashes:options.knownHashes,publicTaskIds:options.publicTaskIds??[]});
 const saved=await store.optional<any>(path);if(saved&&saved.binding!==binding)throw Error('Proposal parent/feedback/system identity differs');if(saved?.complete)return saved.complete as {definition:GraphDefinition;rationale:string};
 // A restarted in-flight proposal cannot safely invent its missing response. It remains a bounded failed proposal.
 if(saved?.inFlight)throw Error('Interrupted proposal request retained; use the next bounded independent proposal identity');
 const state=saved??{binding,startedAt:Date.now(),calls:0,errors:[],messages:[]};
 const remaining=300000-(Date.now()-state.startedAt);if(remaining<=0)throw Error('Cumulative optimizer proposal deadline exhausted');
 return withWorkflowTimeBudget({requestMs:180000,workflowMs:remaining},async()=>{
  const payload={protocol:PROMPT_PROTOCOL,dataset,parent:{id:options.parentId,definition:parent},editableText:{paths:editablePaths(dataset),immutableProjection:immutableProjection(parent,editablePaths(dataset))},interfaceGuide:PROMPT_GUIDE,measuredPublicFeedback:options.feedback,
   evaluation:{fullSearch:true,repeats:1,scope:'exploration-only',maxFormatRepairs:2},systemVersion:'prompt-only-'+arm.toLowerCase()+'-v1'};
  if(!state.messages.length)state.messages=[{role:'system',content:SYSTEMS[arm].text},{role:'user',content:JSON.stringify(payload)}];
  while(state.calls<3){
   state.calls++;state.inFlight=true;await store.write(path,state);
   const output=await dispatchContext.run({role:'optimizer',dataset,arm,proposalId:id,parentId:options.parentId,proposalCall:state.calls},()=>runtime.provider.invoke({model:{provider:runtime.providerName,model:runtime.model},generation:GENERATION,messages:state.messages,metadata:{role:'optimizer',proposalId:id,systemArm:arm}},{signal:currentTimeBudgetSignal()!}));
   state.inFlight=false;const content=output.message.content;await store.append('optimizer-events.jsonl',{at:new Date().toISOString(),id,arm,dataset,call:state.calls,input:state.messages,output});
   try{
    if(output.finishReason!=='stop'||typeof content!=='string')throw Error('Proposal requires complete text JSON');
    const parsed=parsePromptProposal(content,parent,dataset);validateTaskIdRules(parsed.definition,dataset,options.publicTaskIds??[]);if(options.knownHashes.includes(strategyHash(parsed.definition)))throw Error('Duplicate previously measured/proposed strategy');
    state.complete=parsed;await store.write(path,state);return parsed;
   }catch(error){state.errors.push(String(error));state.messages.push({role:'assistant',content:typeof content==='string'?content:JSON.stringify(content)},{role:'user',content:'Format/scope correction only. Preserve the intended mechanism and all unlisted fields. Public rejection: '+String(error)});await store.write(path,state);}
  }
  throw Error('Bounded optimizer format/scope attempts exhausted');
 });
}
