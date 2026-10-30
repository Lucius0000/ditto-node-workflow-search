import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createExperimentRuntime} from '../dist/ditto/runtime.js';
import {runGraphAgent} from '../dist/graph-agent/executor.js';
import {BASELINE_DEFINITION,NODE_TYPES} from '../dist/graph-agent/schema.js';
import {NODE_SYSTEM_PROMPT} from '../dist/graph-agent/system.js';
import {searchUnifiedWorkflows} from '../dist/unified/search.js';
import {UNIFIED_OPTIMIZER_SYSTEM,UNIFIED_OPTIMIZER_SYSTEM_SHA256} from '../dist/unified/prompts.js';

const captured=[];
const settings={baseUrl:'https://example.invalid',model:'offline-audit',apiKey:'offline',concurrency:1,timeoutMs:3000};
const changed=structuredClone(BASELINE_DEFINITION);
changed.graphs[0].nodes.find(node=>node.type==='INFER.REASONING.SAMPLE').config.instruction='Use the supplied public task and return the requested answer.';
const experiment=createExperimentRuntime(settings,{provider:{async invoke(input){
 captured.push(structuredClone(input));
 return {message:{role:'assistant',content:input.metadata?.role==='optimizer'?JSON.stringify({rationale:'One public instruction improvement.',definition:changed}):'public answer'},finishReason:'stop',usage:{inputTokens:4,outputTokens:2,totalTokens:6}};
}}});
try{
 for(const dataset of ['drop','gsm8k']){
  const task={id:'audit-'+dataset,dataset,prompt:'A public offline task.',outputInstruction:'Return the answer.',metadata:{}};
  await searchUnifiedWorkflows({runtime:experiment.runtime,exploration:false,model:{provider:experiment.providerName,model:experiment.model},dataset,publicTasks:[task],
   expectedRepeats:1,maxValidEvaluations:2,maxDesignRounds:1,evaluate:async definition=>{
    const result=await runGraphAgent(definition,task,experiment,settings);
    assert.equal(result.answer,'public answer');
    return {valid:true,score:.5,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,
     inputTokens:4,outputTokens:2,totalTokens:6,durationMs:0,repeatScores:[.5],tokenUsageStatus:'complete',results:[{
      caseId:task.id+'#1',valid:true,score:.5,expected:'PRIVATE-GOLD-SENTINEL',prediction:result.answer,normalizedExpected:'PRIVATE-GOLD-SENTINEL',normalizedPrediction:result.answer,
      method:'offline-fixture',latencyMs:0,inputTokens:4,outputTokens:2,totalTokens:6,usageKnown:true}]};
   }});
 }
}finally{await experiment.close();}
const optimizers=captured.filter(input=>input.metadata?.role==='optimizer');
const nodes=captured.filter(input=>input.metadata?.nodeType==='INFER.REASONING.SAMPLE');
assert.equal(optimizers.length,2);
assert(nodes.length>=4);
assert(optimizers.every(input=>input.messages[0].content===UNIFIED_OPTIMIZER_SYSTEM));
assert(nodes.every(input=>input.messages.filter(message=>message.role==='system').map(message=>message.content).join('')===NODE_SYSTEM_PROMPT));
assert(!JSON.stringify(captured).includes('PRIVATE-GOLD-SENTINEL'));
assert(NODE_TYPES.includes('RETRIEVAL.SEARCH'));
assert.equal(createHash('sha256').update(UNIFIED_OPTIMIZER_SYSTEM).digest('hex'),UNIFIED_OPTIMIZER_SYSTEM_SHA256);
const report={checks:'passed',providerNetworkCalls:0,mockProviderCalls:captured.length,systemPromptSha256:UNIFIED_OPTIMIZER_SYSTEM_SHA256,
 crossDatasetOptimizerSystemFrozen:true,crossDatasetNodeSystemFrozen:true,privateReferenceExcluded:true,retrievalDeclared:true,requests:captured};
const directory=resolve(process.argv[2]??'runs/unified-prompt-audit');await mkdir(directory,{recursive:true});
await writeFile(directory+'/audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,requests:undefined}));
