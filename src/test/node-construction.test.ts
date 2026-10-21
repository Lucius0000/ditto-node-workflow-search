import assert from 'node:assert/strict';
import test from 'node:test';
import {createDitto} from '@codesoul-co/ditto/runtime';
import {createInferWorker,type ModelProvider} from '@codesoul-co/ditto/worker/infer';
import type {EvaluationSummary,SearchExperience} from '../domain.js';
import type {SearchResumeState} from '../search/optimizer.js';
import {NodeTreeWorkflowSearch} from '../search/node-tree-search.js';
import {NodeExpansionProposer,NodeExpansionRejectedError,type ExpansionRequest} from '../search/node-expansion-proposer.js';
import {prepareExpansion,executionTopologyHash,type Assembly,type ConstructionBranch,type NodeExpansion} from '../search/node-construction.js';
import {initialOrganization,buildOrganizationPlan,nodeDefinition,nodeCatalog,validateOrganization} from '../workflow/organization.js';
import {GENERATION} from '../protocol.js';
import {baselinePrompts} from '../benchmark/baseline-prompts.js';

const initial=initialOrganization('humaneval');
const assembly:Assembly={graphs:initial.graphs,entryGraphId:initial.entryGraphId,transitions:initial.transitions,outputNodeId:initial.outputNodeId};
const base:ConstructionBranch={id:'branch-000002',baseBranchId:'branch-000001',leafVertexId:'node-000002',nodes:initial.nodes,vertexByNode:{context:'node-000001','sample-1':'node-000002'},assembly};
const edit=(instruction:string,branch=base):NodeExpansion=>({baseBranchId:branch.id,anchorNodeId:'sample-1',operation:'replace',submit:true,node:{id:'sample-1',template:'sample',dependencies:['context'],config:{instruction}},assembly:branch.assembly??assembly});
function summary(score:number):EvaluationSummary {
  return {score,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:score===0?1:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[]};
}
function latest(request:ExpansionRequest):ConstructionBranch {return request.branches.at(-1)!;}
const proposer={async propose(r:ExpansionRequest){return edit(`Candidate ${r.experiences.length}`,latest(r));}};

test('code initial plans expose exact baseline prompts and do not enable other dataset paths',()=>{
  for(const dataset of ['humaneval','mbpp'] as const){
    const plan=buildOrganizationPlan(initialOrganization(dataset));
    assert.equal((plan.nodes.find(n=>n.id==='sample-1')!.config as {instruction:string}).instruction,baselinePrompts(dataset)!.agent);
    assert.equal(plan.nodes.filter(n=>n.type.startsWith('INFER')).length,1);
  }
  assert.throws(()=>nodeCatalog('math' as 'humaneval'),/only HumanEval, MBPP and AutomationBench/);
});

test('one replacement changes one node, preserves earlier immutable versions and materializes config',()=>{
  const before=structuredClone(base);
  const result=prepareExpansion('humaneval',base,edit('Inspect boundary cases.'),'branch-000003','node-000003',24);
  assert.deepEqual(base,before);
  assert.equal(result.branch.vertexByNode.context,base.vertexByNode.context);
  assert.equal(result.branch.vertexByNode['sample-1'],'node-000003');
  assert.equal((result.plan!.nodes.find(n=>n.id==='sample-1')!.config as {instruction:string}).instruction,'Inspect boundary cases.');
});

test('pure assembly cannot smuggle node edits and single-edit fields reject extra mutations',()=>{
  const organize={baseBranchId:base.id,anchorNodeId:'sample-1',operation:'organize',assembly};
  assert.throws(()=>prepareExpansion('humaneval',base,{...organize,node:edit('smuggled').node} as NodeExpansion,'branch-next','node-next',24),/Only add/);
  assert.throws(()=>prepareExpansion('humaneval',base,{...organize,assembly:{...assembly,nodes:initial.nodes}} as NodeExpansion,'branch-next','node-next',24),/Unsupported construction/);
  assert.throws(()=>prepareExpansion('humaneval',base,{...edit('x'),nodes:initial.nodes} as NodeExpansion,'branch-next','node-next',24),/Unsupported construction/);
  assert.throws(()=>prepareExpansion('humaneval',base,{...edit('x'),anchorNodeId:'context'} as NodeExpansion,'branch-next','node-next',24),/selected anchor/);
});

test('main legal configuration fields remain searchable and exact generation stays fixed',()=>{
  for(const [strategy,options] of Object.entries({cot:{rounds:2},'long-cot':{rounds:3},tot:{breadth:2,depth:2,beamWidth:1},got:{breadth:2,depth:2},'self-consistency':{candidates:3}})){
    assert.equal((nodeDefinition('humaneval',{id:'reason',template:'cot',dependencies:[],config:{instruction:'Solve carefully',strategy,options}},'reason').config as {strategy:string}).strategy,strategy);
  }
  for(const mode of ['select','merge','consensus','debate'])assert.doesNotThrow(()=>nodeDefinition('mbpp',{id:'choose',template:'select',dependencies:['a','b'],config:{mode}},'x'));
  for(const mode of ['critique','verify','revise'])assert.doesNotThrow(()=>nodeDefinition('mbpp',{id:'check',template:'verify',dependencies:['a'],targetNodeId:'a',config:{mode,criteria:['Check returns and public constraints.']}},'x'));
  const n=initial.nodes[1]!;
  for(const config of [{generation:{...GENERATION,temperature:GENERATION.temperature+.1}},{tools:[]},{actions:[]},{expected:'PRIVATE'},{provider:'x'},{instruction:''}]){
    // Main permits the historical sample-1 empty instruction only; a new ID has no exemption.
    assert.throws(()=>nodeDefinition('humaneval',{...n,id:'new-sample',config},'x'));
  }
  assert.throws(()=>nodeDefinition('mbpp',{id:'reason',template:'cot',dependencies:[],config:{strategy:'tot',options:{breadth:99,depth:1,beamWidth:1}}},'x'));
});

test('execution identity covers prompt/criteria/options and ignores instance and Graph renames',()=>{
  const original=executionTopologyHash(initial);
  const renamed={...initial,nodes:[{...initial.nodes[0]!,id:'z'},{...initial.nodes[1]!,id:'a',dependencies:['z']}],graphs:[{id:'renamed',nodeIds:['z','a']}],entryGraphId:'renamed',transitions:{renamed:{kind:'end' as const}},outputNodeId:'a'};
  assert.equal(executionTopologyHash(renamed),original);
  const changed=prepareExpansion('humaneval',base,edit('A different complete instruction.'),'branch-next','node-next',24).plan!.organization!;
  assert.notEqual(executionTopologyHash(changed),original);
  const explicit={...initial,nodes:initial.nodes.map(n=>({...n,config:nodeDefinition('humaneval',n,'x').config}))};
  assert.equal(executionTopologyHash(explicit),original,'omitted defaults are the same effective execution');
  const reflect={...initial,nodes:[...initial.nodes,{id:'check',template:'verify',dependencies:['sample-1'],targetNodeId:'sample-1',config:{criteria:['Check public constraints.']}}],graphs:[{id:'solve',nodeIds:['context','sample-1','check']}]};
  assert.notEqual(executionTopologyHash(reflect),executionTopologyHash({...reflect,nodes:reflect.nodes.map(n=>n.id==='check'?{...n,config:{criteria:['Check return values.']}}:n)}));
  const reasoning={...initial,nodes:initial.nodes.map(n=>n.id==='sample-1'?{...n,template:'cot',config:{options:{rounds:1}}}:n)};
  assert.notEqual(executionTopologyHash(reasoning),executionTopologyHash({...reasoning,nodes:reasoning.nodes.map(n=>n.id==='sample-1'?{...n,config:{options:{rounds:2}}}:n)}));
});

test('same-Graph checker findings cannot silently disappear before revise',()=>{
  const nodes=[...initial.nodes,{id:'check',template:'verify',dependencies:['sample-1'],targetNodeId:'sample-1'}, {id:'revision',template:'revise',dependencies:['sample-1'],targetNodeId:'sample-1'}];
  const spec={...initial,nodes,graphs:[{id:'solve',nodeIds:['context','sample-1','check','revision']}],outputNodeId:'revision'};
  assert.throws(()=>buildOrganizationPlan(spec),/preceding checker/);
  assert.doesNotThrow(()=>buildOrganizationPlan({...spec,nodes:nodes.map(n=>n.id==='revision'?{...n,dependencies:['sample-1','check']}:n)}));
  assert.throws(()=>buildOrganizationPlan({...initial,nodes:[...initial.nodes,{id:'check',template:'verify',dependencies:['sample-1']}],graphs:[{id:'solve',nodeIds:['context','sample-1','check']}]}),/require targetNodeId/);
});

test('conditional paths require available mandatory inputs and guaranteed final output',()=>{
  const spec={...initial,nodes:[...initial.nodes,{id:'check',template:'verify',dependencies:['sample-1'],targetNodeId:'sample-1'}],graphs:[{id:'solve',nodeIds:['context','sample-1','check']}],outputNodeId:'check'};
  assert.throws(()=>validateOrganization(spec),/result-producing/);
  assert.throws(()=>validateOrganization({...initial,graphs:[...initial.graphs,{id:'unused',nodeIds:[]}]}),/Invalid\/duplicate graph/);
});

test('baseline plus two unique valid candidates count three evaluations including valid zero',async()=>{
  let count=0,saved:SearchResumeState|undefined;
  const result=await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:2,patience:5,proposer,evaluate:async()=>{count++;return summary(0);},callbacks:{async state(s){saved=structuredClone(s);}}}).run();
  assert.equal(count,3);assert.equal(saved!.completedRounds,2);assert.equal(saved!.nodeConstruction!.evaluations.length,3);
  assert.equal(result.nodes.length,4,'baseline context/sample plus two real node versions');
  assert.equal(result.nodes.some(n=>n.evaluation!==undefined),false,'workflow scores stay out of vertex identity');
});

test('unassembled construction persists and resumes before consuming a candidate',async()=>{
  let saved:SearchResumeState|undefined;
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,evaluate:async()=>summary(.2),proposer:{async propose(r){const p=edit('Partial candidate',latest(r));const {assembly: omitted,submit:unsubmitted,...partial}=p;return partial;}},callbacks:{async state(s){saved=structuredClone(s);if(s.nodeConstruction!.constructionStepsSinceEvaluation===1)throw Error('interrupt partial');}}}).run(),/interrupt partial/);
  assert.equal(saved!.completedRounds,0);assert.equal(saved!.nodeConstruction!.pending,undefined);
  const branch=saved!.nodeConstruction!.branches.at(-1)!;assert.ok(branch.assembly,'runnable assembly is retained without implicitly submitting');
  let count=0;
  await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,resume:saved!,proposer:{async propose(){return {baseBranchId:branch.id,anchorNodeId:'sample-1',operation:'submit',submit:true};}},evaluate:async()=>{count++;return summary(0);}}).run();
  assert.equal(count,1,'only the newly assembled candidate is evaluated on recovery');
});

test('invalid evaluation stays pending with identical plan and consumes no effective budget',async()=>{
  let saved:SearchResumeState|undefined,count=0,pendingPlan='';
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:2,patience:5,proposer,evaluate:async(plan)=>{count++;if(count===2){pendingPlan=JSON.stringify(plan);return {...summary(0),valid:false,failedRuns:1};}return summary(.5);},callbacks:{async state(s){saved=structuredClone(s);}}}).run(),/Invalid evaluation/);
  assert.equal(saved!.completedRounds,0);assert.equal(saved!.nodeConstruction!.evaluations.length,1);
  assert.equal(JSON.stringify(saved!.nodeConstruction!.pending!.plan),pendingPlan);
  count=0;
  await new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:2,patience:5,proposer,resume:saved!,evaluate:async(plan)=>{count++;if(count===1)assert.equal(JSON.stringify(plan),pendingPlan);return summary(0);}}).run();
  assert.equal(count,2,'pending candidate and one new candidate; never rerun baseline');
});

test('cosmetic duplicate submissions and stalled proposals spend no candidate count',async()=>{
  let saved:SearchResumeState|undefined;
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:2,patience:5,evaluate:async()=>summary(.2),proposer:{async propose(){throw new NodeExpansionRejectedError([{content:'{}',error:'duplicate'}]);}},callbacks:{async state(s){saved=structuredClone(s);}}}).run(),/stalled/);
  assert.equal(saved!.completedRounds,0);assert.equal(saved!.nodeConstruction!.evaluations.length,1);
});

test('final provider request excludes private labels/diagnostics even if legacy experiences contain them',async()=>{
  const experience:SearchExperience={searchNodeId:'search-001',parentSearchNodeId:null,node:buildOrganizationPlan(initial).nodes[1]!,score:0,delta:null,outcome:'root',failures:[{caseId:'public-id',prediction:'PUBLIC_PREDICTION',expected:'PRIVATE_EXPECTED_CANARY',error:'PRIVATE_JUDGE_CANARY'}]};
  const seen:string[]=[];
  const provider:ModelProvider={async invoke(input){seen.push(JSON.stringify(input.messages));return {message:{role:'assistant',content:JSON.stringify(edit('Legal request'))},finishReason:'stop'};}};
  const runtime=createDitto({workers:[createInferWorker({defaultProvider:'fixture',providers:{fixture:provider}})]});
  try{
    const p=new NodeExpansionProposer(runtime,{provider:'fixture',model:'fixture'});
    await p.propose({dataset:'humaneval',branches:[base],vertices:[],experiences:[experience],priorRejections:[],accept(){}});
    assert.equal(seen.length,1);assert.match(seen[0]!,/PUBLIC_PREDICTION/);
    assert.doesNotMatch(seen[0]!,/PRIVATE_EXPECTED_CANARY|PRIVATE_JUDGE_CANARY/);
    const user=JSON.parse(JSON.parse(seen[0]!)[1].content);
    assert.deepEqual(user.experiments[0].failures,[{caseId:'public-id',prediction:'PUBLIC_PREDICTION'}]);
  }finally{await runtime.close();}
});

test('optimizer length is normal completion: validate received proposal without calling it a service failure',async()=>{
  let calls=0;
  const provider:ModelProvider={async invoke(){calls++;return {message:{role:'assistant',content:JSON.stringify(edit('Complete proposal at output boundary'))},finishReason:'length'};}};
  const runtime=createDitto({workers:[createInferWorker({defaultProvider:'fixture',providers:{fixture:provider}})]});
  try{
    const p=new NodeExpansionProposer(runtime,{provider:'fixture',model:'fixture'});
    const proposal=await p.propose({dataset:'humaneval',branches:[base],vertices:[],experiences:[],priorRejections:[],accept(value){assert.equal(value.operation,'replace');}});
    assert.equal(proposal.node!.id,'sample-1');assert.equal(calls,1);
  }finally{await runtime.close();}
});
