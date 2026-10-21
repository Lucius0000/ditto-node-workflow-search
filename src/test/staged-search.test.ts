import test from 'node:test';
import assert from 'node:assert/strict';
import {timeBudgetDecision} from '../search/time-budget.js';
import {NodeTreeWorkflowSearch} from '../search/node-tree-search.js';
import {NodeExpansionRejectedError,type ExpansionRequest} from '../search/node-expansion-proposer.js';
import {prepareExpansion,type ConstructionBranch,type NodeExpansion} from '../search/node-construction.js';
import {buildOrganizationPlan,initialOrganization} from '../workflow/organization.js';
import type {EvaluationSummary} from '../domain.js';
import type {SearchResumeState} from '../search/optimizer.js';

const evaluation=(score:number):EvaluationSummary=>({valid:true,score,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:score===0?1:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[]});
const edit=(r:ExpansionRequest,instruction:string,submit=false):NodeExpansion=>({baseBranchId:r.branches[0]!.id,anchorNodeId:'sample-1',operation:'replace',node:{id:'sample-1',template:'sample',dependencies:['context'],config:{instruction}},submit});

test('time stopping uses a clean complete-candidate boundary and keeps an already selected draft',async()=>{
  const policy={deadlineAt:'2026-01-01T00:10:00Z',guardAt:'2026-01-01T00:05:00Z',minimumCandidateMs:1000,reserveMs:1000,safetyFactor:2};
  let clock=Date.parse('2026-01-01T00:00:00Z'),steps=0,valid=0,saved:SearchResumeState|undefined;
  const result=await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:10,patience:5,timeBudget:policy,now:()=>clock,
    evaluate:async()=>{valid++;return {...evaluation(.5),durationMs:1000};},callbacks:{async state(s){saved=s;}},
    proposer:{async propose(r){steps++;if(steps===1){clock=Date.parse(policy.deadlineAt)+1;return edit(r,'Paid construction started before deadline');}return {baseBranchId:r.branches[0]!.id,anchorNodeId:'sample-1',operation:'submit',submit:true};}}}).run();
  assert.equal(steps,2);assert.equal(valid,2);assert.equal(result.stoppedBecause,'time-budget');
  assert.equal(saved!.completedRounds,1);assert.equal(saved!.nodeConstruction!.draft,undefined);assert.equal(saved!.nodeConstruction!.pending,undefined);
  assert.equal(result.timeBudgetStop!.reason,'deadline-reached');assert.equal(result.bestPlan.leafSearchNodeId,'search-001');
  assert.equal(timeBudgetDecision(policy,[1000],0,Date.parse('2026-01-01T00:04:59Z')),undefined);
  assert.equal(timeBudgetDecision(policy,[120000],1,Date.parse('2026-01-01T00:07:00Z'))!.reason,'insufficient-safe-window');
});

test('expired time budget never hides an invalid pending evaluation',async()=>{
  const policy={deadlineAt:'2026-01-01T00:00:01Z',guardAt:'2026-01-01T00:00:00Z',minimumCandidateMs:1,reserveMs:0,safetyFactor:1};
  let calls=0;
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:10,patience:5,timeBudget:policy,now:()=>Date.parse('2026-01-01T01:00:00Z'),
    evaluate:async()=>{calls++;return {...evaluation(0),valid:false,failedRuns:1};},proposer:{async propose(){throw Error('not allowed');}}}).run(),/Invalid evaluation/);
  assert.equal(calls,1);
});

test('one sampled parent admits two different node edits, keeps runnable drafts unscored, and submits once',async()=>{
  let evaluated=0,steps=0;const selections:unknown[]=[];
  const result=await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,evaluate:async()=>{evaluated++;return evaluation(.5);},callbacks:{async event(e){if(e.type==='parent-selected')selections.push(e);}},proposer:{async propose(r){
    assert.equal(evaluated,1,'no draft score before explicit submit');assert.equal(r.branches.length,1);
    assert.equal(r.selectedParent!.parentEvaluationId,'search-001');
    if(steps++===0)return {baseBranchId:r.branches[0]!.id,anchorNodeId:'context',operation:'replace',node:{id:'context',template:'context',dependencies:[],config:{includeTaskMetadata:true}}};
    if(steps===2)return edit(r,'Changed second node, same candidate');
    return {baseBranchId:r.branches[0]!.id,anchorNodeId:'sample-1',operation:'submit',submit:true};
  }}}).run();
  assert.equal(steps,3);assert.equal(evaluated,2);assert.equal(selections.length,1);assert.equal(result.experiences[1]!.parentSearchNodeId,'search-001');
});

test('removal and dangling assembly are legal drafts; only closure can be submitted',()=>{
  const initial=initialOrganization('humaneval');
  const base:ConstructionBranch={id:'branch-1',baseBranchId:null,leafVertexId:'v2',nodes:initial.nodes,vertexByNode:{context:'v1','sample-1':'v2'},assembly:initial};
  const partial=prepareExpansion('humaneval',base,{baseBranchId:base.id,anchorNodeId:'context',operation:'remove',removeNodeId:'sample-1'},'branch-2','v3',24);
  assert.equal(partial.plan,undefined);assert.ok(partial.branch.assembly);
  assert.throws(()=>prepareExpansion('humaneval',partial.branch,{baseBranchId:'branch-2',anchorNodeId:'context',operation:'submit',submit:true},'branch-3','v3',24),/Output/);
  const repaired=prepareExpansion('humaneval',partial.branch,{baseBranchId:'branch-2',anchorNodeId:'context',operation:'add',submit:true,
    node:{id:'replacement',template:'sample',dependencies:['context'],config:{instruction:'Solve the public task.'}},
    assembly:{graphs:[{id:'solve',nodeIds:['context','replacement']}],entryGraphId:'solve',transitions:{solve:{kind:'end'}},outputNodeId:'replacement'}},'branch-3','v3',24);
  assert.ok(repaired.plan);
  assert.throws(()=>prepareExpansion('humaneval',base,{baseBranchId:base.id,anchorNodeId:'context',operation:'organize',assembly:{...initial,transitions:{solve:{kind:'next',graphId:12}}} as never},'branch-2','v3',24),/Unsupported|Invalid/);
});

test('draft and selected PRNG state survive interruption without resampling or baseline evaluation',async()=>{
  let saved:SearchResumeState|undefined;
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:1,patience:5,evaluate:async()=>evaluation(.5),proposer:{async propose(r){return edit(r,'Retained draft');}},callbacks:{async state(s){saved=structuredClone(s);if(s.nodeConstruction?.draft?.edits.length===1)throw Error('interrupt');}}}).run(),/interrupt/);
  const selection=saved!.nodeConstruction!.draft!.selection;
  let calls=0;const selections:unknown[]=[];
  await new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:1,patience:5,resume:saved!,evaluate:async()=>{calls++;return evaluation(0);},callbacks:{async event(e){if(e.type==='parent-selected')selections.push(e);}},proposer:{async propose(r){
    assert.deepEqual(r.selectedParent,selection);
    return {baseBranchId:r.branches[0]!.id,anchorNodeId:'sample-1',operation:'submit',submit:true};
  }}}).run();
  assert.equal(calls,1);assert.deepEqual(selections,[]);
  const changed=structuredClone(saved!);(changed.nodeConstruction!.draft!.selection as {parentEvaluationId:string}).parentEvaluationId='search-999';
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'mbpp',rounds:1,patience:5,resume:changed,evaluate:async()=>evaluation(1),proposer:{async propose(r){return edit(r,'Must not run',true);}}}).run(),/selected-parent/);
});

test('cross-parent proposals are denied and repeated rejected batches cannot consume or redraw',async()=>{
  let attempts=0;const selections:unknown[]=[];
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,evaluate:async()=>evaluation(0),callbacks:{async event(e){if(e.type==='parent-selected')selections.push(e);}},proposer:{async propose(r){
    attempts++;assert.throws(()=>r.accept({...edit(r,'Illegal'),baseBranchId:'branch-other'}),/selected parent/);
    throw new NodeExpansionRejectedError([{content:'{}',error:'cross-parent denied'}]);
  }}}).run(),/3 consecutive rejected/);
  assert.equal(attempts,3);assert.equal(selections.length,1);
});

test('accepted edit limit is independent of candidate count and does not freeze progress',async()=>{
  let evaluated=0,steps=0;
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,evaluate:async()=>{evaluated++;return evaluation(0);},proposer:{async propose(r){return edit(r,`Unsubmitted step ${++steps}`);}}}).run(),/24 accepted partial edits/);
  assert.equal(evaluated,1);assert.equal(steps,24);
});

test('six equal complete evaluations converge even on the last budget boundary',async()=>{
  let calls=0;
  const result=await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:5,patience:5,evaluate:async()=>{calls++;return evaluation(0);},proposer:{async propose(r){return edit(r,`Candidate ${r.experiences.length}`,true);}}}).run();
  assert.equal(calls,6);assert.equal(result.stoppedBecause,'converged');assert.equal(result.bestPlan.leafSearchNodeId,'search-001');
});

test('recovery rehydrates original full best evidence and never republishes compact inherited records',async()=>{
  let saved:SearchResumeState|undefined;const full=new Map<string,any>();let count=0;
  const evaluate=async()=>{count++;if(count===2)throw Error('interrupted candidate');return {...evaluation(1),results:[{caseId:'public#1',score:1,valid:true,expected:'public',prediction:'answer',normalizedExpected:'public',normalizedPrediction:'answer',method:'offline',latencyMs:0,inputTokens:0,outputTokens:0,totalTokens:0}]} satisfies EvaluationSummary;};
  await assert.rejects(new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,evaluate,proposer:{async propose(r){return edit(r,'Pending changed workflow',true);}},callbacks:{async state(s){saved=structuredClone(s);},async workflow(r){full.set(r.id,structuredClone(r));}}}).run(),/interrupted candidate/);
  let inheritedWrites=0;
  const result=await new NodeTreeWorkflowSearch({dataset:'humaneval',rounds:1,patience:5,resume:saved!,restoreEvaluation:async id=>full.get(id),evaluate:async()=>evaluation(0),proposer:{async propose(){throw Error('Pending must resume without a proposal');}},callbacks:{async workflow(r){if(r.id==='search-001')inheritedWrites++;}}}).run();
  assert.equal(result.bestLeaf.evaluation!.results.length,1);assert.equal(inheritedWrites,0);
  assert.doesNotThrow(()=>buildOrganizationPlan(result.bestPlan.organization!));
});
