import type {BenchmarkTask,EvaluationSummary} from '../domain.js';
import {taskOutputRequirements} from '../benchmark/answer-contract.js';

export interface PromptEvidence {caseId:string;attempt:number;path:string;sha256:string;run:Record<string,any>}
export interface MeasuredPrompt {id:string;parentId:string|null;arm?:'S0'|'S1';evaluation:EvaluationSummary;evidence:readonly PromptEvidence[];provenance?:unknown}
const sensitive=(key:string)=>/secret|password|credential|apikey|authorization/i.test(key)||/^(expected|normalizedexpected|reference|gold|labels?|testsource|assertions?|private.*|finalworld|previousresults|diagnostics)$/i.test(key.replace(/[^a-z0-9]/gi,''));
/** Public runtime values only, with explicit limits at every omitted boundary. */
export function publicValue(value:unknown,budget=6000):unknown{
 let remaining=budget;
 const visit=(v:any,depth:number):any=>{
  if(typeof v==='string'){const text=v.slice(0,Math.max(0,remaining));remaining-=text.length;return{text,originalLength:v.length,truncated:text.length<v.length};}
  if(v===null||typeof v==='boolean'||typeof v==='number')return v;
  if(depth>10||remaining<=0)return{omitted:true,reason:'depth-or-character-limit'};
  if(Array.isArray(v))return{items:v.slice(0,80).map(item=>visit(item,depth+1)),omittedItems:Math.max(0,v.length-80)};
  if(!v||typeof v!=='object')return null;
  const entries=Object.entries(v).filter(([key])=>!sensitive(key));return{fields:Object.fromEntries(entries.slice(0,80).map(([k,x])=>[k,visit(x,depth+1)])),omittedFields:Math.max(0,entries.length-80)};
 };return visit(value,0);
}
function caseVersion(record:MeasuredPrompt|undefined,caseId:string,scale:number){
 const row=record?.evaluation.results.find(r=>r.caseId===caseId),runs=record?.evidence.filter(e=>e.caseId===caseId).slice(-1)??[];
 return{candidateId:record?.id??null,parentId:record?.parentId??null,score:row?.valid?row.score:null,prediction:row?publicValue(row.prediction,Math.floor(3500*scale)):null,predictionMissing:!row,
  evidence:runs.map(e=>({path:e.path,sha256:e.sha256,attempt:e.attempt,caseId:e.caseId,
   causalChain:{order:'newest-first within event/history/response segments',history:publicValue([...(e.run.state?.history?.slice(-4)??[])].reverse(),Math.floor(4000*scale)),modelResponses:publicValue([...(e.run.modelResponses?.slice(-3)??[])].reverse(),Math.floor(2500*scale)),events:publicValue([...(e.run.trace?.slice(-12)??[])].reverse(),Math.floor(4000*scale)),nodeInputs:publicValue(e.run.nodeInputs,Math.floor(2000*scale)),rawNodeOutputs:publicValue(e.run.rawNodeOutputs,Math.floor(2000*scale))},
   events:{original:e.run.trace?.length??0,kept:Math.min(12,e.run.trace?.length??0)},history:{original:e.run.state?.history?.length??0,kept:Math.min(4,e.run.state?.history?.length??0)},modelResponses:{original:e.run.modelResponses?.length??0,kept:Math.min(3,e.run.modelResponses?.length??0)}})),traceMissing:runs.length===0};
}
export function promptFeedback(history:readonly MeasuredPrompt[],tasks:readonly BenchmarkTask[],parentId:string,baselineId:string,rotation:number){
 if(new Set(history.map(r=>r.arm).filter(Boolean)).size>1||history.some(r=>r.evaluation.repeats!==1))throw Error('Feedback must contain one system branch and exploration repeats only');
 const parent=history.find(r=>r.id===parentId),baseline=history.find(r=>r.id===baselineId);if(!parent||!baseline)throw Error('Feedback needs measured parent and baseline');
 const taskMap=new Map(tasks.map(t=>[t.id,t]));
 const summaries=history.map(record=>({id:record.id,parentId:record.parentId,provenance:record.provenance??null,score:record.evaluation.score,valid:record.evaluation.valid,repeats:record.evaluation.repeats,cost:{knownTokens:record.evaluation.totalTokens,usageStatus:record.evaluation.tokenUsageStatus},
  caseColumns:['caseId','valid','score','usageKnown'],cases:record.evaluation.results.map(r=>[r.caseId,r.valid,r.valid?r.score:null,r.usageKnown])}));
 const focus=history.at(-1)!;
 const focusParent=history.find(r=>r.id===focus.parentId)??(focus.parentId===null?baseline:undefined);
 const prior=new Map((focusParent?.evaluation.results??[]).map(r=>[r.caseId,r]));
 const baselineRows=new Map(baseline.evaluation.results.map(r=>[r.caseId,r]));
 const groups={improved:[] as string[],regressed:[] as string[],persistentFailure:[] as string[],successControl:[] as string[]};
 for(const row of focus.evaluation.results){const old=prior.get(row.caseId);if(!old||!row.valid||!old.valid)continue;const delta=row.score-old.score;
  if(delta>1e-12)groups.improved.push(row.caseId);else if(delta< -1e-12)groups.regressed.push(row.caseId);else if(row.score<1)groups.persistentFailure.push(row.caseId);else groups.successControl.push(row.caseId);
 }
 const selected=[...new Set(Object.values(groups).flatMap(ids=>ids.length?[ids.slice().sort()[rotation%ids.length]!]:[]))];
 const examples=selected.map(caseId=>{
  const row=focus.evaluation.results.find(r=>r.caseId===caseId)!,task=taskMap.get(caseId.replace(/#\d+$/,''))!;
  const versions=[...new Map([focus,focusParent,parent,baseline].filter((r):r is MeasuredPrompt=>Boolean(r)).map(r=>[r.id,r])).values()];
  return{caseId,prompt:publicValue(task.prompt,12000),outputRequirements:taskOutputRequirements(task),score:row.score,parentScore:prior.get(caseId)?.score,baselineScore:baselineRows.get(caseId)?.score,
   roles:{focus:focus.id,comparisonParent:focusParent?.id??null,selectedProposalParent:parent.id,baseline:baseline.id},
   versions:versions.map(record=>caseVersion(record,caseId,record.id===focus.id?1:.6)),comparisonParentMissing:focusParent===undefined};
 });
 return{policy:'prompt-feedback-stratified-rotation-v1',scoreInterpretation:'Measured outputs and scores are not gold answers or diagnoses. Missing/truncated evidence stays unknown.',parentId,baselineId,focusId:focus.id,focusParentId:focus.parentId,rotation,allCandidateRows:summaries,groups,selectedCaseIds:selected,examples};
}
