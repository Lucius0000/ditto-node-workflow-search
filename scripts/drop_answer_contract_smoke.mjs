// Bounded live validation. Search, confirmation and targeted regressions are separate.
import {readFile,mkdir,cp,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {graph} from '@codesoul-co/ditto/runtime';
import {loadBenchmark,scoreDropAnswer} from '../dist/benchmark/index.js';
import {stratifiedSample,lengthBucket} from '../dist/benchmark/sampling.js';
import {publicAnswerContract} from '../dist/benchmark/answer-contract.js';
import {loadProviderSettings} from '../dist/config.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {providerEnvironment} from '../dist/unified/runner.js';
import {evaluationRuntimeIdentity} from '../dist/run/case-recovery.js';
import {UnifiedRunStore,artifactHash,caseFile} from '../dist/unified/store.js';
import {createProviderBudget} from '../dist/unified/provider-budget.js';
import {evaluateUnifiedCandidate} from '../dist/unified/evaluation.js';
import {searchUnifiedWorkflows,parseUnifiedProposal} from '../dist/unified/search.js';
import {runGraphAgent} from '../dist/graph-agent/executor.js';
import {BASELINE_DEFINITION,validateDefinition,DefinitionError} from '../dist/graph-agent/schema.js';
import {withWorkflowTimeBudget} from '../dist/execution/time-budget.js';
import {GENERATION} from '../dist/protocol.js';
import {UNIFIED_SYSTEM_PROMPT,UNIFIED_SYSTEM_PROMPT_SHA256,UNIFIED_DEFINITION_GUIDE} from '../dist/unified/prompts.js';
import {NODE_SYSTEM_PROMPT,NODE_SYSTEM_PROMPT_SHA256} from '../dist/graph-agent/system.js';

const flags=new Map();for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--output','--data-dir','--previous-run'].includes(key)||!value||flags.has(key))throw Error('Use --output DIR --data-dir DIR [--previous-run DIR]');flags.set(key,value);}
const root=resolve(flags.get('--output')??'runs/drop-answer-contract-small'),dataDir=resolve(flags.get('--data-dir')??'data/datasets');
const previous=flags.has('--previous-run')?resolve(flags.get('--previous-run')):undefined;
const store=new UnifiedRunStore(root),project=process.cwd();await mkdir(root,{recursive:true});
if(await store.optional('manifest.json'))throw Error('Existing frozen run: choose a new output directory; never overwrite paid evidence');
const settings={...loadProviderSettings(),concurrency:3},environment=providerEnvironment(project),runtimeIdentity=await evaluationRuntimeIdentity(project,environment);
const full=await loadBenchmark('drop',{dataDir,split:'validate',dataMode:'formal',limit:0});
const picked=stratifiedSample(full.tasks,36,20261029,t=>lengthBucket(t.prompt.length)),discovery=picked.slice(0,24),confirmation=picked.slice(24);
const subset=tasks=>({...full,tasks,identity:{...full.identity,selectedCount:tasks.length},evaluate:(runner,options)=>full.evaluateSearchSubset(tasks.map(t=>t.id),runner,options),
 evaluateSearchSubset:(ids,runner,options)=>{if(ids.some(id=>!tasks.some(t=>t.id===id)))throw Error('Outside frozen group');return full.evaluateSearchSubset(ids,runner,options);}});
const timeBudget={requestMs:120000,workflowMs:300000,reason:'Explicit bounded DROP answer-contract diagnostic, not formal Test'};
const limits={toolRepair:{maxCalls:6,maxTokens:20000},search:{maxCalls:220,maxTokens:360000},confirmation:{maxCalls:160,maxTokens:220000},regression:{maxCalls:24,maxTokens:50000}};
const manifest={schemaVersion:1,experiment:'Ditto DROP user-answer-contract and exact-error-feedback small validation',date:'2026-10-30',formal:false,formalTest:false,
 protocol:'unified-small-discovery24x1-confirm12x2-answer-v2',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
 sourceWorkingTreeDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),runtimeIdentity,environment,data:full.identity,
 driverHash:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),seed:20261029,
 discoveryIds:discovery.map(t=>t.id),confirmationIds:confirmation.map(t=>t.id),searchRepeats:1,confirmationRepeats:2,maxValidEvaluations:3,maxDesignRounds:4,maxProposalAttempts:3,
 limits,timeBudget,model:settings.model,endpoint:settings.baseUrl,systemPromptSha256:UNIFIED_SYSTEM_PROMPT_SHA256,nodeSystemSha256:NODE_SYSTEM_PROMPT_SHA256,
 publicAnswerContract:publicAnswerContract('drop'),scorer:'unchanged main drop-token-f1-max-alternatives',
 note:'Known diagnostic panel reused for paired comparison, not a new blind holdout. Confirmation and targeted regressions never enter optimizer feedback. Same source dataset and split as prior run.',status:'preparing'};
await store.write('manifest.json',manifest);await store.snapshot(project);await cp(resolve(project,'dist'),store.path('code-snapshot/dist'),{recursive:true});
let phase='toolRepair';
const budgets=Object.fromEntries(Object.entries(limits).map(([name,limit])=>[name,createProviderBudget({...limit,onEvent:e=>store.append('usage.jsonl',{phase:name,...e})})]));
const ids=new WeakMap();
const experiment=createExperimentRuntime(settings,{timeBudget,connectTimeoutMs:5000,
 beforeProviderCall:async input=>{await budgets[phase].beforeProviderCall(input);const id=randomUUID();ids.set(input,{id,phase});await store.append('provider-requests.jsonl',{id,phase,at:new Date().toISOString(),input});},
 afterProviderCall:async e=>{const request=ids.get(e.input);await budgets[request?.phase??phase].afterProviderCall(e);await store.append('provider-responses.jsonl',{...request,at:new Date().toISOString(),metadata:e.input.metadata,output:e.output,diagnostics:e.diagnostics,error:e.error instanceof Error?{name:e.error.name,message:e.error.message}:e.error});}});
const emit=async e=>{await store.append('events.jsonl',{phase,at:new Date().toISOString(),...e});if(['stage-completed','unified-proposal-rejected','unified-evaluation-completed','unified-quality-pruned','unified-design-skipped'].includes(e.type))console.log(JSON.stringify({phase,type:e.type,id:e.id??e.attempt?.id,score:e.attempt?.evaluation?.score??e.score,stage:e.stage,errors:e.attempt?.publicErrors}));};
async function evaluate(definition,id,tasks,repeats,reference,prune=false){return evaluateUnifiedCandidate({benchmark:subset(tasks),definition,id,store:new UnifiedRunStore(join(root,phase)),executionIdentity:{runtimeIdentity,phase,driverHash:manifest.driverHash},repeats,concurrency:3,retryAttempts:2,timeBudget,prune,...(reference?{reference}:{}),runTask:(d,t)=>runGraphAgent(d,t,experiment,settings),onEvent:emit});}

async function checkToolRepair(){
 const broken=structuredClone(BASELINE_DEFINITION);
 broken.graphs[0].nodes.splice(1,0,{id:'text-helper',type:'INTERACTION.ACT.TOOL',dependencies:[],config:{tool:'normalize_text',arguments:{raw:{ref:['task','prompt']}}}});
 const solve=broken.graphs[0].nodes.at(-1);solve.dependencies=['context','text-helper'];solve.config.evidence=[{ref:['nodes','text-helper','structuredContent']}];solve.config.instruction='Answer the original question. The tool only normalizes whitespace in the public passage; it does not compute an answer.';
 broken.tools=[{name:'normalize_text',description:'Normalize whitespace in supplied public text.',executeSource:'function(args){return {text:args.raw.replace(/\\s+/g," ").trim()};}'}];
 let issue;try{validateDefinition(broken);}catch(e){if(!(e instanceof DefinitionError))throw e;issue=e.issue;}
 if(issue?.path!=='tools[0].inputSchema')throw Error('Fault injection did not produce the intended exact schema diagnostic');
 const fixedIdentity=d=>{const x=structuredClone(d);delete x.tools[0].inputSchema;return artifactHash(x);};
 const proposalGraph=graph('tool-contract-repair-check').node('proposal','INFER.REASONING.SAMPLE',[],input=>({model:input.model,generation:GENERATION,
  messages:[{role:'system',content:UNIFIED_SYSTEM_PROMPT},{role:'user',content:input.request}],metadata:{role:'tool-contract-repair-check',nodeId:'proposal'}}));
 const errors=[];let definition;
 for(let attempt=1;attempt<=2;attempt++){
  const request={mode:'ENGINEERING REPAIR',dataset:'drop',interfaceGuide:UNIFIED_DEFINITION_GUIDE,immutableProtocol:{publicAnswerContract:publicAnswerContract('drop')},
   contractRepair:{rejectedAttemptId:'injected-missing-tool-schema',definition:broken,errors:[issue.message,...errors],issues:[issue]},
   instruction:'Repair only tools[0].inputSchema with the actual raw string argument schema. Return exactly rationale and the complete version:2 definition. Preserve all other fields, node instructions and tool code. This is a separate engineering contract check, not a quality search result.'};
  await store.write(`tool-repair/request-${attempt}.json`,request);
  const out=await experiment.runtime.run(proposalGraph,{model:{provider:experiment.providerName,model:experiment.model},request:JSON.stringify(request)});
  const raw=out.proposal.output.message.content;await store.write(`tool-repair/response-${attempt}.json`,{raw});
  try{definition=parseUnifiedProposal(raw).definition;if(fixedIdentity(definition)!==fixedIdentity(broken))throw Error('Repair changed fields other than tools[0].inputSchema');break;}
  catch(e){definition=undefined;errors.push(e.message);if(e instanceof DefinitionError)issue=e.issue;}
 }
 if(!definition){await store.write('tool-repair/result.json',{passed:false,errors});return;}
 const result=await withWorkflowTimeBudget(timeBudget,()=>runGraphAgent(definition,discovery[0],experiment,settings));
 const passed=result.executedNodeIds.includes('text-helper')&&!result.modelFailure;
 await store.write('tool-repair/definition.json',definition);await store.write('tool-repair/execution.json',result);await store.write('tool-repair/result.json',{passed,initialIssue:issue,repairedInputSchema:definition.tools[0].inputSchema,modelFailure:result.modelFailure??null});
 console.log(JSON.stringify({phase:'toolRepair',passed,schema:definition.tools[0].inputSchema}));
}

try{
 await checkToolRepair();
 phase='search';manifest.status='searching';await store.write('manifest.json',manifest);
 const result=await searchUnifiedWorkflows({runtime:experiment.runtime,model:{provider:experiment.providerName,model:experiment.model},dataset:'drop',publicTasks:discovery,expectedRepeats:1,
  maxValidEvaluations:3,maxDesignRounds:4,maxProposalAttempts:3,seed:20261029,identity:artifactHash(manifest),
  evaluate:(d,id,ref)=>evaluate(d,id,discovery,1,ref,true),save:s=>store.write('search-state.json',s),event:emit});
 await store.write('frozen-selection.json',{selectedBeforeConfirmation:true,id:result.best.id,definition:result.best.definition,artifactHash:result.best.artifactHash,discoveryF1:result.best.evaluation.score});
 phase='confirmation';manifest.status='confirming';await store.write('manifest.json',manifest);
 const baseline=await evaluate(BASELINE_DEFINITION,'baseline',confirmation,2),selected=await evaluate(result.best.definition,'selected',confirmation,2);
 await store.write('comparison.json',{valid:baseline.valid&&selected.valid,selectedId:result.best.id,baselineF1:baseline.score,selectedF1:selected.score,delta:selected.score-baseline.score,
  baselineFullCredit:baseline.results.filter(r=>r.score===1).length/baseline.results.length,selectedFullCredit:selected.results.filter(r=>r.score===1).length/selected.results.length,
  baselineTokens:baseline.totalTokens,selectedTokens:selected.totalTokens});
 if(previous){
  phase='regression';manifest.status='regression';await store.write('manifest.json',manifest);
  const frozen=JSON.parse(await readFile(join(previous,'frozen-selection.json'),'utf8'));
  const regressionIds=['drop:8499','drop:1142','drop:0','drop:543','drop:1432','drop:131'];
  const panel=regressionIds.map(id=>full.tasks.find(t=>t.id===id));if(panel.some(t=>!t))throw Error('Missing targeted regression task');
  await evaluate(frozen.definition,'previous-winner-new-contract',panel,1);
  await store.write('regression/protocol.json',{definitionFrozenFrom:previous,ids:regressionIds,repeats:1,notUsedForSelection:true});
 }
 manifest.status='completed';
}catch(e){manifest.status='interrupted';manifest.error={message:e.message,code:e.code};await store.write('interruption.json',{message:e.message,code:e.code,stack:e.stack});process.exitCode=1;console.log(JSON.stringify({phase,error:e.message,code:e.code}));}
finally{await experiment.close();manifest.usage=Object.fromEntries(Object.entries(budgets).map(([name,b])=>[name,b.snapshot()]));await store.write('manifest.json',manifest);await store.flush();console.log(JSON.stringify({status:manifest.status,usage:manifest.usage}));}

// Offline score and exact-response replay audit: no provider/network calls.
const raw=(await readFile(join(dataDir,'drop_validate.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse),gold=new Map(raw.map(r=>['drop:'+r.id,r.ref_text]));
const tasks=new Map(full.tasks.map(t=>[t.id,t])),audit={executions:0,scoreMismatches:[],replayMismatches:[],modelFailures:[],engineeringFailures:[],losses:[],workflows:[],optimizerSystemsFrozen:true,sampleSystemsFrozen:true};
const requests=await store.lines('provider-requests.jsonl');
for(const r of requests){if(['optimizer','tool-contract-repair-check'].includes(r.input.metadata?.role)&&r.input.messages[0].content!==UNIFIED_SYSTEM_PROMPT)audit.optimizerSystemsFrozen=false;}
for(const area of ['discovery','confirmation','regression']){
 const base=join(root,area,'evaluations');let entries;try{entries=await readdir(base,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
 for(const entry of entries.filter(e=>e.isDirectory())){
  const path=join(base,entry.name);let summary;try{summary=JSON.parse(await readFile(join(path,'summary.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const {definition}=await store.read(`${area}/candidates/${entry.name}.json`);
  audit.workflows.push({area,id:entry.name,score:summary.score,tokens:summary.totalTokens,repeatScores:summary.repeatScores,nodes:definition.graphs.flatMap(g=>g.nodes.map(n=>({graph:g.id,id:n.id,type:n.type,dependencies:n.dependencies,instruction:n.config.instruction}))),definition});
  const cache=new Map();
  for(const row of summary.results){
   const tid=row.caseId.replace(/#\d+$/,''),repeat=Number(row.caseId.split('#').at(-1));if(!cache.has(tid))cache.set(tid,(await readFile(join(path,'executions',caseFile(tid)+'.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse));
   const execution=cache.get(tid)[repeat-1];audit.executions++;
   const score=scoreDropAnswer(gold.get(tid),row.prediction).score;if(Math.abs(score-row.score)>1e-12)audit.scoreMismatches.push({area,id:entry.name,caseId:row.caseId});
   if(execution.modelFailure)audit.modelFailures.push({area,id:entry.name,caseId:row.caseId,failure:execution.modelFailure});
   if(!row.valid||execution.candidateFailure)audit.engineeringFailures.push({area,id:entry.name,caseId:row.caseId});
   for(const response of execution.modelResponses??[])if(response.nodeType==='INFER.REASONING.SAMPLE'&&JSON.stringify(response.systemMessages)!==JSON.stringify([NODE_SYSTEM_PROMPT]))audit.sampleSystemsFrozen=false;
   if(row.score<1)audit.losses.push({area,candidate:entry.name,caseId:row.caseId,question:tasks.get(tid).prompt.match(/\nQuestion:\s*([\s\S]*?)\nAnswer:/)?.[1]??tasks.get(tid).prompt,
    reference:gold.get(tid),prediction:row.prediction,score:row.score,modelResponses:execution.modelResponses,rawFinalEqualsPrediction:execution.modelResponses?.at(-1)?.rawContent===row.prediction});
   const queues=new Map();for(const r of execution.modelResponses??[]){if(!queues.has(r.nodeId))queues.set(r.nodeId,[]);queues.get(r.nodeId).push(r);}
   const replay=createExperimentRuntime({...settings,apiKey:'offline',baseUrl:'https://example.invalid'},{provider:{async invoke(input){const r=queues.get(input.metadata?.nodeId)?.shift();if(!r)throw Error('Unexpected offline replay request');return{message:{role:'assistant',content:r.rawContent},finishReason:r.finishReason};}}});
   try{const output=await runGraphAgent(definition,tasks.get(tid),replay,{...settings,apiKey:'offline'});if(output.answer!==row.prediction)audit.replayMismatches.push({area,id:entry.name,caseId:row.caseId,saved:row.prediction,replayed:output.answer});}
   catch(e){audit.replayMismatches.push({area,id:entry.name,caseId:row.caseId,error:e.message});}finally{await replay.close();}
  }
 }
}
await store.write('AUDIT.json',audit);await store.write('ALL-LOSSES.json',audit.losses);
const pct=x=>(100*x).toFixed(2)+'%',escape=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
const report=['# DROP答案协议修复：小批量验证','',`状态：${manifest.status}。固定system未改，主F1评分器与数据划分未改；user答案契约版本${manifest.publicAnswerContract.version}。`,
 '','探索24题×1、确认12题×2，固定seed=20261029；沿用已知诊断面板，不是新盲测或正式Test。另有独立工具修复检查和旧胜出图的6题定向回归，均不参与选优。',
 '',`完整执行审计${audit.executions}次：重算差异${audit.scoreMismatches.length}、离线重放差异${audit.replayMismatches.length}、执行工程失败${audit.engineeringFailures.length}、模型协议失败${audit.modelFailures.length}。`,
 '',`优化器system冻结：${audit.optimizerSystemsFrozen}；SAMPLE system冻结：${audit.sampleSystemsFrozen}。`,
 '','## 工作流与F1','', '| 阶段 | ID | 实际节点 | F1 | tokens |','|---|---|---|---:|---:|',...audit.workflows.map(w=>`| ${w.area} | ${w.id} | ${w.nodes.map(n=>n.id+':'+n.type).join(' → ')} | ${pct(w.score)} | ${w.tokens} |`),
 '','## 全部非满分题次','', '| 阶段/候选 | 题次 | 原问题 | 实际输出 | 参考 | F1 |','|---|---|---|---|---|---:|',...audit.losses.map(r=>`| ${r.area}/${r.candidate} | ${r.caseId} | ${escape(r.question)} | ${escape(r.prediction)} | ${escape(r.reference)} | ${pct(r.score)} |`),
 '','完整声明、逐节点原始模型输出与所有失分题次见AUDIT.json、ALL-LOSSES.json和各evaluations/executions记录。固定主评分不做数值等价判断，.5/0.5等差异仍可能扣分；不通过修改评分器抬分。'];
const comparison=await store.optional('comparison.json');if(comparison)report.splice(4,0,`确认F1：${pct(comparison.baselineF1)} → ${pct(comparison.selectedF1)}，差值${(100*comparison.delta).toFixed(2)}个百分点；tokens ${comparison.baselineTokens} → ${comparison.selectedTokens}。`,'');
await store.write('validation-summary.json',{status:manifest.status,comparison,toolRepair:await store.optional('tool-repair/result.json'),executions:audit.executions,scoreMismatches:audit.scoreMismatches,replayMismatches:audit.replayMismatches,modelFailures:audit.modelFailures,engineeringFailures:audit.engineeringFailures,optimizerSystemsFrozen:audit.optimizerSystemsFrozen,sampleSystemsFrozen:audit.sampleSystemsFrozen,usage:manifest.usage});
await import('node:fs/promises').then(fs=>fs.writeFile(join(root,'REPORT.zh-CN.md'),report.join('\n')+'\n','utf8'));
if(audit.scoreMismatches.length||audit.replayMismatches.length||!audit.optimizerSystemsFrozen||!audit.sampleSystemsFrozen)process.exitCode=1;
console.log(JSON.stringify({audit:'completed',executions:audit.executions,scoreMismatches:audit.scoreMismatches.length,replayMismatches:audit.replayMismatches.length,comparison}));
