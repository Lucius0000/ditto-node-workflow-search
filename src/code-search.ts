import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DockerPythonJudge, loadBenchmark } from './benchmark/index.js';
import {AutomationBudgetRecovery} from './run/automation-budget-recovery.js';
import { baselinePromptProfile } from './benchmark/baseline-prompts.js';
import { createExperimentRuntime } from './ditto/runtime.js';
import { codeSearchProvider, type CodeSearchSource } from './code-search-provider.js';
import { WorkflowExecutor } from './workflow/executor.js';
import { buildOrganizationPlan, initialOrganization, ORGANIZATION_VERSION, validateOrganizationPlan } from './workflow/organization.js';
import { NodeTreeWorkflowSearch } from './search/node-tree-search.js';
import { NodeExpansionProposer } from './search/node-expansion-proposer.js';
import type { SearchResumeState } from './search/optimizer.js';
import { CaseRecovery, evaluationCodeHash } from './run/case-recovery.js';
import { GENERATION, PROTOCOL } from './protocol.js';
import type { AgentPlanSpec, EvaluationSummary } from './domain.js';
import { assertValidEvaluation } from './benchmark/evaluator.js';
import {automationIdentity} from './benchmark/automation.js';
import {createAutomationTools} from './ditto/automation-tools.js';
import {checkAFlowConvergence} from './search/convergence.js';
import {timeBudgetDecision,validateTimeBudget,type SearchTimeBudget} from './search/time-budget.js';
import {AUTOMATION_EXECUTION_BUDGET} from './workflow/automation-budget.js';

export const CODE_SEARCH_PROTOCOL = Object.freeze({ ...PROTOCOL,
  id: 'sampled-parent-staged-workflow-search-v8', revisionOutput: 'required-code-message-v1', searchPolicy: ORGANIZATION_VERSION,
  workflowRetryScope:'case-repeat' as const,
  automationExecutionBudget:AUTOMATION_EXECUTION_BUDGET,
  timeStoppingPolicy:'complete-candidate-safe-boundary-v1',
  budgetUnit: 'completed-valid-new-workflow-excluding-initial',
  searchRounds: 10, validationRepeats: 5, testRepeats: 0,
  proposalStagnationLimit: 3, constructionStagnationLimit: 24,
});
export interface CodeSearchOptions {
  readonly dataset: 'humaneval' | 'mbpp' | 'automationbench';
  readonly mode: 'smoke' | 'search' | 'official';
  readonly directory: string;
  readonly dataDir: string;
  readonly dockerImage: string;
  readonly source?: CodeSearchSource;
  readonly selectedRun?: string;
  /** Explicitly authorized valid new workflows; initial evaluation remains separate. */
  readonly newCandidates?: number;
  readonly repeats?:number;
  readonly concurrency?:number;
  readonly timeBudget?:SearchTimeBudget;
}
/** Offline integration seams; production CLI never supplies overrides. */
export interface CodeSearchServices {
  readonly load?:typeof loadBenchmark;
  readonly runtime?:typeof createExperimentRuntime;
  readonly environment?:(options:CodeSearchOptions)=>Promise<Readonly<Record<string,unknown>>>;
  readonly codeHash?:()=>Promise<string>;
}
export function evaluationRepeats(mode:CodeSearchOptions['mode'],value?:number):number {
  if(!['smoke','search','official'].includes(mode))throw Error('Unknown workflow evaluation mode');
  const repeats=value??(mode==='search'?5:1);
  if(!Number.isSafeInteger(repeats)||repeats<1||repeats>20||mode!=='search'&&repeats!==1)throw Error('Search repeats must be an integer in [1,20]; smoke/official require 1');
  return repeats;
}
export function assertEvaluationMembers(summary:EvaluationSummary,ids:readonly string[],repeats:number):void {
  assertValidEvaluation(summary);
  const expected=Array.from({length:repeats},(_,r)=>ids.map(id=>`${id}#${r+1}`)).flat();
  if(summary.repeats!==repeats||summary.examples!==ids.length||!isDeepStrictEqual(summary.results.map(r=>r.caseId),expected)||summary.results.some(r=>r.valid!==true))throw Error('Evaluation lacks the exact complete ordered N x R membership');
  const means=Array.from({length:repeats},(_,r)=>summary.results.slice(r*ids.length,(r+1)*ids.length).reduce((s,c)=>s+c.score,0)/ids.length);
  const mean=means.reduce((s,v)=>s+v,0)/repeats;
  const sd=Math.sqrt(means.reduce((s,v)=>s+(v-mean)**2,0)/repeats);
  if(!isDeepStrictEqual(summary.repeatScores,means)||Math.abs(summary.score-mean)>1e-12||Math.abs(summary.standardDeviation-sd)>1e-12)throw Error('Evaluation repeat statistics differ from actual independent results');
}
const json = async (path: string, value: unknown) => {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isFinite(v) ? null : v, 2) + '\n', 'utf8');
};
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

/** Read-only selection gate, run before credentials, Docker or completed-run reuse. */
export async function loadOfficialSelection(dataset: CodeSearchOptions['dataset'], selectedRun: string | undefined, directory: string) {
  if (!selectedRun) throw Error('Official verification needs the frozen Search directory');
  const selectedManifest = await readJson(join(selectedRun, 'manifest.json'));
  const selectedIdentity = selectedManifest.identity;
  if (selectedManifest.status !== 'complete' || selectedIdentity?.mode !== 'search' || selectedIdentity.source !== 'ark-plan'
    || selectedIdentity.dataset !== dataset || selectedIdentity.protocol?.id !== CODE_SEARCH_PROTOCOL.id
    || selectedIdentity.protocol?.searchPolicy !== ORGANIZATION_VERSION
    || selectedManifest.identityHash !== createHash('sha256').update(JSON.stringify(selectedIdentity)).digest('hex')) {
    throw Error('Official verification requires a completed matching Ark Search');
  }
  const planBytes = await readFile(join(selectedRun, 'best', 'plan.json'));
  if(selectedManifest.bestPlanSha256!==createHash('sha256').update(planBytes).digest('hex'))throw Error('Frozen plan original bytes changed');
  const plan: AgentPlanSpec = JSON.parse(planBytes.toString('utf8'));
  validateOrganizationPlan(plan);
  if (plan.organization?.dataset !== dataset || plan.id !== selectedManifest.bestPlanId
    || plan.leafSearchNodeId !== selectedManifest.bestEvaluationId || !/^search-\d{3,}$/.test(plan.leafSearchNodeId)) {
    throw Error('Frozen plan differs from the selected Search best identity');
  }
  const record = await readJson(join(selectedRun, 'evaluations', plan.leafSearchNodeId, 'record.json'));
  const summary = await readJson(join(selectedRun, 'best', 'summary.json'));
  assertValidEvaluation(record.evaluation);
  assertValidEvaluation(summary);
  if (record.id !== plan.leafSearchNodeId || !isDeepStrictEqual(record.plan, plan) || !isDeepStrictEqual(record.evaluation, summary)) {
    throw Error('Frozen plan or summary differs from its selected Search evaluation');
  }
  const ids=selectedIdentity.selectedIds,repeats=selectedIdentity.protocol.validationRepeats;
  const counts={humaneval:33,mbpp:86,automationbench:200};
  if(!Array.isArray(ids)||ids.length!==counts[dataset]||new Set(ids).size!==ids.length||!Number.isSafeInteger(repeats)||repeats<1)throw Error('Selected Search membership/repeats are incomplete');
  assertEvaluationMembers(summary,ids,repeats);
  const rounds=selectedIdentity.protocol.searchRounds;
  const timeBudget=selectedIdentity.protocol.timeBudget;
  if(timeBudget)validateTimeBudget(timeBudget);
  if(!Number.isSafeInteger(rounds)||rounds<1||rounds>10||repeats>20||!isDeepStrictEqual(selectedIdentity.protocol,{...CODE_SEARCH_PROTOCOL,searchRounds:rounds,validationRepeats:repeats,...(timeBudget?{timeBudget}:{})}))throw Error('Selected Search protocol differs from the frozen staged method');
  const state=await readJson(join(selectedRun,'resume-state.json'));
  const ledger=state.nodeConstruction;
  if(ledger?.version!==2||ledger.pending||ledger.draft||!Array.isArray(ledger.evaluations)||ledger.evaluations.length<1||ledger.evaluations.length>rounds+1||state.completedRounds!==ledger.evaluations.length-1)throw Error('Search has unresolved pending/draft or incompatible completion ledger');
  let best:any;
  for(const entry of ledger.evaluations){
    if(entry.id!==`search-${String(ledger.evaluations.indexOf(entry)+1).padStart(3,'0')}`)throw Error('Search evaluation sequence differs from its allocated IDs');
    const saved=await readJson(join(selectedRun,'evaluations',entry.id,'record.json'));
    validateOrganizationPlan(saved.plan);
    if(saved.id!==entry.id||saved.plan.leafSearchNodeId!==entry.id||saved.plan.organization.dataset!==dataset)throw Error('Search record identity differs from its complete plan');
    assertEvaluationMembers(saved.evaluation,ids,repeats);
    const {results:savedResults,...savedSummary}=saved.evaluation;
    const {results:ledgerResults,...ledgerSummary}=entry.evaluation;
    if(!isDeepStrictEqual(saved.plan,entry.plan)||!isDeepStrictEqual(savedSummary,ledgerSummary))throw Error('Search evaluation ledger differs from its full record');
    if(!best||saved.evaluation.score>best.evaluation.score)best=saved;
  }
  if(best?.id!==plan.leafSearchNodeId||ledger.bestEvaluationId!==best.id)throw Error('Frozen best is not the earliest highest valid Search evaluation');
  const converged=checkAFlowConvergence(ledger.evaluations.map((r:any)=>r.evaluation),3,0,5).converged;
  if(selectedManifest.stoppedBecause==='time-budget'){
    const proof=selectedManifest.timeBudgetStop;
    if(!timeBudget||!proof||!Number.isFinite(Date.parse(proof.checkedAt))||Date.parse(proof.checkedAt)>Date.now()+1000
      ||converged||state.completedRounds>=rounds||!isDeepStrictEqual(proof,timeBudgetDecision(timeBudget,ledger.evaluations.map((r:any)=>r.evaluation.durationMs),state.completedRounds,Date.parse(proof.checkedAt))))throw Error('Search time-budget stop lacks independently replayable safe-boundary evidence');
  }else if(selectedManifest.stoppedBecause==='converged'?!converged:selectedManifest.stoppedBecause!=='max-rounds'||state.completedRounds!==selectedIdentity.protocol.searchRounds)throw Error('Search did not terminate normally at its budget/convergence boundary');
  const identity = { selectedIdentityHash: selectedManifest.identityHash as string,
    planSha256: createHash('sha256').update(planBytes).digest('hex') };
  let priorManifest;
  try { priorManifest = await readJson(join(directory, 'manifest.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (priorManifest && !isDeepStrictEqual(priorManifest.identity?.officialSelection, identity)) {
    throw Error('Run identity changed; preserve the prior run and assess affected evidence before continuing');
  }
  return { selectedRun: resolve(selectedRun), plan, identity,sourceIdentity:selectedIdentity };
}

/** Search and small engineering checks share loading, execution, scoring and identity. */
export async function runCodeSearch(options: CodeSearchOptions,services:CodeSearchServices={}): Promise<void> {
  const source = options.source ?? 'official';
  const newCandidates = options.newCandidates ?? 10;
  if (!Number.isSafeInteger(newCandidates) || newCandidates < 1 || newCandidates > 10) throw Error('New-candidate budget must be an integer in [1,10]');
  const repeats=evaluationRepeats(options.mode,options.repeats);
  if(options.timeBudget){validateTimeBudget(options.timeBudget);if(options.mode!=='search')throw Error('Time stopping is Search-only');}
  let protocol = { ...CODE_SEARCH_PROTOCOL, searchRounds: newCandidates,validationRepeats:repeats,...(options.timeBudget?{timeBudget:options.timeBudget}:{}) };
  if (options.mode === 'official' && source !== 'official') throw Error('Official verification requires the official source');
  const directory = resolve(options.directory);
  const selection = options.mode === 'official'
    ? await loadOfficialSelection(options.dataset, options.selectedRun, directory) : undefined;
  if(selection)protocol={...selection.sourceIdentity.protocol,validationRepeats:1};
  await mkdir(directory, { recursive: true });
  const baseProvider=codeSearchProvider(source);
  const concurrency=options.concurrency??baseProvider.concurrency;
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw Error('Invalid shared concurrency');
  const provider={...baseProvider,concurrency};
  const automation=options.dataset==='automationbench';
  const judge=automation?undefined:new DockerPythonJudge({image:options.dockerImage});
  if(judge&&!services.environment)await judge.preflight();
  const loaded = await (services.load??loadBenchmark)(options.dataset, { dataDir: resolve(options.dataDir), split: 'validate', ...(judge?{codeJudge:judge}:{}),artifactDir:directory });
  const selectedIds = (options.mode === 'smoke' ? loaded.tasks.slice(0, 5) : loaded.tasks).map(task => task.id);
  const environment=services.environment?await services.environment(options):automation?{automation:await automationIdentity()}:{imageId:(await promisify(execFile)('docker', ['image', 'inspect', '--format', '{{.Id}}', options.dockerImage], { windowsHide: true })).stdout.trim()};
  const codeHash = services.codeHash?await services.codeHash():await evaluationCodeHash(process.cwd());
  const identity = { codeHash, dataset: options.dataset, data: loaded.identity, selectedIds,
    protocol, generation: GENERATION, promptProfile: baselinePromptProfile(options.dataset),
    source, endpoint: provider.baseUrl, model: provider.model,returnedModel:provider.expectedResponseModel,...environment,mode:options.mode,
    ...(selection ? { officialSelection: selection.identity } : {}) };
  const identityHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  if(selection){
    const selected=await readJson(join(selection.selectedRun,'manifest.json'));
    const prior=selected.identity;
    if(prior.codeHash!==codeHash||!isDeepStrictEqual(prior.data,identity.data)||!isDeepStrictEqual(prior.selectedIds,selectedIds)
      ||!isDeepStrictEqual(prior.generation,identity.generation)||!isDeepStrictEqual(prior.promptProfile,identity.promptProfile)
      ||!isDeepStrictEqual(automation?prior.automation:prior.imageId,automation?(identity as any).automation:(identity as any).imageId))throw Error('Official evaluation code/data/environment differs from its frozen Search');
  }
  let priorManifest: Record<string, any> | undefined;
  try { priorManifest = await readJson(join(directory, 'manifest.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (priorManifest && priorManifest.identityHash !== identityHash) throw Error('Run identity changed; preserve the prior run and assess affected evidence before continuing');
  if(priorManifest?.status==='running')throw Error('Unclean run has no proven interruption boundary; automatic recovery is refused until its attempt evidence is reviewed');
  if (priorManifest?.status === 'complete') { console.log(JSON.stringify({ phase: 'already-complete', directory })); return; }
  const manifest = { ...priorManifest, createdAt: priorManifest?.createdAt ?? new Date().toISOString(), identity, identityHash,
    operations: { providerConcurrency: provider.concurrency, evaluationConcurrency: provider.concurrency,
      requestTimeoutMs: provider.timeoutMs, providerAttempts: 3, workflowAttempts: 5,workflowRetryScope:CODE_SEARCH_PROTOCOL.workflowRetryScope, maximumTransportAttemptsPerWorkflow: 15,
      workflowSupervisorMs: 1800000, supervisorFailure: 'invalid-evaluation-not-model-zero',
      formatRepairAttempts: 2, seed: 42, testModelCalls: 0 }, status: 'running', updatedAt: new Date().toISOString() };
  await json(join(directory, 'manifest.json'), manifest);
  process.env.DITTO_PROVIDER_LOG = join(directory, 'provider.jsonl');
  const experiment = (services.runtime??createExperimentRuntime)(provider,automation?{profile:'automationbench',tools:createAutomationTools()}:{});
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  const event = async (value: Record<string, unknown>) => {
    const record = { at: new Date().toISOString(), ...value };
    await appendFile(join(directory, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
  };
  const evaluate = async (plan: AgentPlanSpec): Promise<EvaluationSummary> => {
    const evaluationDir = join(directory, 'evaluations', plan.leafSearchNodeId);
    await json(join(evaluationDir, 'plan.json'), plan);
    const recovery = await CaseRecovery.open(join(directory, 'case-recovery'), { identity, plan }, manifest.operations,true);
    const summary = await loaded.evaluate(task => executor.run(plan, task, AbortSignal.timeout(1800000)), {
      repeats, concurrency: provider.concurrency, retryAttempts: 5,workflowRetryScope:CODE_SEARCH_PROTOCOL.workflowRetryScope,
      ...(options.mode === 'smoke' ? { engineeringTaskIds: selectedIds } : {}),
      priorCases: recovery.priorCases,
      ...(automation?{automationBudgetPersistence:new AutomationBudgetRecovery(join(directory,'automation-budgets'),recovery.identity)}:{}),
      async onCase({ completed, total, result }) {
        await recovery.record(result);
        await appendFile(join(evaluationDir, 'attempts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n', 'utf8');
        await event({ phase: 'case', candidate: plan.leafSearchNodeId, completed, total, caseId: result.caseId,
          valid: result.valid, score: result.valid ? result.score : null, error: result.error ?? null });
      },
    });
    if(summary.valid===true)assertEvaluationMembers(summary,selectedIds,repeats);
    await recovery.finish(summary.valid === true);
    await json(join(evaluationDir, 'results.json'), summary);
    return summary;
  };
  try {
    if (options.mode !== 'search') {
      let plan: AgentPlanSpec;
      if (options.mode === 'official') {
        plan = selection!.plan;
        await json(join(directory, 'selection.json'), { selectedRun: selection!.selectedRun, plan,
          ...selection!.identity, selectionUsesOfficialResults: false });
      } else plan = buildOrganizationPlan(initialOrganization(options.dataset));
      const summary = await evaluate(plan);
      assertValidEvaluation(summary);
      await json(join(directory, 'summary.json'), summary);
      await json(join(directory, 'manifest.json'), { ...manifest, status: 'complete', completedAt: new Date().toISOString() });
      await event({ phase: 'complete', mode: options.mode, score: summary.score, examples: summary.examples });
      return;
    }
    let state: SearchResumeState | undefined;
    try { state = await readJson(join(directory, 'resume-state.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const proposer = new NodeExpansionProposer(experiment.runtime, { provider: experiment.providerName, model: experiment.model });
    const search = new NodeTreeWorkflowSearch({ dataset: options.dataset, rounds: newCandidates, patience: 5, maxDepth: 23,
      ...(options.timeBudget?{timeBudget:options.timeBudget}:{}),
      restoreEvaluation:async id=>readJson(join(directory,'evaluations',id,'record.json')),
      evaluate, proposer, ...(state ? { resume: state } : {}), callbacks: {
        event, state: value => json(join(directory, 'resume-state.json'), value),
        async node(node) { await appendFile(join(directory, 'nodes.jsonl'), JSON.stringify(node) + '\n', 'utf8'); },
        async workflow(record, experience) {
          await json(join(directory, 'evaluations', record.id, 'record.json'), record);
          await json(join(directory, 'evaluations', record.id, 'experience.json'), experience);
        },
      } });
    const result = await search.run();
    await json(join(directory, 'best', 'plan.json'), result.bestPlan);
    await json(join(directory, 'best', 'summary.json'), result.bestLeaf.evaluation);
    await json(join(directory, 'manifest.json'), { ...manifest, status: 'complete', completedAt: new Date().toISOString(),
      stoppedBecause: result.stoppedBecause, bestPlanId: result.bestPlan.id, bestEvaluationId: result.bestPlan.leafSearchNodeId,
      ...(result.timeBudgetStop?{timeBudgetStop:result.timeBudgetStop}:{}),
      bestPlanSha256:createHash('sha256').update(await readFile(join(directory,'best','plan.json'))).digest('hex') });
    await event({ phase: 'complete', mode: options.mode, bestScore: result.bestLeaf.evaluation?.score, planId: result.bestPlan.id });
  } catch (error) {
    await json(join(directory, 'manifest.json'), { ...manifest, status: 'interrupted', updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await experiment.close(); }
}
