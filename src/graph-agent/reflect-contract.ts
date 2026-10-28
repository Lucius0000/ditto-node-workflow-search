import type {ModelProvider,SampleOutput} from '@codesoul-co/ditto/worker/infer';
import {validateReflectionResponse} from '../ditto/reflection-schema.js';
import {normalizeReflectionResponse} from '../ditto/reflection-normalization.js';
import {REFLECTION_SYSTEM_CONTRACT} from './system.js';

export const AGENT_REFLECTION_CONTRACT='agent-known-target-preservation-v1';
export interface AgentReflectionResponse {
 nodeId:string;mode:string;rawContent:SampleOutput['message']['content'];finishReason:SampleOutput['finishReason'];
 preservedKnownTarget:boolean;source?:'input.target.result';
}
/** Application no-change selection, separate from format repair. Never infer an unknown answer. */
export function graphAgentReflectionProvider(provider:ModelProvider){
 const responses:AgentReflectionResponse[]=[],preservedNodes=new Set<string>();
 const wrapped:ModelProvider={async invoke(input,options){
  if(input.metadata?.nodeType!=='INFER.REASONING.REFLECT')return provider.invoke(input,options);
  const payload=JSON.parse(String(input.messages.at(-1)?.content));
  const nodeId=String(input.metadata.nodeId??'reflection');preservedNodes.delete(nodeId);
  const response=await provider.invoke({...input,messages:[input.messages[0]!,{role:'system',content:REFLECTION_SYSTEM_CONTRACT},...input.messages.slice(1)]},options);
  let content=response.message.content,preservedKnownTarget=false;
  if(response.finishReason==='stop'&&payload.mode==='revise'&&typeof content==='string'){
   try{
    // Verification must validate every supplied substantive field, and reject duplicate JSON keys.
    const parsed=JSON.parse(content);
    const target=payload.target?.result;
    if(parsed.revisedResult===undefined&&parsed.assessment?.passed===true&&Array.isArray(parsed.issues)
      &&!parsed.issues.some((issue:any)=>issue.severity==='error')&&target?.role==='assistant'&&typeof target.content==='string'){
     validateReflectionResponse(content,'verify');
     normalizeReflectionResponse(content,'verify'); // Includes duplicate-key rejection.
     content=JSON.stringify({...parsed,revisedResult:target});preservedKnownTarget=true;preservedNodes.add(nodeId);
    }
   }catch{/* Leave malformed, failed, incomplete or ambiguous responses to the strict native adapter. */}
  }
  responses.push({nodeId,mode:String(payload.mode),rawContent:response.message.content,finishReason:response.finishReason,preservedKnownTarget,
   ...(preservedKnownTarget?{source:'input.target.result' as const}:{})});
  return preservedKnownTarget?{...response,message:{...response.message,content}}:response;
 }};
 return {provider:wrapped,responses,preservedNodes};
}
