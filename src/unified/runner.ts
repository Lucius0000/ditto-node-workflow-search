import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {loadProviderSettings} from '../config.js';
import {loadBenchmark,DockerPythonJudge} from '../benchmark/index.js';
import {fixedSplitLock} from '../benchmark/fixed-splits.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {validateDefinition,BASELINE_DEFINITION,type GraphDefinition} from '../graph-agent/schema.js';
import {NODE_SYSTEM_PROMPTS,NODE_SYSTEM_PROMPT_SHA256} from '../graph-agent/system.js';
import {evaluationRuntimeIdentity,assertEvaluationRuntimeIdentity} from '../run/case-recovery.js';
import {GENERATION,PROTOCOL} from '../protocol.js';
import {validateTimeBudget,type TimeBudgetPolicy} from '../execution/time-budget.js';
import type {DatasetName} from '../domain.js';
import type {LoadedBenchmark} from '../benchmark/types.js';
import {searchUnifiedWorkflows,type UnifiedSearchState,type UnifiedCandidate} from './search.js';
import {UNIFIED_SYSTEM_PROMPT,UNIFIED_SYSTEM_PROMPT_SHA256} from './prompts.js';
import {createProviderBudget,type ProviderBudgetSnapshot} from './provider-budget.js';
import {UnifiedRunStore,artifactHash} from './store.js';
import {evaluateUnifiedCandidate} from './evaluation.js';

export const UNIFIED_FORMAL_PROTOCOL='ditto-declarative-staged-main-splits-v1';
export interface UnifiedCLIOptions{
 readonly command:'search'|'test';readonly dataset:DatasetName;readonly projectRoot:string;
 readonly dataDir:string;readonly outputDir?:string;readonly runDir?:string;readonly userPromptFile?:string;readonly resume:boolean;readonly offlineOnly:boolean;
 readonly maxValidEvaluations:number;readonly maxDesignRounds:number;readonly maxProposalAttempts:number;readonly seed:number;
 readonly concurrency:number;readonly maxCalls:number;readonly maxTokens:number;readonly requestMs:number|null;readonly workflowMs:number|null;
 readonly dockerImage:string;
}
interface FrozenSelection{
 readonly schemaVersion:1;readonly selectedBeforeTest:true;readonly id:string;readonly definition:GraphDefinition;readonly artifactHash:string;
 readonly executionIdentity:Awaited<ReturnType<typeof evaluationRuntimeIdentity>>;readonly promptHash:string;
 readonly model:string;readonly endpoint:string;readonly generation:typeof GENERATION;readonly dataset:DatasetName;readonly protocol:string;
}

export function providerEnvironment(projectRoot:string):Readonly<Record<string,string>>{
 const python=process.env.DITTO_PROVIDER_PYTHON?.trim()||'python';
 const environment=JSON.parse(execFileSync(python,['-c','import sys,openai,httpx,json;print(json.dumps({"pythonExecutable":sys.executable,"pythonVersion":sys.version.split()[0],"openaiVersion":openai.__version__,"httpxVersion":httpx.__version__}))'],{encoding:'utf8',windowsHide:true})) as Record<string,string>;
 if(environment.openaiVersion!=='2.14.0'||environment.httpxVersion!=='0.28.1')throw Error('Install requirements-provider.txt in DITTO_PROVIDER_PYTHON before this protocol runs');
 const pkg=JSON.parse(execFileSync(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync('node_modules/@codesoul-co/ditto/package.json','utf8'))"],{cwd:projectRoot,encoding:'utf8',windowsHide:true})) as {version:string};
 return {...environment,nodeVersion:process.version,dittoVersion:pkg.version};
}

/** Search and Test use different directories and never send Test observations to the optimizer. */
export async function runUnifiedExperiment(options:UnifiedCLIOptions):Promise<void>{
 const root=resolve(options.projectRoot);
 const settings={...loadProviderSettings(options.offlineOnly?{...process.env,CODE_SOUL_API_KEY:'offline-not-invoked'}:process.env),concurrency:options.concurrency};
 const environment=providerEnvironment(root);
 const executionIdentity=await evaluationRuntimeIdentity(root,environment);
 const timeBudget=validateTimeBudget({requestMs:options.requestMs,workflowMs:options.workflowMs,reason:'Explicit main-compatible formal policy; no aggregate workflow deadline unless configured'});
 const sourceDirectory=options.command==='test'?resolve(options.runDir!):options.resume?resolve(options.runDir!):resolve(options.outputDir??join(root,'runs','unified',options.dataset,new Date().toISOString().replace(/[:.]/g,'-')));
 const store=new UnifiedRunStore(options.command==='test'?join(sourceDirectory,'test'):sourceDirectory);
 const sourceStore=new UnifiedRunStore(sourceDirectory);
 let frozen:FrozenSelection|undefined;
 if(options.command==='test'){
  frozen=await sourceStore.read<FrozenSelection>('frozen-selection.json');
  if(!frozen.selectedBeforeTest||frozen.dataset!==options.dataset||frozen.protocol!==UNIFIED_FORMAL_PROTOCOL)throw Error('Test requires a matching frozen unified Search candidate');
  assertEvaluationRuntimeIdentity(frozen.executionIdentity,executionIdentity);
  if(frozen.promptHash!==UNIFIED_SYSTEM_PROMPT_SHA256||frozen.model!==settings.model||frozen.endpoint!==settings.baseUrl||JSON.stringify(frozen.generation)!==JSON.stringify(GENERATION)||frozen.artifactHash!==artifactHash(frozen.definition))throw Error('Frozen candidate/model/prompt identity differs');
  validateDefinition(frozen.definition);
 }
 const previousManifest=await store.optional<Record<string,unknown>>('manifest.json');
 if(previousManifest&&!options.resume)throw Error('Run directory exists; use --resume true or a new --output-dir');
 if(options.resume&&!previousManifest)throw Error('Cannot resume a run without its frozen manifest');
 const previousUser=options.resume?await store.optional<{text:string}>('prompts/initial-user.json'):undefined;
 const initialUser=options.userPromptFile?await readFile(options.userPromptFile,'utf8'):previousUser?.text;
 if(initialUser!==undefined&&(!initialUser.trim()||initialUser.length>8000))throw Error('User prompt file must contain 1..8000 characters');
 const initialDefinition=structuredClone(BASELINE_DEFINITION);
 if(initialUser!==undefined){const solver=initialDefinition.graphs.flatMap(graph=>graph.nodes).find(node=>node.type==='INFER.REASONING.SAMPLE');if(!solver)throw Error('Baseline lacks SAMPLE');solver.config.instruction=initialUser;}
 const benchmark=await loadBenchmark(options.dataset,{dataDir:options.dataDir,split:options.command==='search'?'validate':'test',dataMode:'formal',limit:0,
  ...(options.dataset==='humaneval'||options.dataset==='mbpp'?{codeJudge:new DockerPythonJudge({image:options.dockerImage})}:{})});
 if(!benchmark.identity?.verified||benchmark.tasks.length!==fixedSplitLock(options.dataset,benchmark.split).count)throw Error('Unified formal evaluation requires the complete pinned split');
 const repeats=options.command==='search'?5:3;
 const identity={protocol:UNIFIED_FORMAL_PROTOCOL,executionIdentity,promptHash:UNIFIED_SYSTEM_PROMPT_SHA256,nodeSystemHash:NODE_SYSTEM_PROMPT_SHA256,initialDefinitionHash:options.command==='search'?artifactHash(initialDefinition):null,model:settings.model,endpoint:settings.baseUrl,generation:GENERATION,
  dataset:options.dataset,split:benchmark.split,data:benchmark.identity,taskIds:benchmark.tasks.map(task=>task.id),repeats,timeBudget,
  maxValidEvaluations:options.maxValidEvaluations,maxDesignRounds:options.maxDesignRounds,maxProposalAttempts:options.maxProposalAttempts,seed:options.seed,
  concurrency:options.concurrency,maxCalls:options.maxCalls,maxTokens:options.maxTokens,dockerImage:options.dockerImage};
 if(previousManifest&&artifactHash(previousManifest.identity)!==artifactHash(identity))throw Error('Resume data/runtime/prompt/model/repeat/resource identity differs');
 const manifest:Record<string,unknown>={schemaVersion:1,experiment:'Ditto unified declarative workflow search',createdAt:previousManifest?.createdAt??new Date().toISOString(),status:'preparing',
  ...identity,providerEnvironment:environment,requestedModel:settings.model,resolvedModelVersion:'not independently verified by this API alias',
  protocolDetails:{...PROTOCOL,id:UNIFIED_FORMAL_PROTOCOL,searchPolicy:'program-top4-30pct-uniform-70pct-softmax20',validationRepeats:5,testRepeats:3,
   budgetUnit:'complete-valid-evaluation-including-baseline',qualityPruning:'paired-prefix-all-five-repeats',targetScoreStop:false,
   counterPolicy:'proposal/design/full-valid independent; quality-pruned never parent',protocolDifference:'main data/metrics/repeats retained; search allocation adds declared paired regression pruning'},
  ...previousManifest,identity};
 await store.write('manifest.json',manifest);
 await store.write('selection.json',{split:benchmark.split,data:benchmark.identity,taskIds:benchmark.tasks.map(task=>task.id),repeats});
 await store.write('prompts/optimizer-system.json',{sha256:UNIFIED_SYSTEM_PROMPT_SHA256,text:UNIFIED_SYSTEM_PROMPT});
 await store.write('prompts/node-systems.json',{sha256:NODE_SYSTEM_PROMPT_SHA256,templates:NODE_SYSTEM_PROMPTS});
 if(initialUser!==undefined)await store.write('prompts/initial-user.json',{text:initialUser,sha256:createHash('sha256').update(initialUser).digest('hex')});
 if(!previousManifest)await store.snapshot(root);
 if(options.offlineOnly){manifest.status='offline-ready';await store.write('manifest.json',manifest);console.log(JSON.stringify({phase:'offline-ready',directory:store.directory,examples:benchmark.tasks.length,repeats,providerCreated:false}));return;}
 const oldUsage=options.resume?await store.optional<ProviderBudgetSnapshot>('provider-budget.json'):undefined;
 const budget=createProviderBudget({maxCalls:options.maxCalls,maxTokens:options.maxTokens,...(oldUsage?{restored:oldUsage}:{}),onEvent:async event=>{
  await store.write('provider-budget.json',event.usage);await store.append('provider-usage.jsonl',event);
 }});
 const requestIds=new WeakMap<object,string>();
 const responseModels=new Set<string>();
 const experiment=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:5000,
  beforeProviderCall:async input=>{
   await budget.beforeProviderCall(input);const requestId=randomUUID();requestIds.set(input,requestId);
   await store.append('provider-requests.jsonl',{requestId,at:new Date().toISOString(),input,
    systemHashes:input.messages.filter(message=>message.role==='system').map(message=>createHash('sha256').update(typeof message.content==='string'?message.content:JSON.stringify(message.content)).digest('hex'))});
  },afterProviderCall:async event=>{
   await budget.afterProviderCall(event);
   for(const diagnostic of event.diagnostics){const model=(diagnostic as unknown as {responseModel?:unknown}).responseModel;if(typeof model==='string')responseModels.add(model);}
   await store.append('provider-responses.jsonl',{requestId:requestIds.get(event.input),at:new Date().toISOString(),inputMetadata:event.input.metadata,output:event.output,
    error:event.error instanceof Error?{name:event.error.name,message:event.error.message,code:(event.error as {code?:unknown}).code}:event.error,diagnostics:event.diagnostics});
   await store.write('model-observations.json',{requestedModel:settings.model,responseModels:[...responseModels],note:'API response fields may still be aliases; absent version is unknown'});
  },
  reflectionEvent:async event=>store.append('reflection-events.jsonl',event)});
 const emit=async(event:Readonly<Record<string,unknown>>)=>{await store.append('events.jsonl',{at:new Date().toISOString(),...event});
  if(['case-completed','stage-completed','unified-search-completed','quality-pruned'].includes(String(event.type)))console.log(JSON.stringify(event));};
 const evaluate=(definition:GraphDefinition,id:string,reference?:UnifiedCandidate)=>evaluateUnifiedCandidate({benchmark,definition,id,store,
  executionIdentity:{...identity,artifactHash:artifactHash(definition)},repeats,concurrency:options.concurrency,retryAttempts:5,timeBudget,prune:options.command==='search',resume:options.resume,
  ...(reference?{reference}:{}),runTask:(spec,task)=>runGraphAgent(spec,task,experiment,settings),onEvent:emit});
 try{
  manifest.status=options.command==='search'?'searching':'testing';await store.write('manifest.json',manifest);
  if(options.command==='test'){
   const summary=await evaluate(frozen!.definition,frozen!.id);
   await store.write('summary.json',summary);manifest.status='test-completed';manifest.score=summary.score;
  }else{
   const resume=options.resume?await store.optional<UnifiedSearchState>('search-state.json'):undefined;
   const result=await searchUnifiedWorkflows({runtime:experiment.runtime,model:{provider:experiment.providerName,model:experiment.model},dataset:options.dataset,publicTasks:benchmark.tasks,
    expectedExamples:benchmark.tasks.length,expectedRepeats:5,maxValidEvaluations:options.maxValidEvaluations,maxDesignRounds:options.maxDesignRounds,maxProposalAttempts:options.maxProposalAttempts,
    seed:options.seed,patience:5,initialDefinition,...(resume?{resume}:{}),evaluate,
    save:async state=>store.write('search-state.json',state),event:emit});
   await freezeBest(sourceStore,result.best,executionIdentity,settings.model,settings.baseUrl,options.dataset);
   manifest.status='search-completed';manifest.stoppedBecause=result.stoppedBecause;manifest.best={id:result.best.id,score:result.best.evaluation.score};
  }
 }catch(error){
  const budgetExhausted=(error as {code?:unknown})?.code==='SEARCH_BUDGET_EXHAUSTED';
  manifest.status=budgetExhausted?'cost-budget-complete':'interrupted';manifest.error=error instanceof Error?error.message:String(error);
  if(options.command==='search'){
   const state=await store.optional<UnifiedSearchState>('search-state.json');
   const best=state?.history.filter((candidate):candidate is UnifiedCandidate=>candidate.status==='valid').sort((a,b)=>b.evaluation.score-a.evaluation.score||a.evaluation.totalTokens-b.evaluation.totalTokens||a.id.localeCompare(b.id))[0];
   if(best){await freezeBest(sourceStore,best,executionIdentity,settings.model,settings.baseUrl,options.dataset);manifest.best={id:best.id,score:best.evaluation.score};}
  }
  if(!budgetExhausted)throw error;
 }finally{
  await experiment.close();manifest.usage=budget.snapshot();await store.write('provider-budget.json',budget.snapshot());await store.write('manifest.json',manifest);await store.flush();
  console.log(JSON.stringify({phase:'unified-run-ended',status:manifest.status,directory:store.directory,usage:budget.snapshot()}));
 }
}

async function freezeBest(store:UnifiedRunStore,best:UnifiedCandidate,executionIdentity:Awaited<ReturnType<typeof evaluationRuntimeIdentity>>,model:string,endpoint:string,dataset:DatasetName):Promise<void>{
 const frozen:FrozenSelection={schemaVersion:1,selectedBeforeTest:true,id:best.id,definition:best.definition,artifactHash:artifactHash(best.definition),executionIdentity,
  promptHash:UNIFIED_SYSTEM_PROMPT_SHA256,model,endpoint,generation:GENERATION,dataset,protocol:UNIFIED_FORMAL_PROTOCOL};
 await store.write('frozen-selection.json',frozen);await store.write('best/candidate.json',best.definition);await store.write('best/validation-summary.json',best.evaluation);
}
