import type {AgentRunResult,BenchmarkTask,CaseResult,EvaluationSummary} from '../domain.js';
import type {LoadedBenchmark,BenchmarkEvaluationOptions} from '../benchmark/types.js';
import type {TimeBudgetPolicy} from '../execution/time-budget.js';
import type {DefinitionIssue,GraphDefinition} from '../graph-agent/schema.js';
import {pairedRegressionDecision,unifiedStages} from './policy.js';
import type {UnifiedCandidate,UnifiedEvaluation} from './search.js';
import {UnifiedRunStore,artifactHash,caseFile} from './store.js';

export interface UnifiedEvaluationOptions{
 readonly benchmark:LoadedBenchmark;readonly definition:GraphDefinition;readonly id:string;
 readonly reference?:UnifiedCandidate;readonly store:UnifiedRunStore;readonly executionIdentity:unknown;
 readonly repeats:number;readonly concurrency:number;readonly retryAttempts?:number;readonly timeBudget?:TimeBudgetPolicy;
 readonly prune?:boolean;readonly resume?:boolean;
 readonly runTask:(definition:GraphDefinition,task:BenchmarkTask)=>Promise<AgentRunResult>;
 readonly onEvent?:(event:Readonly<Record<string,unknown>>)=>void|Promise<void>;
}
interface EvaluationCheckpoint{readonly identity:string;readonly cases:readonly CaseResult[];readonly complete?:UnifiedEvaluation;}

/** Cases with invalid execution never become placeholder zero quality observations. */
export class UnifiedEvaluationError extends Error{
 readonly infrastructureFailure:boolean;
 readonly failureKind:string;
 readonly code:string;
 readonly publicMessage:string;
 readonly publicIssue:DefinitionIssue;
 constructor(message:string,row:CaseResult,original?:unknown){
  super(message,{cause:original});this.name='UnifiedEvaluationError';
  this.failureKind=row.failureKind??'execution';
  this.code=String((original as {code?:unknown}|undefined)?.code??'UNIFIED_ENGINEERING_FAILURE');
  this.infrastructureFailure=['provider','timeout','judge'].includes(this.failureKind)||this.code==='SEARCH_BUDGET_EXHAUSTED';
  const publicText=(original as {publicMessage?:unknown}|undefined)?.publicMessage;
  this.publicMessage=!this.infrastructureFailure&&typeof publicText==='string'?publicText:'Public workflow interface validation failed; consult the retained host diagnostics. No benchmark answer or private scorer detail is supplied.';
  const issue=(original as {publicIssue?:DefinitionIssue}|undefined)?.publicIssue;
  this.publicIssue=issue&&typeof publicText==='string'?{code:issue.code,path:issue.path,message:this.publicMessage,repairHint:issue.repairHint}:{code:this.code,path:'workflow',message:this.publicMessage,repairHint:'Repair the public workflow contract; inspect retained host diagnostics without requesting private scorer data.'};
 }
}

/** One frozen artifact, nested public task prefixes, all declared repeats per prefix. */
export async function evaluateUnifiedCandidate(options:UnifiedEvaluationOptions):Promise<UnifiedEvaluation>{
 const {benchmark,definition,id,store}=options;
 if(!Number.isSafeInteger(options.repeats)||options.repeats<1)throw Error('Invalid repeat count');
 if(!benchmark.tasks.length)throw Error('Cannot evaluate an empty benchmark');
 if(options.prune&&benchmark.split!=='validate')throw Error('Quality pruning is forbidden on Test');
 const identity=artifactHash({definition,executionIdentity:options.executionIdentity,data:benchmark.identity,ids:benchmark.tasks.map(t=>t.id),repeats:options.repeats});
 const prefix='evaluations/'+id;
 const saved=options.resume?await store.optional<EvaluationCheckpoint>(prefix+'/checkpoint.json'):undefined;
 if(saved&&saved.identity!==identity)throw Error('Candidate/data/prompt/runtime identity differs; cached cases cannot be reused');
 if(saved?.complete)return saved.complete;
 const cases=new Map<string,CaseResult>((saved?.cases??[]).map(row=>[row.caseId,row]));
 const failures=new Map<string,unknown>();
 const publicTraces:unknown[]=options.resume?[...await store.lines<unknown>(prefix+'/public-traces.jsonl')]:[];
 const persist=()=>store.write(prefix+'/checkpoint.json',{identity,cases:[...cases.values()]});
 await store.write('candidates/'+id+'.json',{definition,artifactHash:artifactHash(definition),evaluationIdentity:identity});
 const runner=async(task:BenchmarkTask):Promise<AgentRunResult>=>{
  try{
   const result=await options.runTask(definition,task);
   const record=result as AgentRunResult&{trace?:unknown;nodeInputs?:unknown;rawNodeOutputs?:unknown;reflectionResponses?:unknown;modelFailure?:unknown};
   const trace={taskId:task.id,events:record.trace??[],nodeInputs:record.nodeInputs,rawNodeOutputs:record.rawNodeOutputs,modelFailure:record.modelFailure};
   publicTraces.push(trace);
   await store.append(prefix+'/public-traces.jsonl',trace);
   await store.append(prefix+'/executions/'+caseFile(task.id)+'.jsonl',{taskId:task.id,...result});
   return result;
  }catch(error){
   failures.set(task.id,error);
   await store.append(prefix+'/execution-errors.jsonl',{taskId:task.id,error:error instanceof Error?error.message:String(error),code:(error as {code?:unknown})?.code,
    partialRun:(error as {partialRun?:unknown})?.partialRun});
   throw error;
  }
 };
 const onCase:NonNullable<BenchmarkEvaluationOptions['onCase']>=async progress=>{
  cases.set(progress.result.caseId,progress.result);await persist();
  await store.append(prefix+'/case-events.jsonl',progress.result);
  await options.onEvent?.({type:'case-completed',candidateId:id,caseId:progress.result.caseId,completed:progress.completed,total:progress.total,valid:progress.result.valid,score:progress.result.valid?progress.result.score:null});
  if(progress.result.valid!==true||progress.result.error!==undefined){
   const taskId=progress.result.caseId.replace(/#[1-9]\d*$/,'');
   throw new UnifiedEvaluationError(progress.result.error??'Invalid execution measurement',progress.result,failures.get(taskId));
  }
 };
 const common:BenchmarkEvaluationOptions={repeats:options.repeats,concurrency:options.concurrency,retryAttempts:options.retryAttempts??5,onCase,...(options.timeBudget?{timeBudget:options.timeBudget}:{})};
 const subset=(ids:readonly string[],evalOptions:BenchmarkEvaluationOptions):Promise<EvaluationSummary>=>{
  if(benchmark.evaluateSearchSubset)return benchmark.evaluateSearchSubset(ids,runner,evalOptions);
  if(ids.length===benchmark.tasks.length&&ids.every((value,index)=>value===benchmark.tasks[index]!.id))return benchmark.evaluate(runner,evalOptions);
  throw Error('Benchmark adapter lacks validation-only subset support');
 };
 // The dynamic interface probe is the same paid first case, not an extra quality vote.
 if(benchmark.split==='validate'){
  const firstId=benchmark.tasks[0]!.id;
  const first=await subset([firstId],{...common,repeats:1,concurrency:1,priorCases:[...cases.values()]});
  for(const row of first.results)cases.set(row.caseId,row);
  await options.onEvent?.({type:'interface-preflight-completed',candidateId:id,caseId:firstId+'#1',reusedInEvaluation:true});
 }
 const stages=options.prune&&options.reference?unifiedStages(benchmark.tasks.length):[benchmark.tasks.length];
 let latest:EvaluationSummary|undefined;
 for(const stage of stages){
  const ids=benchmark.tasks.slice(0,stage).map(task=>task.id);
  latest=benchmark.split==='test'?await benchmark.evaluate(runner,{...common,priorCases:[...cases.values()]}):await subset(ids,{...common,priorCases:[...cases.values()]});
  for(const row of latest.results)cases.set(row.caseId,row);
  if(latest.valid!==true||latest.results.length!==stage*options.repeats)throw Error('Incomplete or invalid stage cannot enter quality selection');
  const decision=pairedRegressionDecision(latest,options.reference?.evaluation,stage,benchmark.tasks.length);
  await store.write(prefix+'/stage-'+stage+'.json',{stage,...decision,score:latest.score,repeats:options.repeats,referenceId:options.reference?.id??null});
  await options.onEvent?.({type:'stage-completed',candidateId:id,stage,score:latest.score,repeats:options.repeats,...decision});
  if(!decision.advance&&decision.reason==='large-paired-regression'){
   const summary:UnifiedEvaluation={...latest,qualityPruned:true,stage,publicTraces:publicTraces as NonNullable<UnifiedEvaluation['publicTraces']>};
   await store.write(prefix+'/summary.json',summary);await store.write(prefix+'/checkpoint.json',{identity,cases:[...cases.values()],complete:summary});return summary;
  }
 }
 if(!latest)throw Error('No completed evaluation stage');
 const summary:UnifiedEvaluation={...latest,stage:benchmark.tasks.length,publicTraces:publicTraces as NonNullable<UnifiedEvaluation['publicTraces']>};
 await store.write(prefix+'/summary.json',summary);await store.write(prefix+'/checkpoint.json',{identity,cases:[...cases.values()],complete:summary});return summary;
}
