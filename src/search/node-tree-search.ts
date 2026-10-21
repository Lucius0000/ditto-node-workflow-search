import type {AgentPlanSpec,EvaluationSummary,SearchExperience,SearchTreeNode} from '../domain.js';
import {isDeepStrictEqual} from 'node:util';
import type {OrganizationSpec} from '../workflow/organization-types.js';
import {initialOrganization,buildOrganizationPlan,organizationHash} from '../workflow/organization.js';
import {EMPTY_STATISTICS} from '../workflow/spec.js';
import type {SearchResult,SearchResumeState,SearchCallbacks} from './optimizer.js';
import {assertValidEvaluation} from '../benchmark/evaluator.js';
import {checkAFlowConvergence} from './convergence.js';
import {SeededRandom} from './random.js';
import {selectParent,parentDistribution} from './selector.js';
import {timeBudgetDecision,validateTimeBudget,type SearchTimeBudget,type TimeBudgetStop} from './time-budget.js';
const PROPOSAL_STAGNATION_LIMIT=3, CONSTRUCTION_STAGNATION_LIMIT=24;
import {NodeExpansionRejectedError,type ExpansionRejection,type ExpansionRequest} from './node-expansion-proposer.js';
import {constructionHash,executionTopologyHash,organizationFor,prepareExpansion,normalizeDraftSubmission,type CandidateDraft,type ConstructionBranch,type NodeConstructionState,type NodeExpansion,type WorkflowEvaluation} from './node-construction.js';

export class NodeTreeStalledError extends Error {
  constructor(detail:string){super(`Node construction search stalled: ${detail}; no budget consumed and no freeze/Test permitted`);this.name='NodeTreeStalledError';}
}
export interface NodeTreeOptions {
  readonly dataset:OrganizationSpec['dataset'];
  readonly rounds:number;
  readonly patience:number;
  readonly maxDepth?:number;
  readonly seed?:number;
  readonly topK?:number;
  readonly timeBudget?:SearchTimeBudget;
  readonly now?:()=>number;
  readonly evaluate:(plan:AgentPlanSpec)=>Promise<EvaluationSummary>;
  readonly proposer:{propose(request:ExpansionRequest):Promise<NodeExpansion>};
  readonly resume?:SearchResumeState;
  readonly restoreEvaluation?:(id:string)=>Promise<WorkflowEvaluation>;
  readonly callbacks?:Partial<SearchCallbacks>&{
    readonly workflow?:(record:WorkflowEvaluation,experience:SearchExperience,leaf:SearchTreeNode)=>Promise<void>;
  };
}

/** Tree vertices are real immutable node instances/versions. Experiments live in a separate ledger. */
export class NodeTreeWorkflowSearch {
  constructor(readonly options:NodeTreeOptions){
    if(!Number.isSafeInteger(options.rounds)||options.rounds<1)throw Error('Effective experiment budget must be a positive integer');
    if(options.timeBudget)validateTimeBudget(options.timeBudget);
  }
  async run():Promise<SearchResult>{
    const o=this.options;
    const tree=new Map<string,SearchTreeNode>();
    const branches=new Map<string,ConstructionBranch>();
    const records:WorkflowEvaluation[]=[];const experiences:SearchExperience[]=[];
    const rejections:ExpansionRejection[]=[];
    let nextVertex=1,nextBranch=1,nextEvaluation=1,completed=0,failures=0,streak=0,partialSteps=0,best='';
    let pending:NodeConstructionState['pending'];
    let draft:CandidateDraft|undefined;
    const random=new SeededRandom(o.seed??42);
    const emit=async(event:Record<string,unknown>)=>o.callbacks?.event?.(event);
    const branchId=()=>`branch-${String(nextBranch).padStart(6,'0')}`;
    const vertexId=()=>`node-${String(nextVertex).padStart(6,'0')}`;
    const evalId=()=>`search-${String(nextEvaluation).padStart(3,'0')}`;
    const save=async()=>{
      const state:NodeConstructionState={version:2,dataset:o.dataset,branches:[...branches.values()],evaluations:records.map(r=>({...r,evaluation:{...r.evaluation,results:[]}})),
        bestEvaluationId:best,nextVertex,nextBranch,nextEvaluation,constructionStepsSinceEvaluation:partialSteps,...(pending?{pending}:{}),...(draft?{draft}:{})};
      await o.callbacks?.state?.({schemaVersion:1,nodes:[...tree.values()],experiences,evaluationHistory:records.map(r=>({score:r.evaluation.score,standardDeviation:r.evaluation.standardDeviation})),
        completedRounds:completed,proposalFailures:failures,nextSearchIndex:nextEvaluation,bestLeafId:records.find(r=>r.id===best)?.leafVertexId??'',randomState:random.state,
        consecutiveProposalFailures:streak,nodeConstruction:state,nodeExpansionRejections:rejections.slice(-12)});
    };
    if(o.resume){
      const s=o.resume.nodeConstruction;
      if(!s||s.version!==2||s.dataset!==o.dataset)throw Error('Resume requires the same sampled-parent explicit-submit construction protocol');
      random.restore(o.resume.randomState);
      completed=o.resume.completedRounds;failures=o.resume.proposalFailures;streak=o.resume.consecutiveProposalFailures??0;
      if(completed>o.rounds)throw Error('Resume exceeds effective experiment budget');
      for(const node of o.resume.nodes){
        if(tree.has(node.id)||node.evaluation)throw Error('Real node ledger cannot contain workflow evaluations or duplicate vertices');
        if(node.searchParentId!==null&&!tree.has(node.searchParentId))throw Error('Missing real node parent');
        tree.set(node.id,{...node,statistics:{...node.statistics,bestScore:node.statistics.visits?node.statistics.bestScore:Number.NEGATIVE_INFINITY}});
      }
      for(const branch of s.branches){
        if(branches.has(branch.id)||!tree.has(branch.leafVertexId)||branch.baseBranchId!==null&&!branches.has(branch.baseBranchId))throw Error('Broken construction ancestry');
        if(branch.nodes.length!==Object.keys(branch.vertexByNode).length)throw Error('Broken active node mapping');
        for(const n of branch.nodes){const vertex=tree.get(branch.vertexByNode[n.id]!);if(!vertex||vertex.node.id!==n.id||JSON.stringify(vertex.organizationBinding)!==JSON.stringify(n))throw Error('Missing actual node instance');}
        branches.set(branch.id,branch);
      }
      for(const stored of s.evaluations){
        const r=o.restoreEvaluation?await o.restoreEvaluation(stored.id):stored;
        if(o.restoreEvaluation&&!isDeepStrictEqual({...r,evaluation:{...r.evaluation,results:[]} },stored))throw Error('Saved full evaluation differs from the recovery ledger');
        assertValidEvaluation(r.evaluation);
        const b=branches.get(r.branchId);if(!b||!tree.has(r.leafVertexId)||r.topologyHash!==executionTopologyHash(organizationFor(o.dataset,b))||JSON.stringify(buildOrganizationPlan(organizationFor(o.dataset,b),r.id))!==JSON.stringify(r.plan))throw Error('Resumed workflow ledger differs from its node construction');
        if(r.nodeVertexIds.some(id=>!tree.has(id)))throw Error('Missing evaluated node instance');
        records.push(r);
      }
      if(completed!==Math.max(0,records.length-1))throw Error('Effective budget differs from valid workflow ledger');
      best=s.bestEvaluationId;if(best&&!records.some(r=>r.id===best))throw Error('Missing best evaluated workflow');
      if(records.some(r=>r.evaluation.score>(records.find(x=>x.id===best)?.evaluation.score??-Infinity)))throw Error('Resumed best is not the highest validation score');
      nextVertex=s.nextVertex;nextBranch=s.nextBranch;nextEvaluation=s.nextEvaluation;partialSteps=s.constructionStepsSinceEvaluation;pending=s.pending;draft=s.draft;
      if(draft&&(!records.some(r=>r.id===draft!.selection.parentEvaluationId&&r.branchId===draft!.selection.parentBranchId)||!branches.has(draft.branchId)||draft.selection.randomAfter!==random.state))throw Error('Broken resumed selected-parent/draft identity');
      if(draft){
        const candidates=records.map(r=>({...tree.get(r.leafVertexId)!,id:r.id,evaluation:r.evaluation}));
        const distribution=parentDistribution(candidates,o.topK??4),replay=new SeededRandom(1);
        replay.restore(draft.selection.randomBefore);
        const selected=selectParent(candidates,o.topK??4,replay);
        const pool=distribution.pool.map((n,i)=>({id:n.id,score:n.evaluation!.score,probability:distribution.probabilities[i]!}));
        if(selected.id!==draft.selection.parentEvaluationId||replay.state!==draft.selection.randomAfter||draft.selection.sample!==replay.state/0x1_0000_0000||!isDeepStrictEqual(pool,draft.selection.pool))throw Error('Resumed parent selection cannot be independently replayed');
        const ancestry:ConstructionBranch[]=[];let current=branches.get(draft.branchId)!;
        while(current.id!==draft.selection.parentBranchId){
          if(ancestry.length>=25||!current.baseBranchId)throw Error('Draft left its selected parent ancestry');
          ancestry.unshift(current);current=branches.get(current.baseBranchId)!;
        }
        if(ancestry.length!==draft.edits.length)throw Error('Draft edit ledger differs from its branch ancestry');
        if(partialSteps!==draft.edits.filter(e=>e.operation!=='submit').length)throw Error('Draft edit counter differs from its accepted edit ledger');
        for(let i=0;i<ancestry.length;i++){
          const child=ancestry[i]!,proposal=draft.edits[i]!;
          const replayed=prepareExpansion(o.dataset,current,proposal,child.id,child.leafVertexId,Math.min(24,(o.maxDepth??10)+1));
          if(!isDeepStrictEqual(replayed.branch,child)||proposal.submit===true&&i!==ancestry.length-1)throw Error('Draft edits differ from immutable node versions or submitted before completion');
          current=child;
        }
      }
      if((draft?.submitted??false)!==!!(pending&&records.length))throw Error('Pending candidate differs from explicit submit state');
      rejections.push(...o.resume.nodeExpansionRejections??[]);experiences.push(...o.resume.experiences);
      if(pending){const b=branches.get(pending.branchId);if(!b||JSON.stringify(buildOrganizationPlan(organizationFor(o.dataset,b),pending.plan.leafSearchNodeId))!==JSON.stringify(pending.plan))throw Error('Pending node workflow identity differs');}
      for(const v of tree.values())await o.callbacks?.node?.(v,null);
      // Existing full evidence remains immutable; never overwrite it with compact summaries.
      for(const r of records)if(!experiences.some(e=>e.searchNodeId===r.id))throw Error('Missing evaluation experience');
      await emit({type:'search-resumed',completedRounds:completed,realNodes:tree.size,effectiveExperiments:completed});
    }else{
      const spec=initialOrganization(o.dataset),plan=buildOrganizationPlan(spec);
      let parent:string|null=null;const active:OrganizationSpec['nodes'][number][]=[];const mapping:Record<string,string>={};
      for(let i=0;i<spec.nodes.length;i++){
        const binding=spec.nodes[i]!,id=vertexId();nextVertex++;active.push(binding);mapping[binding.id]=id;
        const branch:ConstructionBranch={id:branchId(),baseBranchId:i?`branch-${String(nextBranch-1).padStart(6,'0')}`:null,
          leafVertexId:id,nodes:structuredClone(active),vertexByNode:{...mapping},...(i===spec.nodes.length-1?{assembly:{graphs:spec.graphs,entryGraphId:spec.entryGraphId,transitions:spec.transitions,outputNodeId:spec.outputNodeId,...(spec.outputByGraph?{outputByGraph:spec.outputByGraph}:{})}}:{})};
        nextBranch++;branches.set(branch.id,branch);
        const node:SearchTreeNode={id,searchParentId:parent,depth:parent?tree.get(parent)!.depth+1:0,organizationBinding:binding,node:plan.nodes.find(n=>n.id===binding.id)!,pathHash:constructionHash(branch),statistics:EMPTY_STATISTICS};
        tree.set(id,node);await o.callbacks?.node?.(node,null);parent=id;
      }
      const initial=[...branches.values()].at(-1)!;
      pending={branchId:initial.id,plan:buildOrganizationPlan(spec,evalId())};
      await save();
    }

    const evaluatePending=async()=>{
      const p=pending!;const branch=branches.get(p.branchId)!;
      const summary=await o.evaluate(p.plan);
      assertValidEvaluation(summary); // Fault leaves exactly this workflow pending; no budget/history entry.
      const baseline=records.length===0;
      const inherited=draft?records.find(r=>r.id===draft!.selection.parentEvaluationId):undefined;
      const delta=baseline?null:inherited?summary.score-inherited.evaluation.score:summary.score-records[0]!.evaluation.score;
      const record:WorkflowEvaluation={id:p.plan.leafSearchNodeId,branchId:branch.id,leafVertexId:branch.leafVertexId,
        nodeVertexIds:Object.values(branch.vertexByNode),plan:p.plan,topologyHash:executionTopologyHash(p.plan.organization!),evaluation:summary,...(inherited?{parentEvaluationId:inherited.id}:{})};
      const leaf=tree.get(branch.leafVertexId)!;
      const experience:SearchExperience={searchNodeId:record.id,parentSearchNodeId:inherited?.id??null,constructionBranchId:branch.id,...(baseline?{}:{comparisonEvaluationId:inherited!.id}),node:leaf.node,organization:p.plan.organization!,
        score:summary.score,delta,outcome:delta===null?'root':delta>0?'improved':delta<0?'regressed':'tied',
        failures:summary.results.filter(r=>r.score===0).slice(0,5).map(r=>({caseId:r.caseId,prediction:r.prediction,expected:''}))};
      // Associate measured WORKFLOW outcomes only with nodes actually active in it.
      // These participation statistics are not independent causal node scores.
      for(const id of record.nodeVertexIds){const v=tree.get(id)!;const visits=v.statistics.visits+1,scoreSum=v.statistics.scoreSum+summary.score;
        const updated={...v,statistics:{visits,scoreSum,meanScore:scoreSum/visits,bestScore:Math.max(v.statistics.bestScore,summary.score),failedRuns:v.statistics.failedRuns+summary.failedRuns,
          totalTokens:v.statistics.totalTokens+summary.totalTokens,totalLatencyMs:v.statistics.totalLatencyMs+summary.durationMs}};
        tree.set(id,updated);await o.callbacks?.node?.(updated,null);
      }
      records.push(record);experiences.push(experience);
      if(!best||summary.score>records.find(r=>r.id===best)!.evaluation.score)best=record.id;
      await o.callbacks?.workflow?.(record,experience,{...tree.get(record.leafVertexId)!,evaluation:summary,pathHash:organizationHash(p.plan.organization!)});
      pending=undefined;draft=undefined;nextEvaluation++;if(!baseline)completed++;streak=0;partialSteps=0;
      await emit({type:baseline?'baseline-evaluated':'path-evaluated',evaluationId:record.id,branchId:branch.id,leafVertexId:record.leafVertexId,
        score:summary.score,effectiveExperiments:completed,round:completed});
      await save();
    };
    const guard=()=>{
      if(streak>=PROPOSAL_STAGNATION_LIMIT)throw new NodeTreeStalledError(`${streak} consecutive rejected proposal batches`);
      if(partialSteps>=CONSTRUCTION_STAGNATION_LIMIT)throw new NodeTreeStalledError(`${partialSteps} accepted partial edits without a completed experiment`);
    };
    let stoppedBecause:SearchResult['stoppedBecause']='max-rounds';
    let timeBudgetStop:TimeBudgetStop|undefined;
    if(pending)await evaluatePending();
    while(true){
      const convergence=checkAFlowConvergence(records.map(r=>r.evaluation),3,0,o.patience);
      await emit({type:'convergence-checked',round:completed,effectiveExperiments:completed,...convergence});
      if(convergence.converged){stoppedBecause='converged';break;}
      if(completed>=o.rounds)break;
      // Never abandon a paid evaluation, selected-parent draft or unresolved fault.
      // A pending evaluation was completed above; only this clean boundary freezes.
      if(!draft&&o.timeBudget){
        timeBudgetStop=timeBudgetDecision(o.timeBudget,records.map(r=>r.evaluation.durationMs),completed,(o.now??Date.now)());
        if(timeBudgetStop){stoppedBecause='time-budget';await emit({type:'time-budget-stopped',...timeBudgetStop});break;}
      }
      guard();
      if(!draft){
        const candidates=records.map(r=>({...tree.get(r.leafVertexId)!,id:r.id,evaluation:r.evaluation}));
        const {pool,probabilities}=parentDistribution(candidates,o.topK??4);
        const before=random.state,parent=selectParent(candidates,o.topK??4,random);
        const record=records.find(r=>r.id===parent.id)!;
        draft={selection:{parentEvaluationId:record.id,parentBranchId:record.branchId,
          pool:pool.map((n,i)=>({id:n.id,score:n.evaluation!.score,probability:probabilities[i]!})),randomBefore:before,randomAfter:random.state,sample:random.state/0x1_0000_0000},
          branchId:record.branchId,edits:[],submitted:false};
        await save();await emit({type:'parent-selected',...draft.selection});
      }
      let prepared:ReturnType<typeof prepareExpansion>|undefined;
      const normalize=(proposal:NodeExpansion)=>normalizeDraftSubmission(branches.get(draft!.branchId)!,draft,proposal);
      const accept=(original:NodeExpansion)=>{
        const proposal=normalize(original);
        if(proposal.baseBranchId!==draft!.branchId)throw Error('Cannot change the selected parent or fork another draft during construction');
        const base=branches.get(draft!.branchId)!;
        const result=prepareExpansion(o.dataset,base,proposal,branchId(),vertexId(),Math.min(24,(o.maxDepth??10)+1));
        if(proposal.submit&&result.plan&&records.some(r=>r.topologyHash===executionTopologyHash(result.plan!.organization!)))throw Error('Duplicate evaluated execution topology, including cosmetic renames');
        if(proposal.operation!=='submit'&&[...branches.values()].some(b=>constructionHash(b)===constructionHash(result.branch)))throw Error('Duplicate construction state; choose a different node or wiring');
        prepared=result;
      };
      let proposal:NodeExpansion;
      try{
        const original=await o.proposer.propose({dataset:o.dataset,selectedParent:draft.selection,currentDraft:draft,progress:{effectiveExperiments:completed,budget:o.rounds,partialSteps,maxActiveNodes:Math.min(24,(o.maxDepth??10)+1)},branches:[branches.get(draft.branchId)!],vertices:[...tree.values()],experiences,priorRejections:rejections,accept});
        proposal=normalize(original);
        accept(proposal); // Custom proposers cannot bypass validation.
        if(!isDeepStrictEqual(original,proposal))await emit({type:'proposal-normalized',rule:'unchanged-replace-explicit-submit-v1',parentEvaluationId:draft.selection.parentEvaluationId,draftBranchId:draft.branchId,originalProposal:structuredClone(original),proposal:structuredClone(proposal)});
      }catch(error){
        if(!(error instanceof NodeExpansionRejectedError))throw error;
        failures++;streak++;rejections.push(...error.rejections);rejections.splice(0,Math.max(0,rejections.length-12));
        await emit({type:'proposal-failed',effectiveExperiments:completed,rejectedProposalBatches:failures,consecutiveProposalFailures:streak,error:error.message});
        await save();guard();continue;
      }
      const result=prepared!;const b=result.branch;nextBranch++;
      if(result.node){const v:SearchTreeNode={id:vertexId(),searchParentId:result.parentVertexId!,depth:tree.get(result.parentVertexId!)!.depth+1,organizationBinding:proposal.node!,node:result.node,pathHash:constructionHash(b),statistics:EMPTY_STATISTICS};
        tree.set(v.id,v);nextVertex++;await o.callbacks?.node?.(v,null);
      }
      branches.set(b.id,b);streak=0;if(proposal.operation!=='submit')partialSteps++;
      draft={...draft!,branchId:b.id,edits:[...draft!.edits,structuredClone(proposal)],submitted:proposal.submit===true};
      await emit({type:'node-expanded',branchId:b.id,baseBranchId:b.baseBranchId,anchorNodeId:proposal.anchorNodeId,operation:proposal.operation,proposal:structuredClone(proposal),
        ...(result.node?{vertexId:b.leafVertexId,nodeId:result.node.id}:{}),assembled:!!result.plan,effectiveExperiments:completed});
      if(proposal.submit===true)pending={branchId:b.id,plan:buildOrganizationPlan(organizationFor(o.dataset,b),evalId())};
      await save();
      if(pending)await evaluatePending();
    }
    const chosen=records.find(r=>r.id===best);if(!chosen)throw Error('No valid evaluated workflow to freeze');
    const bestLeaf={...tree.get(chosen.leafVertexId)!,evaluation:chosen.evaluation,pathHash:organizationHash(chosen.plan.organization!)};
    await save();
    return {nodes:[...tree.values()],experiences,bestLeaf,bestPlan:chosen.plan,bestPath:chosen.nodeVertexIds.map(id=>tree.get(id)!),stoppedBecause,...(timeBudgetStop?{timeBudgetStop}:{})};
  }
}
