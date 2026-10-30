import {graph,type DittoRuntime} from '@codesoul-co/ditto/runtime';
import type {ModelConfig,NodeResult,SampleOutput} from '@codesoul-co/ditto/worker/infer';
import type {BenchmarkTask,DatasetName,EvaluationSummary} from '../domain.js';
import {GENERATION} from '../protocol.js';
import {SeededRandom} from '../search/random.js';
import {checkAFlowConvergence} from '../search/convergence.js';
import {captureProviderDiagnostics,summarizeProviderDiagnostics} from '../ditto/provider-diagnostics.js';
import {BASELINE_DEFINITION,validateDefinition,validateDefinitionChange,digest,NODE_TYPES,DefinitionError,type DefinitionIssue,type GraphDefinition} from '../graph-agent/schema.js';
import {GRAPH_DEFINITION_GUIDE} from '../graph-agent/search.js';
import {buildUnifiedFeedback,type FeedbackEvaluation} from './feedback.js';
import {UNIFIED_DEFAULTS,UNIFIED_SEARCH_POLICY,comparableTokens} from './policy.js';
import {UNIFIED_OPTIMIZER_SYSTEM,UNIFIED_OPTIMIZER_SYSTEM_SHA256,UNIFIED_PROMPT_VERSION} from './prompts.js';
import {publicAnswerContract,taskOutputRequirements} from '../benchmark/answer-contract.js';

export interface UnifiedEvaluation extends FeedbackEvaluation {}
export interface UnifiedAttempt {
  readonly id:string;
  readonly designRound:number;
  readonly proposalAttempt:number;
  readonly parentId:string|null;
  readonly status:'valid'|'quality-pruned'|'invalid-proposal'|'invalid-evaluation'|'provider-error';
  readonly definition?:GraphDefinition;
  readonly rationale?:string;
  readonly artifactHash?:string;
  readonly evaluation?:UnifiedEvaluation;
  readonly rawResponse?:string;
  readonly publicErrors?:readonly string[];
  readonly publicIssues?:readonly DefinitionIssue[];
}
export interface UnifiedCandidate extends UnifiedAttempt {
  readonly status:'valid'; readonly definition:GraphDefinition; readonly rationale:string;
  readonly artifactHash:string; readonly evaluation:UnifiedEvaluation;
}
export interface UnifiedPending {
  readonly id:string; readonly designRound:number; readonly proposalAttempt:number; readonly parentId:string|null;
  readonly definition:GraphDefinition; readonly rationale:string; readonly artifactHash:string; readonly rawResponse?:string;
}
export interface UnifiedSelection {
  readonly designRound:number; readonly parentId:string; readonly proposalAttempts:number;
  readonly contractRepair?:{readonly rejectedAttemptId:string;readonly definition?:GraphDefinition;readonly rawResponse?:string;readonly errors:readonly string[];readonly issues?:readonly DefinitionIssue[]};
}
export interface UnifiedSearchState {
  readonly schemaVersion:1; readonly policy:string; readonly configurationHash:string; readonly systemPromptSha256:string;
  readonly validEvaluations:number; readonly designRoundsCompleted:number; readonly proposalAttempts:number;
  readonly prunedEvaluations:number; readonly engineeringFailures:number;
  readonly nextAttemptIndex:number; readonly randomState:number;
  readonly optimizerUsage:{readonly providerAttempts:number;readonly failedProviderAttempts:number;readonly unknownUsageAttempts:number;readonly inputTokens:number;readonly outputTokens:number;readonly totalTokens:number};
  readonly history:readonly UnifiedAttempt[];
  readonly selection?:UnifiedSelection; readonly pending?:UnifiedPending;
}
export interface UnifiedSearchOptions {
  readonly runtime:Pick<DittoRuntime,'run'>; readonly model:ModelConfig; readonly dataset:DatasetName;
  readonly publicTasks:readonly BenchmarkTask[]; readonly expectedExamples?:number; readonly expectedRepeats?:number;
  readonly maxValidEvaluations?:number; readonly maxDesignRounds?:number; readonly maxProposalAttempts?:number;
  readonly seed?:number; readonly patience?:number; readonly identity?:string;
  readonly initialDefinition?:GraphDefinition;
  readonly evaluate:(definition:GraphDefinition,id:string,reference?:UnifiedCandidate)=>Promise<UnifiedEvaluation>;
  readonly resume?:UnifiedSearchState;
  readonly save?:(state:UnifiedSearchState)=>void|Promise<void>;
  readonly event?:(event:Readonly<Record<string,unknown>>)=>void|Promise<void>;
}

const proposalGraph=graph<{model:ModelConfig;request:string;id:string}>('unified-declarative-proposal')
  .node('proposal','INFER.REASONING.SAMPLE',[],input=>({model:input.model,generation:GENERATION,
    messages:[{role:'system',content:UNIFIED_OPTIMIZER_SYSTEM},{role:'user',content:input.request}],
    metadata:{experiment:UNIFIED_SEARCH_POLICY,role:'optimizer',candidateId:input.id,systemPromptVersion:UNIFIED_PROMPT_VERSION}}));
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const integer=(value:number,name:string,min=1,max=100000)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid ${name}`);};
const emptyUsage=()=>({providerAttempts:0,failedProviderAttempts:0,unknownUsageAttempts:0,inputTokens:0,outputTokens:0,totalTokens:0});

/** Mutation explanations do not make an otherwise identical executable candidate new. */
export function unifiedArtifactHash(definition:GraphDefinition):string {
  const value=structuredClone(definition) as unknown as Record<string,unknown>;delete value.mutation;
  return digest(value);
}
export function isUnifiedCandidate(value:UnifiedAttempt):value is UnifiedCandidate {
  const evaluation=value.evaluation;
  return value.status==='valid'&&value.definition!==undefined&&evaluation!==undefined&&value.rationale!==undefined&&value.artifactHash!==undefined
    &&evaluation.valid===true&&evaluation.failedRuns===0&&(evaluation.candidateFailureRuns??0)===0
    &&evaluation.results.length===evaluation.examples*evaluation.repeats&&new Set(evaluation.results.map(row=>row.caseId)).size===evaluation.results.length
    &&evaluation.results.every(row=>row.valid===true&&row.error===undefined&&row.candidateFailure===undefined);
}
export function compareUnifiedCandidates(a:UnifiedCandidate,b:UnifiedCandidate):number {
  return b.evaluation.score-a.evaluation.score||comparableTokens(a.evaluation)-comparableTokens(b.evaluation)||a.id.localeCompare(b.id);
}
export function bestUnifiedCandidate(history:readonly UnifiedAttempt[]):UnifiedCandidate|undefined {
  return history.filter(isUnifiedCandidate).sort(compareUnifiedCandidates)[0];
}
export function unifiedParentProbabilities(history:readonly UnifiedAttempt[],topK=4):readonly {id:string;probability:number}[]{
  integer(topK,'topK',1,100);
  const pool=history.filter(isUnifiedCandidate).sort(compareUnifiedCandidates).slice(0,topK);
  if(!pool.length)throw Error('No complete valid parent is available');
  const maximum=pool[0]!.evaluation.score,weights=pool.map(row=>Math.exp(20*(row.evaluation.score-maximum))),total=weights.reduce((sum,value)=>sum+value,0);
  return pool.map((row,index)=>({id:row.id,probability:.3/pool.length+.7*weights[index]!/total}));
}
export function selectUnifiedParent(history:readonly UnifiedAttempt[],random:SeededRandom):UnifiedCandidate {
  const probabilities=unifiedParentProbabilities(history),draw=random.next();let cumulative=0;
  for(const row of probabilities){cumulative+=row.probability;if(draw<=cumulative)return history.find(candidate=>candidate.id===row.id)! as UnifiedCandidate;}
  return history.find(candidate=>candidate.id===probabilities.at(-1)!.id)! as UnifiedCandidate;
}

/** Required task/repeat identities, not only a matching row count, define a full evaluation. */
export function assertUnifiedComplete(evaluation:EvaluationSummary,tasks:readonly BenchmarkTask[],repeats:number):void {
  const expected=new Set(tasks.flatMap(task=>Array.from({length:repeats},(_,index)=>`${task.id}#${index+1}`)));
  if(evaluation.valid!==true||evaluation.examples!==tasks.length||evaluation.repeats!==repeats||evaluation.results.length!==expected.size
    ||evaluation.failedRuns!==0||evaluation.successfulRuns!==expected.size||(evaluation.candidateFailureRuns??0)>0
    ||!Number.isFinite(evaluation.score)||evaluation.score<0||evaluation.score>1||!Number.isFinite(evaluation.standardDeviation)||evaluation.standardDeviation<0)
    throw Error('A complete valid evaluation requires all prescribed tasks and repeats without engineering-invalid cases');
  for(const row of evaluation.results){
    if(!expected.delete(row.caseId)||row.valid!==true||row.error!==undefined||row.candidateFailure!==undefined||!Number.isFinite(row.score)||row.score<0||row.score>1)
      throw Error('Evaluation contains missing, duplicate, unexpected or engineering-invalid task/repeat records');
  }
  const score=evaluation.results.reduce((sum,row)=>sum+row.score,0)/evaluation.results.length;
  if(expected.size||Math.abs(evaluation.score-score)>1e-12)throw Error('Evaluation score does not match its complete case collection');
}
function infrastructure(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const value=error as {infrastructureFailure?:boolean;code?:string;failureKind?:string};
  return value.infrastructureFailure===true||value.code==='SEARCH_BUDGET_EXHAUSTED'||['provider','timeout','judge'].includes(value.failureKind??'');
}
function publicContractError(error:unknown):string {
  const value=error as {publicMessage?:unknown};
  // Host evaluator errors may include private scorer detail; only explicit public messages cross that boundary.
  return typeof value?.publicMessage==='string'?value.publicMessage.slice(0,1600):'Execution/interface validation failed; inspect the saved host diagnostics. Repair the candidate contract, not the benchmark or scorer.';
}

export function parseUnifiedProposal(content:string):{rationale:string;definition:GraphDefinition}{
  let value:Record<string,unknown>;
  try { value=JSON.parse(content.trim()) as Record<string,unknown>; }
  catch (error) {
    const detail=error instanceof Error?error.message:String(error),position=/position (\d+)/.exec(detail);
    const offset=position?Number(position[1]):0,snippet=content.trim().slice(Math.max(0,offset-80),offset+80);
    throw Error(`Invalid proposal JSON: ${detail}. Near ${JSON.stringify(snippet)}. Escape quotes/backslashes/newlines inside strings; return one complete JSON object.`);
  }
  if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['rationale','definition'].includes(key))
    ||typeof value.rationale!=='string'||!value.rationale.trim()||value.rationale.length>8000||!Object.hasOwn(value,'definition'))throw Error('Return exactly rationale and definition');
  const definition=validateDefinition(value.definition);
  if((definition as {version:number}).version!==2)throw Error('Unified candidates must use definition version:2');
  return {rationale:value.rationale,definition};
}

/** One measured parent per design round. Engineering repairs stay in that round and retain all attempts. */
export async function searchUnifiedWorkflows(options:UnifiedSearchOptions):Promise<{
  state:UnifiedSearchState;best:UnifiedCandidate;stoppedBecause:'valid-budget'|'design-budget'|'converged';
}>{
  const maxValid=options.maxValidEvaluations??UNIFIED_DEFAULTS.maxValidEvaluations,maxDesign=options.maxDesignRounds??UNIFIED_DEFAULTS.maxDesignRounds;
  const maxAttempts=options.maxProposalAttempts??UNIFIED_DEFAULTS.maxProposalAttempts,repeats=options.expectedRepeats??UNIFIED_DEFAULTS.validationRepeats;
  const patience=options.patience??UNIFIED_DEFAULTS.patience,seed=options.seed??UNIFIED_DEFAULTS.seed;
  for(const [name,value]of Object.entries({maxValid,maxDesign,maxAttempts,repeats,patience}))integer(value,name);
  integer(seed,'seed',0,0xffffffff);
  if(!options.publicTasks.length||new Set(options.publicTasks.map(task=>task.id)).size!==options.publicTasks.length
    ||options.publicTasks.some(task=>task.dataset!==options.dataset)||options.expectedExamples!==undefined&&options.expectedExamples!==options.publicTasks.length)
    throw Error('Unified search requires the complete unique public task collection for its declared evaluation');
  const baseline=validateDefinition(options.initialDefinition??{...structuredClone(BASELINE_DEFINITION),version:2});
  if((baseline as {version:number}).version!==2)throw Error('Unified baseline must use version:2');
  const configurationHash=digest({policy:UNIFIED_SEARCH_POLICY,system:UNIFIED_OPTIMIZER_SYSTEM_SHA256,identity:options.identity??null,dataset:options.dataset,
    model:options.model,generation:GENERATION,answerContract:publicAnswerContract(options.dataset),taskIds:options.publicTasks.map(task=>task.id),repeats,maxValid,maxDesign,maxAttempts,patience,seed,baseline:unifiedArtifactHash(baseline)});
  const random=new SeededRandom(seed);
  let state:UnifiedSearchState=options.resume?structuredClone(options.resume):{schemaVersion:1,policy:UNIFIED_SEARCH_POLICY,configurationHash,
    systemPromptSha256:UNIFIED_OPTIMIZER_SYSTEM_SHA256,validEvaluations:0,designRoundsCompleted:0,proposalAttempts:0,prunedEvaluations:0,engineeringFailures:0,
    nextAttemptIndex:1,randomState:random.state,optimizerUsage:emptyUsage(),history:[]};
  if(state.schemaVersion!==1||state.policy!==UNIFIED_SEARCH_POLICY||state.configurationHash!==configurationHash||state.systemPromptSha256!==UNIFIED_OPTIMIZER_SYSTEM_SHA256)
    throw Error('Search resume model/data/runtime/prompt/configuration identity differs');
  random.restore(state.randomState);
  if(state.validEvaluations!==state.history.filter(isUnifiedCandidate).length||state.prunedEvaluations!==state.history.filter(row=>row.status==='quality-pruned').length
    ||new Set(state.history.map(row=>row.id)).size!==state.history.length)throw Error('Search checkpoint counters/history disagree');
  for(const candidate of state.history.filter(isUnifiedCandidate)){
    validateDefinition(candidate.definition);if(unifiedArtifactHash(candidate.definition)!==candidate.artifactHash)throw Error('Saved candidate artifact identity changed');
    assertUnifiedComplete(candidate.evaluation,options.publicTasks,repeats);
  }
  const save=async()=>{try{await options.save?.(structuredClone(state));}catch(error){throw Object.assign(error instanceof Error?error:new Error(message(error)),{checkpointFailure:true});}};
  const event=async(value:Readonly<Record<string,unknown>>)=>{try{await options.event?.(value);}catch(error){throw Object.assign(error instanceof Error?error:new Error(message(error)),{checkpointFailure:true});}};
  const nextId=()=>`unified-${String(state.nextAttemptIndex).padStart(4,'0')}`;
  if(!state.history.length&&!state.pending){
    state={...state,pending:{id:nextId(),designRound:0,proposalAttempt:0,parentId:null,definition:baseline,artifactHash:unifiedArtifactHash(baseline),rationale:'Frozen dataset-independent baseline; its complete evaluation counts toward the valid budget.'},nextAttemptIndex:state.nextAttemptIndex+1};
    await save();
  }
  let stoppedBecause:'valid-budget'|'design-budget'|'converged'='valid-budget';
  while(true){
    if(state.pending){
      const pending=state.pending;
      validateDefinition(pending.definition);
      if(unifiedArtifactHash(pending.definition)!==pending.artifactHash)throw Error('Pending artifact identity mismatch');
      if(pending.parentId!==null){const parent=state.history.find(row=>row.id===pending.parentId);if(!parent||!isUnifiedCandidate(parent))throw Error('Pending parent is not a complete valid candidate');validateDefinitionChange(JSON.stringify(parent.definition),JSON.stringify(pending.definition));}
      let evaluation:UnifiedEvaluation|undefined;
      try{
        const reference=bestUnifiedCandidate(state.history);
        evaluation=await options.evaluate(pending.definition,pending.id,reference);
        if(evaluation.qualityPruned){
          if(pending.designRound===0||evaluation.valid!==true||evaluation.examples>=options.publicTasks.length)throw Error('A baseline/full or engineering-invalid evaluation cannot be quality-pruned');
          assertUnifiedComplete(evaluation,options.publicTasks.slice(0,evaluation.examples),repeats);
          const attempt:UnifiedAttempt={...pending,status:'quality-pruned',evaluation};
          const {pending:_pending,selection:_selection,...rest}=state;
          state={...rest,history:[...state.history,attempt],prunedEvaluations:state.prunedEvaluations+1,designRoundsCompleted:pending.designRound};
          await save();await event({type:'unified-quality-pruned',attempt});continue;
        }
        assertUnifiedComplete(evaluation,options.publicTasks,repeats);
        const attempt:UnifiedCandidate={...pending,status:'valid',evaluation};
        const {pending:_pending,selection:_selection,...rest}=state;
        state={...rest,history:[...state.history,attempt],validEvaluations:state.validEvaluations+1,designRoundsCompleted:Math.max(state.designRoundsCompleted,pending.designRound)};
        await save();await event({type:'unified-evaluation-completed',attempt,validEvaluations:state.validEvaluations});continue;
      }catch(error){
        if((error as {checkpointFailure?:boolean})?.checkpointFailure)throw error;
        if(infrastructure(error)){await save();await event({type:'unified-evaluation-interrupted',id:pending.id,artifactHash:pending.artifactHash});throw error;}
        const publicError=evaluation?.engineeringIssues?.map(issue=>`${issue.code}: ${issue.message}`).join('\n')||publicContractError(error);
        const publicIssue=(error as {publicIssue?:DefinitionIssue}).publicIssue??{code:'B_EXECUTION_CONTRACT',path:'workflow',message:publicError,repairHint:'Repair the indicated public workflow interface; never change the benchmark or scorer.'};
        const attempt:UnifiedAttempt={...pending,status:'invalid-evaluation',...(evaluation?{evaluation}:{}),publicErrors:[publicError],publicIssues:[publicIssue]};
        const {pending:_pending,...rest}=state;
        const selection=state.selection;
        state={...rest,history:[...state.history,attempt],engineeringFailures:state.engineeringFailures+1,
          ...(selection?{selection:{...selection,contractRepair:{rejectedAttemptId:pending.id,definition:pending.definition,
            ...(pending.rawResponse!==undefined?{rawResponse:pending.rawResponse}:{}),errors:[...new Set([...(selection.contractRepair?.errors??[]),publicError])],issues:[...(selection.contractRepair?.issues??[]),publicIssue]}}}:{})};
        await save();await event({type:'unified-evaluation-invalid',attempt});
        if(pending.designRound===0)throw Error('Frozen baseline evaluation is engineering-invalid; no valid parent can be fabricated');
        continue;
      }
    }
    if(state.validEvaluations>=maxValid){stoppedBecause='valid-budget';break;}
    const complete=state.history.filter(isUnifiedCandidate);
    if(!state.selection&&checkAFlowConvergence(complete.map(row=>row.evaluation),3,0,patience).converged){stoppedBecause='converged';break;}
    if(!state.selection&&state.designRoundsCompleted>=maxDesign){stoppedBecause='design-budget';break;}
    if(!state.selection){
      const parent=selectUnifiedParent(state.history,random);
      state={...state,selection:{designRound:state.designRoundsCompleted+1,parentId:parent.id,proposalAttempts:0},randomState:random.state};
      await save();await event({type:'unified-parent-selected',designRound:state.selection!.designRound,parentId:parent.id,probabilities:unifiedParentProbabilities(state.history)});
    }
    const selection=state.selection!;
    if(selection.proposalAttempts>=maxAttempts){
      const {selection:_selection,...rest}=state;state={...rest,designRoundsCompleted:selection.designRound};
      await save();await event({type:'unified-design-skipped',designRound:selection.designRound,parentId:selection.parentId,reason:'bounded-engineering-repairs-exhausted'});continue;
    }
    const parent=state.history.find(row=>row.id===selection.parentId);
    if(!parent||!isUnifiedCandidate(parent))throw Error('Selected parent lacks complete valid measurement');
    const id=nextId(),proposalAttempt=selection.proposalAttempts+1;
    state={...state,nextAttemptIndex:state.nextAttemptIndex+1,proposalAttempts:state.proposalAttempts+1,selection:{...selection,proposalAttempts:proposalAttempt}};
    const request=JSON.stringify({mode:selection.contractRepair?'ENGINEERING REPAIR':'QUALITY SEARCH',dataset:options.dataset,
      parent:{id:parent.id,definition:parent.definition,score:parent.evaluation.score,totalTokens:parent.evaluation.totalTokens},
      immutableProtocol:{policy:UNIFIED_SEARCH_POLICY,repeats,fullExamples:options.publicTasks.length,systemVersion:UNIFIED_PROMPT_VERSION,
        systemPromptSha256:UNIFIED_OPTIMIZER_SYSTEM_SHA256,publicAnswerContract:publicAnswerContract(options.dataset),capabilities:NODE_TYPES,remainingValidBudget:maxValid-state.validEvaluations,
        mutationLimits:{mainChange:1,auxiliary:'necessary connected predecessors/successors only',maxDeclaredNodes:24,maxExistingContentChanges:5,maxToolChanges:1,
          dependencyEdgeEdits:'max(12,4*N), N=max(parent,child nodes); reversal costs two'}},
      interfaceGuide:GRAPH_DEFINITION_GUIDE,
      authorizedRetrievalTargets:[{name:'task-public',scope:'only this task public input; never other tasks, labels, confirmation or Test'}],
      publicTaskExamples:options.publicTasks.slice(0,2).map(task=>({id:task.id,prompt:task.prompt,outputInstruction:taskOutputRequirements(task)})),
      history:state.history.map(row=>({id:row.id,parentId:row.parentId,status:row.status,...(row.rationale?{rationale:row.rationale.slice(0,1000)}:{}),
        ...(isUnifiedCandidate(row)?{score:row.evaluation.score,totalTokens:row.evaluation.totalTokens}:{}),...(row.status==='quality-pruned'?{stage:row.evaluation?.examples}:{}),})),
      measuredFeedback:buildUnifiedFeedback(state.history,options.publicTasks),
      ...(selection.contractRepair?{contractRepair:selection.contractRepair}:{}),});
    await save();await event({type:'unified-proposal-request',id,designRound:selection.designRound,proposalAttempt,systemPrompt:UNIFIED_OPTIMIZER_SYSTEM,request});
    let rawResponse:string|undefined,definition:GraphDefinition|undefined,rationale:string|undefined;
    let records:Parameters<typeof summarizeProviderDiagnostics>[0]=[];
    try{
      let sampled:NodeResult<SampleOutput>;
      try{
        const output=await captureProviderDiagnostics(async observed=>{records=observed;return options.runtime.run(proposalGraph,{model:options.model,request,id});});
        sampled=output.proposal as NodeResult<SampleOutput>;
      }finally{
        const usage=summarizeProviderDiagnostics(records),aggregate={...state.optimizerUsage};
        for(const key of Object.keys(aggregate)as(keyof typeof aggregate)[])aggregate[key]+=usage[key];
        state={...state,optimizerUsage:aggregate};await save();
      }
      if(sampled.status!=='success'||!sampled.output)throw Object.assign(Error('Optimizer provider did not return a complete proposal'),{infrastructureFailure:true});
      rawResponse=typeof sampled.output.message.content==='string'?sampled.output.message.content:JSON.stringify(sampled.output.message.content);
      const parsed=parseUnifiedProposal(rawResponse);definition=parsed.definition;rationale=parsed.rationale;
      validateDefinitionChange(JSON.stringify(parent.definition),JSON.stringify(definition));
      const artifactHash=unifiedArtifactHash(definition);
      if(state.history.some(row=>row.artifactHash===artifactHash&&row.status!=='provider-error'))throw Error('Duplicate artifact; changing rationale or mutation metadata does not create a new workflow');
      state={...state,pending:{id,designRound:selection.designRound,proposalAttempt,parentId:parent.id,definition,rationale,artifactHash,rawResponse}};
      await save();await event({type:'unified-candidate-proposed',pending:state.pending});
    }catch(error){
      if((error as {checkpointFailure?:boolean})?.checkpointFailure)throw error;
      const isInfrastructure=infrastructure(error),publicError=isInfrastructure?'Optimizer infrastructure interrupted the proposal; preserve its intended definition.':message(error).slice(0,1600);
      const publicIssue:DefinitionIssue=error instanceof DefinitionError?error.issue:{code:'B_PROPOSAL_CONTRACT',path:'proposal',message:publicError,repairHint:'Return a complete valid JSON proposal with the documented fields; use the specific error and retain the intended mechanism.'};
      const attempt:UnifiedAttempt={id,designRound:selection.designRound,proposalAttempt,parentId:parent.id,status:isInfrastructure?'provider-error':'invalid-proposal',
        ...(rawResponse!==undefined?{rawResponse}:{}),...(definition?{definition,artifactHash:unifiedArtifactHash(definition)}:{}),...(rationale?{rationale}:{}),publicErrors:[publicError],...(!isInfrastructure?{publicIssues:[publicIssue]}:{})};
      state={...state,history:[...state.history,attempt],engineeringFailures:state.engineeringFailures+(isInfrastructure?0:1),selection:{...state.selection!,
        ...(!isInfrastructure?{contractRepair:{rejectedAttemptId:id,...(definition?{definition}:{}),...(rawResponse!==undefined?{rawResponse}:{}),
          errors:[...new Set([...(state.selection?.contractRepair?.errors??[]),publicError])],issues:[...(state.selection?.contractRepair?.issues??[]),publicIssue]}}:{})}};
      await save();await event({type:'unified-proposal-rejected',attempt});if(isInfrastructure)throw error;
    }
  }
  const best=bestUnifiedCandidate(state.history);if(!best)throw Error('No complete valid candidate is available');
  return {state,best,stoppedBecause};
}
