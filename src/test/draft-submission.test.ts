import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraftSubmission,prepareExpansion,type ConstructionBranch,type CandidateDraft,type NodeExpansion} from '../search/node-construction.js';
import {initialOrganization} from '../workflow/organization.js';
import {NodeTreeWorkflowSearch} from '../search/node-tree-search.js';
import type {EvaluationSummary} from '../domain.js';

function fixture(){
  const initial=initialOrganization('automationbench');
  const parent:ConstructionBranch={id:'branch-parent',baseBranchId:null,leafVertexId:'v1',nodes:initial.nodes,vertexByNode:Object.fromEntries(initial.nodes.map(n=>[n.id,'v1'])),assembly:initial};
  const actor=structuredClone(parent.nodes.find(n=>n.id==='actor')!);
  const edit:NodeExpansion={baseBranchId:parent.id,anchorNodeId:'actor',operation:'replace',node:{...actor,config:{...actor.config,instruction:'Resolve the requested records, act and verify.'}}};
  const base=prepareExpansion('automationbench',parent,edit,'branch-draft','v2',24).branch;
  const draft:CandidateDraft={selection:{parentEvaluationId:'search-001',parentBranchId:parent.id,pool:[{id:'search-001',score:.5,probability:1}],randomBefore:42,randomAfter:11355432,sample:11355432/2**32},branchId:base.id,edits:[edit],submitted:false};
  const raw:NodeExpansion={baseBranchId:base.id,anchorNodeId:'actor',operation:'replace',node:structuredClone(base.nodes.find(n=>n.id==='actor')!),submit:true};
  return {parent,base,draft,raw};
}

test('explicit same-binding replacement commits an existing edited draft without a new node',()=>{
  const {base,draft,raw}=fixture(),saved=structuredClone(raw);
  const normalized=normalizeDraftSubmission(base,draft,raw);
  assert.deepEqual(normalized,{baseBranchId:base.id,anchorNodeId:'actor',operation:'submit',submit:true});
  const result=prepareExpansion('automationbench',base,normalized,'branch-submitted','v3',24);
  assert.ok(result.plan);assert.equal(result.node,undefined);assert.deepEqual(result.branch.nodes,base.nodes);assert.deepEqual(raw,saved);
});

test('normalization validates original fields and never drops a real edit or attached assembly',()=>{
  const {base,draft,raw}=fixture();
  assert.throws(()=>normalizeDraftSubmission(base,draft,{...raw,hidden:true} as NodeExpansion),/Unsupported/);
  assert.throws(()=>normalizeDraftSubmission(base,draft,{...raw,removeNodeId:'actor'}),/combine/);
  const changed={...raw,node:{...raw.node!,config:{...raw.node!.config,instruction:'A different actual edit.'}}};
  assert.equal(normalizeDraftSubmission(base,draft,changed),changed);
  const a=base.assembly!;
  const assembly={...raw,assembly:{graphs:a.graphs,entryGraphId:a.entryGraphId,transitions:a.transitions,outputNodeId:a.outputNodeId}};assert.equal(normalizeDraftSubmission(base,draft,assembly),assembly);
  const noCommit={...raw,submit:false};assert.equal(normalizeDraftSubmission(base,draft,noCommit),noCommit);
  assert.throws(()=>prepareExpansion('automationbench',base,noCommit,'b-next','v3',24),/must change/);
});

test('normalization requires current unsubmitted edited draft and exact branch anchor and binding',()=>{
  const {parent,base,draft,raw}=fixture();
  for(const state of [undefined,{...draft,edits:[]},{...draft,submitted:true},{...draft,branchId:parent.id},{...draft,selection:{...draft.selection,parentBranchId:base.id}}])assert.equal(normalizeDraftSubmission(base,state,raw),raw);
  for(const proposal of [{...raw,baseBranchId:parent.id},{...raw,anchorNodeId:'context'},{...raw,node:{...raw.node!,feedback:[]}}])assert.equal(normalizeDraftSubmission(base,draft,proposal),proposal);
});

test('normalization cannot close an incomplete draft or bypass fixed generation validation',()=>{
  const {base,draft,raw}=fixture();
  const incomplete={...base,assembly:{...base.assembly!,outputNodeId:'missing'}};
  const normalized=normalizeDraftSubmission(incomplete,draft,raw);
  assert.throws(()=>prepareExpansion('automationbench',incomplete,normalized,'b-next','v3',24),/Output/);
  const forged=structuredClone(base);(forged.nodes.find(n=>n.id==='actor')!.config as Record<string,unknown>).generation={temperature:1,maxTokens:1};
  const forgedProposal={...raw,node:structuredClone(forged.nodes.find(n=>n.id==='actor')!)};
  assert.throws(()=>prepareExpansion('automationbench',forged,normalizeDraftSubmission(forged,draft,forgedProposal),'b-next','v3',24),/generation|Generation/);
});

test('real NodeTree accepts model-shaped commit and records original and canonical proposals',async()=>{
  const events:Readonly<Record<string,unknown>>[]=[],scores:number[]=[],states:unknown[]=[];let calls=0;
  const evaluation=(score:number):EvaluationSummary=>({valid:true,score,standardDeviation:0,repeats:1,examples:1,successfulRuns:1,failedRuns:0,timeoutRuns:0,wrongRuns:0,inputTokens:0,outputTokens:0,totalTokens:0,durationMs:0,results:[]});
  const result=await new NodeTreeWorkflowSearch({dataset:'automationbench',rounds:1,patience:5,evaluate:async()=>{const score=scores.length?.75:.5;scores.push(score);return evaluation(score);},callbacks:{async event(e){events.push(e);},async state(s){states.push(structuredClone(s));}},proposer:{async propose(r){
    calls++;const branch=r.branches[0]!,actor=structuredClone(branch.nodes.find(n=>n.id==='actor')!);
    const proposal:NodeExpansion={baseBranchId:branch.id,anchorNodeId:'actor',operation:'replace',node:calls===1?{...actor,config:{...actor.config,instruction:'Resolve exact records and verify writes.'}}:actor,...(calls===2?{submit:true}:{})};
    r.accept(proposal);return proposal;
  }}}).run();
  assert.equal(calls,2);assert.deepEqual(scores,[.5,.75]);assert.equal(result.stoppedBecause,'max-rounds');
  const normalized=events.filter(e=>e.type==='proposal-normalized');assert.equal(normalized.length,1);
  assert.equal((normalized[0]!.originalProposal as NodeExpansion).operation,'replace');assert.equal((normalized[0]!.proposal as NodeExpansion).operation,'submit');
  assert.equal(events.filter(e=>e.type==='parent-selected').length,1);
  assert.equal(events.filter(e=>e.type==='node-expanded'&&e.operation==='replace').length,1);
  assert.equal(events.filter(e=>e.type==='path-evaluated').length,1);
  assert.ok(states.length>0);
});
