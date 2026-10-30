import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadBenchmark,scoreDropAnswer} from '../dist/benchmark/index.js';
import {UnifiedRunStore,caseFile} from '../dist/unified/store.js';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {runGraphAgent} from '../dist/graph-agent/executor.js';
import {UNIFIED_SYSTEM_PROMPT} from '../dist/unified/prompts.js';
import {NODE_SYSTEM_PROMPT} from '../dist/graph-agent/system.js';

/** Audit every saved complete/partial scope; this function never invokes a network provider. */
export async function auditDropAnswerRun(directory,datasetDirectory){
const root=resolve(directory),dataDir=resolve(datasetDirectory),store=new UnifiedRunStore(root),manifest=await store.read('manifest.json');
const full=await loadBenchmark('drop',{dataDir,split:'validate',dataMode:'formal',limit:0});
const settings={baseUrl:'https://example.invalid',apiKey:'offline',model:manifest.model,concurrency:1,timeoutMs:3000};
const raw=(await readFile(join(dataDir,'drop_validate.jsonl'),'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse),gold=new Map(raw.map(r=>['drop:'+r.id,r.ref_text]));
const tasks=new Map(full.tasks.map(t=>[t.id,t])),audit={executions:0,scoreMismatches:[],replayMismatches:[],modelFailures:[],engineeringFailures:[],losses:[],workflows:[],optimizerSystemsFrozen:true,sampleSystemsFrozen:true};
const requests=await store.lines('provider-requests.jsonl');
for(const r of requests){if(['optimizer','tool-contract-repair-check'].includes(r.input.metadata?.role)&&r.input.messages[0].content!==UNIFIED_SYSTEM_PROMPT)audit.optimizerSystemsFrozen=false;}
for(const area of ['search','discovery','confirmation','regression']){
 const base=join(root,area,'evaluations');let entries;try{entries=await readdir(base,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
 for(const entry of entries.filter(e=>e.isDirectory())){
  const path=join(base,entry.name);let summary,partial=false;
  try{summary=JSON.parse(await readFile(join(path,'summary.json'),'utf8'));}catch(e){
   if(e.code!=='ENOENT')throw e;
   let checkpoint;try{checkpoint=JSON.parse(await readFile(join(path,'checkpoint.json'),'utf8'));}catch(missing){if(missing.code==='ENOENT')continue;throw missing;}
   partial=true;const valid=checkpoint.cases.filter(r=>r.valid===true&&!r.error);
   for(const r of checkpoint.cases.filter(r=>r.valid!==true||r.error)){
    const value={area,id:entry.name,caseId:r.caseId,error:r.error};
    if(String(r.error).includes('SEARCH_BUDGET_EXHAUSTED'))(audit.resourceStoppedCases??=[]).push(value);else audit.engineeringFailures.push(value);
   }
   if(!valid.length)continue;
   summary={results:valid,score:valid.reduce((s,r)=>s+r.score,0)/valid.length,totalTokens:valid.reduce((s,r)=>s+(r.totalTokens??0),0),repeatScores:[]};
  }
  const {definition}=await store.read(`${area}/candidates/${entry.name}.json`);
  audit.workflows.push({area,id:entry.name,measurement:partial?'partial, not eligible for selection':'complete',observedRuns:summary.results.length,score:summary.score,tokens:summary.totalTokens,repeatScores:summary.repeatScores,nodes:definition.graphs.flatMap(g=>g.nodes.map(n=>({graph:g.id,id:n.id,type:n.type,dependencies:n.dependencies,instruction:n.config.instruction}))),definition});
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
const history=await store.optional('search-state.json');
audit.missingCompleteCandidates=(history?.history??[]).filter(h=>h.status==='valid'&&!audit.workflows.some(w=>['search','discovery'].includes(w.area)&&w.id===h.id&&w.measurement==='complete')).map(h=>h.id);
await store.write('AUDIT.json',audit);await store.write('ALL-LOSSES.json',audit.losses);
const pct=x=>(100*x).toFixed(2)+'%',escape=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
const report=['# DROP答案协议修复：小批量验证','',`状态：${manifest.status}。固定system未改，主F1评分器与数据划分未改；user答案契约版本${manifest.publicAnswerContract.version}。`,
 '','探索24题×1、确认12题×2，固定seed=20261029；沿用已知诊断面板，不是新盲测或正式Test。另有独立工具修复检查和旧胜出图的6题定向回归，均不参与选优。',
 '',`完整执行审计${audit.executions}次：重算差异${audit.scoreMismatches.length}、离线重放差异${audit.replayMismatches.length}、执行工程失败${audit.engineeringFailures.length}、模型协议失败${audit.modelFailures.length}。`,
 '',`优化器system冻结：${audit.optimizerSystemsFrozen}；SAMPLE system冻结：${audit.sampleSystemsFrozen}。`,
 '',...(manifest.searchStopReason?[`搜索停止：${manifest.searchStopReason}。部分候选的分数仅为已完成题次均值，没有候选资格；预算阻断的题次不作为质量零分。`,'']:[]),
 '','## 工作流与F1','', '| 阶段 | ID / 完整性 | 实际节点 | F1 | tokens |','|---|---|---|---:|---:|',...audit.workflows.map(w=>`| ${w.area} | ${w.id} / ${w.measurement} (${w.observedRuns}题次) | ${w.nodes.map(n=>n.id+':'+n.type).join(' → ')} | ${pct(w.score)} | ${w.tokens} |`),
 '','## 全部非满分题次','', '| 阶段/候选 | 题次 | 原问题 | 实际输出 | 参考 | F1 |','|---|---|---|---|---|---:|',...audit.losses.map(r=>`| ${r.area}/${r.candidate} | ${r.caseId} | ${escape(r.question)} | ${escape(r.prediction)} | ${escape(r.reference)} | ${pct(r.score)} |`),
 '','完整声明、逐节点原始模型输出与所有失分题次见AUDIT.json、ALL-LOSSES.json和各evaluations/executions记录。固定主评分不做数值等价判断，.5/0.5等差异仍可能扣分；不通过修改评分器抬分。'];
const comparison=await store.optional('comparison.json');if(comparison)report.splice(4,0,`确认F1：${pct(comparison.baselineF1)} → ${pct(comparison.selectedF1)}，差值${(100*comparison.delta).toFixed(2)}个百分点；tokens ${comparison.baselineTokens} → ${comparison.selectedTokens}。`,'');
await store.write('validation-summary.json',{status:manifest.status,comparison,toolRepair:await store.optional('tool-repair/result.json'),searchStopReason:manifest.searchStopReason,executions:audit.executions,scoreMismatches:audit.scoreMismatches,replayMismatches:audit.replayMismatches,missingCompleteCandidates:audit.missingCompleteCandidates,resourceStoppedCases:audit.resourceStoppedCases??[],modelFailures:audit.modelFailures,engineeringFailures:audit.engineeringFailures,optimizerSystemsFrozen:audit.optimizerSystemsFrozen,sampleSystemsFrozen:audit.sampleSystemsFrozen,usage:manifest.usage});
await writeFile(join(root,'REPORT.zh-CN.md'),report.join('\n')+'\n','utf8');
if(audit.scoreMismatches.length||audit.replayMismatches.length||audit.missingCompleteCandidates.length||!audit.optimizerSystemsFrozen||!audit.sampleSystemsFrozen)process.exitCode=1;
console.log(JSON.stringify({audit:'completed',executions:audit.executions,scoreMismatches:audit.scoreMismatches.length,replayMismatches:audit.replayMismatches.length,comparison}));

return audit;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(!process.argv[2]||!process.argv[3])throw Error('Use audit_drop_answer_contract.mjs RUN_DIRECTORY DATA_DIRECTORY');await auditDropAnswerRun(process.argv[2],process.argv[3]);}
