import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {ModelProvider} from '@codesoul-co/ditto/worker/infer';
import {loadBenchmark} from '../benchmark/registry.js';
import {DockerPythonJudge} from '../benchmark/docker-python-judge.js';
import {automationIdentity} from '../benchmark/automation.js';
import {BASELINE_DEFINITION} from '../graph-agent/schema.js';
import {automationBaseline} from '../graph-agent/automation-baseline.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {createExperimentRuntime,type ExperimentRuntime} from '../ditto/runtime.js';
import {CaseRecovery,evaluationRuntimeIdentity} from '../run/case-recovery.js';
import {AutomationBudgetRecovery} from '../run/automation-budget-recovery.js';
import {providerEnvironment} from './runner.js';
import {UnifiedRunStore,artifactHash,caseFile} from './store.js';
import {createProviderBudget,type ProviderBudgetSnapshot} from './provider-budget.js';
import {accountQuery} from './ark-account.js';
import {GENERATION,PROTOCOL} from '../protocol.js';
import {NODE_SYSTEM_PROMPTS} from '../graph-agent/system.js';
import {timeBudgetCleanupRegistrar} from '../execution/time-budget.js';
import type {DatasetName} from '../domain.js';

const DATASETS=['humaneval','mbpp','drop','automationbench'] as const;
const COUNTS={humaneval:33,mbpp:86,drop:200,automationbench:200};
class AccountQuotaUnavailable extends Error {}
export interface FixedEngineeringProtocol {
 readonly version:1;readonly approved:true;readonly endpoint:'https://ark.cn-beijing.volces.com/api/plan/v3';readonly model:'deepseek-v4.1-flash';
 readonly accounts:readonly string[];readonly overageDisabledConfirmed:true;readonly authorizationSource:string;
 readonly dataDirectories:Record<typeof DATASETS[number],string>;readonly dockerImage:string;
 readonly requestMs:180000;readonly workflowMs:300000;readonly automationWorkflowMs:600000;readonly maxActorCalls:60;
 readonly workflowAttempts:5;readonly sdkAttempts:3;readonly repeats:1;
}
export function validateFixedEngineeringProtocol(value:any):FixedEngineeringProtocol {
 const allowed=['version','approved','endpoint','model','accounts','overageDisabledConfirmed','authorizationSource','dataDirectories','dockerImage','requestMs','workflowMs','automationWorkflowMs','maxActorCalls','workflowAttempts','sdkAttempts','repeats'];
 if(!value||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Invalid fixed-engineering protocol fields');
 if(value.version!==1||value.approved!==true||value.overageDisabledConfirmed!==true||typeof value.authorizationSource!=='string'||!value.authorizationSource.trim())throw Error('Explicit fixed-evaluation authorization and no-overage confirmation are required');
 if(value.endpoint!=='https://ark.cn-beijing.volces.com/api/plan/v3'||value.model!=='deepseek-v4.1-flash')throw Error('Fixed engineering runs use only the approved Ark Agent Plan endpoint/model');
 if(!Array.isArray(value.accounts)||value.accounts.length!==3||new Set(value.accounts).size!==3||value.accounts.some((alias:unknown)=>typeof alias!=='string'||!/^[A-Z][A-Z0-9_]{0,31}$/.test(alias)))throw Error('Three distinct authorized account aliases are required');
 for(const[key,expected]of Object.entries({requestMs:180000,workflowMs:300000,automationWorkflowMs:600000,maxActorCalls:60,workflowAttempts:5,sdkAttempts:3,repeats:1}))if(value[key]!==expected)throw Error('Fixed engineering protocol differs: '+key);
 if(!value.dataDirectories||Object.keys(value.dataDirectories).sort().join()!==[...DATASETS].sort().join()||DATASETS.some(dataset=>typeof value.dataDirectories[dataset]!=='string'))throw Error('All four fixed Search data directories are required');
 if(typeof value.dockerImage!=='string'||!/^python@sha256:[a-f0-9]{64}$/.test(value.dockerImage))throw Error('A verified immutable Python image digest is required');
 return value;
}

/** Fixed Search membership evaluation only: no optimizer, selection, pruning or Test. */
export async function runFixedEngineering(protocol:FixedEngineeringProtocol,options:{root:string;output:string;phase:'probe'|'full'|'repair';offlineOnly:boolean;resume:boolean;repairFrom?:string}):Promise<void>{
 validateFixedEngineeringProtocol(protocol);
 const root=resolve(options.root),store=new UnifiedRunStore(options.output),scope=new AsyncLocalStorage<{dataset:DatasetName;taskId:string}>();
 const environment=providerEnvironment(root),runtimeIdentity=await evaluationRuntimeIdentity(root,environment);
 const judge=new DockerPythonJudge({image:protocol.dockerImage,programTimeoutMs:12000,timeoutMs:60000});
 const benchmarks=new Map(),definitions=new Map();
 for(const dataset of DATASETS){
  const benchmark=await loadBenchmark(dataset,{dataDir:resolve(protocol.dataDirectories[dataset]),split:'validate',dataMode:'formal',codeJudge:judge,artifactDir:store.path('private/'+dataset)});
  if(!benchmark.identity?.verified||benchmark.tasks.length!==COUNTS[dataset])throw Error('Incomplete fixed Search: '+dataset);
  benchmarks.set(dataset,benchmark);definitions.set(dataset,dataset==='automationbench'?automationBaseline(protocol.maxActorCalls):structuredClone(BASELINE_DEFINITION));
 }
 const sourceStore=options.repairFrom?new UnifiedRunStore(options.repairFrom):undefined;
 if((options.phase==='repair')!==Boolean(sourceStore))throw Error('Bounded repair requires its original full-run evidence');
 const parent=sourceStore?await sourceStore.read<{identity:any}>('manifest.json'):undefined;
 const inherited=new Map<string,any>(),repairIds=new Map<string,string[]>();
 if(sourceStore){
  for(const dataset of DATASETS){
   const summary=await sourceStore.read<any>('summaries/'+dataset+'.json');
   const expectedIds=benchmarks.get(dataset).tasks.map((task:any)=>task.id+'#1');
   if(summary.results.length!==COUNTS[dataset]||summary.results.some((row:any,index:number)=>row.caseId!==expectedIds[index]))throw Error('Repair parent membership/order differs');
   for(const row of summary.results)if(row.valid===true&&!row.error)inherited.set(row.caseId,row);
   repairIds.set(dataset,summary.results.filter((row:any)=>row.valid!==true||row.error).map((row:any)=>row.caseId.replace(/#1$/,'')));
  }
  if([...repairIds.values()].reduce((n,ids)=>n+ids.length,0)!==27||inherited.size!==492)throw Error('Approved bounded repair covers exactly 27 invalid cases and 492 unchanged valid cases');
 }
 const identity={protocol,phase:options.phase,runtimeIdentity,generation:GENERATION,sdkPolicy:PROTOCOL.providerAttempts,
  data:Object.fromEntries(DATASETS.map(dataset=>[dataset,{identity:benchmarks.get(dataset).identity,ids:benchmarks.get(dataset).tasks.map((t:any)=>t.id)}])),
  definitions:Object.fromEntries(definitions),nodeSystems:NODE_SYSTEM_PROMPTS,automation:await automationIdentity(),
  ...(parent?{lineage:{sourceRun:sourceStore!.directory,parentIdentityHash:artifactHash(parent.identity),parentRuntime:parent.identity.runtimeIdentity,selectedIds:Object.fromEntries(repairIds),newWorkflowAttemptsPerCase:1,interpretation:'New bounded repair validation, not same-identity resume; all original usage and attempts retained'}}:{})};
 if(parent){
  for(const key of ['protocol','generation','sdkPolicy','data','definitions','nodeSystems','automation'] as const)if(artifactHash(parent.identity[key])!==artifactHash(identity[key]))throw Error('Repair changes a frozen semantic identity field: '+key);
  await store.write('inherited-valid-cases.json',{sourceRun:sourceStore!.directory,parentRuntime:parent.identity.runtimeIdentity,cases:[...inherited.values()],reuse:'Per-case IDs/order, workflows, systems, generation, data, scorer and official environment verified unchanged; raw records remain in parent run.'});
 }
 const previous=await store.optional<{identity:unknown;status:string}>('manifest.json');
 if(previous&&(!options.resume||artifactHash(previous.identity)!==artifactHash(identity)))throw Error('Fixed evaluation already exists or execution identity changed; refuse reuse');
 if(!previous&&options.resume)throw Error('Resume requires a frozen fixed-evaluation manifest');
 await store.write('manifest.json',{identity,status:options.offlineOnly?'offline-ready':'preparing',createdAt:new Date().toISOString(),modelCalls:0,method:'fixed-candidate-engineering',repeats:1,testCalls:0,optimizerCalls:0});
 if(!previous)await store.snapshot(root);
 if(options.offlineOnly)return;
 await judge.preflight();
 const lock=store.path('execution.lock');await mkdir(store.directory,{recursive:true});
 if(options.resume){
  try{
   const owner=JSON.parse(await readFile(lock,'utf8')) as {pid:number};
   if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid fixed-evaluation owner record');
   let alive=true;try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}
   if(alive)throw Error('Fixed evaluation already has a live owner');
   await store.append('recovery-events.jsonl',{at:new Date().toISOString(),staleOwner:owner});await unlink(lock);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 await writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});
 let stop:string|undefined;
 const serviceState=await store.optional<Record<string,{code:string;at:string}>>('account-service-state.json')??{};
 const activeAliases=options.phase==='repair'?protocol.accounts.slice(0,1):protocol.accounts;
 const accounts:{alias:string;runtime?:ExperimentRuntime;active:number;lastQuota:number;exhausted:boolean;cooldownUntil:number;nextAdmission:number}[]=activeAliases.map(alias=>({alias,active:0,lastQuota:0,exhausted:serviceState[alias]?.code==='AccountQuotaExceeded',cooldownUntil:0,nextAdmission:0}));
 const savedBudget=options.resume?await store.optional<ProviderBudgetSnapshot>('provider-budget.json'):undefined;
 // Cumulative upper bounds, including SDK retries; no additional repeat is admitted.
 const workflowAttempts=options.phase==='repair'?1:protocol.workflowAttempts;
 const maxHttpAttempts=options.phase==='repair'?3+26*protocol.maxActorCalls*protocol.sdkAttempts:(options.phase==='probe'?6:319)*workflowAttempts*protocol.sdkAttempts+(options.phase==='probe'?2:200)*protocol.maxActorCalls*protocol.sdkAttempts;
 const budget=createProviderBudget({maxCalls:maxHttpAttempts,maxTokens:Number.MAX_SAFE_INTEGER,...(savedBudget?{restored:savedBudget}:{}),onEvent:async event=>{await store.write('provider-budget.json',event.usage);await store.append('provider-budget-events.jsonl',event);}});
 const requestIds=new WeakMap<object,string>();
 async function checkQuota(account:typeof accounts[number],force=false):Promise<void>{
  if(!force&&Date.now()-account.lastQuota<60000)return;
  const [plan,usage]=await Promise.all([accountQuery('GetPersonalPlan',account.alias),accountQuery('GetAFPUsage',account.alias)]);
  const windows=['AFPFiveHour','AFPDaily','AFPWeekly','AFPMonthly'].map(key=>usage[key] as any);
  const remaining=Math.min(...windows.map(w=>Number(w?.Quota)-Number(w?.Used)));
  if(plan.Status!=='Running'||!Number.isFinite(remaining))throw Error('Authorized Agent Plan status or quota is invalid');
  account.exhausted=serviceState[account.alias]?.code==='AccountQuotaExceeded'||remaining<=0;account.lastQuota=Date.now();
  await store.append('account-usage.jsonl',{at:new Date().toISOString(),alias:account.alias,plan,usage,remaining,exhausted:account.exhausted,noBillingSettingsChanged:true});
 }
 async function assertDispatch():Promise<void>{
  if(stop)throw Error(stop);
  try{await readFile(store.path('STOP'));stop='Operator STOP: no new requests admitted';throw Error(stop);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 const common={baseUrl:protocol.endpoint,model:protocol.model,apiKey:'application-managed',concurrency:options.phase==='probe'?3:18,timeoutMs:protocol.requestMs};
 const experiments:ExperimentRuntime[]=[];
 try{
  const keys=accounts.map(account=>process.env['ARK_PLAN_KEY_'+account.alias]);
  if(keys.some(key=>!key)||new Set(keys).size!==accounts.length)throw Error('Three distinct authorized subscription credentials are required');
  for(const account of accounts){
   const key=process.env['ARK_PLAN_KEY_'+account.alias]!;
   await checkQuota(account,true);
   process.env.DITTO_PROVIDER_LOG=store.path('accounts/'+account.alias+'/provider.jsonl');
   account.runtime=createExperimentRuntime({...common,apiKey:key,concurrency:options.phase==='probe'?1:6},{timeBudget:{requestMs:protocol.requestMs,workflowMs:null,reason:'Per-case workflow budget supplied by evaluator'},beforeProviderCall:async input=>{
    if(account.exhausted)throw new AccountQuotaUnavailable('Authorized account included quota is exhausted');
    await assertDispatch();await budget.beforeProviderCall(input);const id=randomUUID();requestIds.set(input,id);await store.append('provider-requests.jsonl',{id,at:new Date().toISOString(),account:account.alias,...scope.getStore(),input});
   },afterProviderCall:async event=>{
    await budget.afterProviderCall(event);
    if(event.diagnostics.some(diagnostic=>diagnostic.providerErrorCode==='AccountQuotaExceeded')){
     account.exhausted=true;serviceState[account.alias]={code:'AccountQuotaExceeded',at:new Date().toISOString()};
     await store.write('account-service-state.json',serviceState);
    }
    await store.append('provider-responses.jsonl',{id:requestIds.get(event.input),at:new Date().toISOString(),account:account.alias,...scope.getStore(),output:event.output,error:event.error instanceof Error?event.error.message:event.error,diagnostics:event.diagnostics});
   }});
   experiments.push(account.runtime);
  }
  const pool:ModelProvider={async invoke(input,callOptions){
   await assertDispatch();await Promise.all(accounts.map(account=>checkQuota(account)));
   const eligible=accounts.filter(account=>!account.exhausted);if(!eligible.length){stop='All authorized included quotas exhausted';throw Error(stop);}
   const ready=eligible.filter(account=>account.cooldownUntil<=Date.now());
   const account=(ready.length?ready:eligible).sort((a,b)=>a.active-b.active||a.nextAdmission-b.nextAdmission)[0]!;
   account.active++;
   const admitted=Math.max(Date.now(),account.nextAdmission);account.nextAdmission=admitted+(account.alias===protocol.accounts[0]?150:650);
   try{
    while(Date.now()<Math.max(admitted,account.cooldownUntil)){callOptions.signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(admitted,account.cooldownUntil)-Date.now())));}
    callOptions.signal.throwIfAborted();
    return await account.runtime!.provider.invoke(input,callOptions);
   }catch(error){
    if(error instanceof AccountQuotaUnavailable)return pool.invoke(input,callOptions);
    const message=error instanceof Error?error.message:String(error);
    if(/429|rate.?limit/i.test(message))account.cooldownUntil=Date.now()+15000;
    if(/402|403|insufficient|quota.*exhaust|balance/i.test(message)){
     await checkQuota(account,true);if(!account.exhausted)stop='Provider permission/billing restriction; no account switching';
    }
    throw error;
   }finally{account.active--;}
  }};
  delete process.env.DITTO_PROVIDER_LOG;
  const shared=createExperimentRuntime(common,{provider:pool,managedProvider:true});experiments.push(shared);
  const datasetEvaluations=await Promise.allSettled(DATASETS.map(async dataset=>{
   await assertDispatch();
   const benchmark=benchmarks.get(dataset),definition=definitions.get(dataset),tasks=options.phase==='probe'?benchmark.tasks.slice(0,2):options.phase==='repair'?benchmark.tasks.filter((task:any)=>repairIds.get(dataset)!.includes(task.id)):benchmark.tasks;
   if(!tasks.length)return;
   const recovery=await CaseRecovery.open(store.path('case-recovery/'+dataset),{identity,dataset,ids:tasks.map((task:any)=>task.id)},{concurrency:options.phase==='probe'?3:18});
   const automationBudgetPersistence=dataset==='automationbench'?new AutomationBudgetRecovery(store.path('automation-budgets'),recovery.identity):undefined;
   const evaluate=options.phase!=='full'?benchmark.evaluateSearchSubset.bind(benchmark,tasks.map((task:any)=>task.id)):benchmark.evaluate.bind(benchmark);
   const taskConcurrency=options.phase==='probe'?3:dataset==='humaneval'||dataset==='mbpp'?6:18;
   const summary=await evaluate(async(task:any)=>scope.run({dataset,taskId:task.id},async()=>{
    await assertDispatch();
    const pending=runGraphAgent(definition,task,shared,common);timeBudgetCleanupRegistrar()(pending);
    try{const result=await pending;await store.append('executions/'+dataset+'/'+caseFile(task.id)+'.jsonl',{at:new Date().toISOString(),taskId:task.id,...result});return result;}
    catch(error){await store.append('execution-errors.jsonl',{at:new Date().toISOString(),dataset,taskId:task.id,error:String(error),partialRun:(error as any)?.partialRun});throw error;}
   }),{repeats:1,concurrency:taskConcurrency,retryAttempts:workflowAttempts,cumulativeRetries:true,
    timeBudget:{requestMs:protocol.requestMs,workflowMs:dataset==='automationbench'?protocol.automationWorkflowMs:protocol.workflowMs},
    ...(automationBudgetPersistence?{automationBudgetPersistence,automationBudget:{maxActorCalls:protocol.maxActorCalls,wallClockMs:protocol.automationWorkflowMs}}:{}),
    priorCases:recovery.priorCases,onCase:async(progress:any)=>{
     await recovery.record(progress.result);await store.append('case-events.jsonl',{at:new Date().toISOString(),dataset,...progress});
     await store.write('progress.json',{at:new Date().toISOString(),phase:options.phase,dataset,completed:progress.completed,total:progress.total,budget:budget.snapshot(),stop:stop??null});
    }});
   await store.write('summaries/'+dataset+'.json',summary);await recovery.finish(summary.valid===true);
   if(!summary.valid)throw Error('Unresolved engineering-invalid cases: '+dataset);
  }));
  const failed=datasetEvaluations.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  await Promise.all(accounts.map(account=>checkQuota(account,true)));
  await store.write('completion.json',{at:new Date().toISOString(),phase:options.phase,positions:options.phase==='probe'?8:options.phase==='repair'?27:519,budget:budget.snapshot(),finalAcceptance:false,mflowReference:'warning-only; original comparable run unavailable'});
 }finally{
  for(const experiment of experiments.reverse())await experiment.close();
  await store.flush();await unlink(lock);
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [protocolPath,output,phase,...flags]=process.argv.slice(2);
 const repairIndex=flags.indexOf('--repair-from'),repairFrom=repairIndex<0?undefined:flags[repairIndex+1];
 const switches=repairIndex<0?flags:flags.filter((_,index)=>index!==repairIndex&&index!==repairIndex+1);
 if(!protocolPath||!output||!['probe','full','repair'].includes(phase??'')||switches.some(flag=>!['--offline-only','--resume'].includes(flag))||(repairIndex>=0&&!repairFrom))throw Error('Usage: fixed-engineering.js <approved-protocol.json> <output> probe|full|repair [--offline-only] [--resume] [--repair-from original-full-run]');
 const protocol=validateFixedEngineeringProtocol(JSON.parse(await readFile(protocolPath,'utf8')));
 await runFixedEngineering(protocol,{root:process.cwd(),output,phase:phase as 'probe'|'full'|'repair',offlineOnly:flags.includes('--offline-only'),resume:flags.includes('--resume'),...(repairFrom?{repairFrom}:{})});
}
