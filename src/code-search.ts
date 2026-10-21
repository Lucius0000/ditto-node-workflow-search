import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DockerPythonJudge, loadBenchmark } from './benchmark/index.js';
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

export const CODE_SEARCH_PROTOCOL = Object.freeze({ ...PROTOCOL,
  id: 'humaneval-mbpp-node-search-v3', revisionOutput: 'required-code-message-v1', searchPolicy: ORGANIZATION_VERSION,
  budgetUnit: 'completed-valid-new-workflow-excluding-initial',
  searchRounds: 2, validationRepeats: 1, testRepeats: 0,
  proposalStagnationLimit: 12, constructionStagnationLimit: 24,
});
export interface CodeSearchOptions {
  readonly dataset: 'humaneval' | 'mbpp';
  readonly mode: 'smoke' | 'search' | 'official';
  readonly directory: string;
  readonly dataDir: string;
  readonly dockerImage: string;
  readonly source?: CodeSearchSource;
  readonly selectedRun?: string;
  /** Explicitly authorized valid new workflows; initial evaluation remains separate. */
  readonly newCandidates?: number;
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
  const identity = { selectedIdentityHash: selectedManifest.identityHash as string,
    planSha256: createHash('sha256').update(planBytes).digest('hex') };
  let priorManifest;
  try { priorManifest = await readJson(join(directory, 'manifest.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (priorManifest && !isDeepStrictEqual(priorManifest.identity?.officialSelection, identity)) {
    throw Error('Run identity changed; preserve the prior run and assess affected evidence before continuing');
  }
  return { selectedRun: resolve(selectedRun), plan, identity };
}

/** Search and small engineering checks share loading, execution, scoring and identity. */
export async function runCodeSearch(options: CodeSearchOptions): Promise<void> {
  const source = options.source ?? 'official';
  const newCandidates = options.newCandidates ?? 2;
  if (!Number.isSafeInteger(newCandidates) || newCandidates < 1 || newCandidates > 10) throw Error('New-candidate budget must be an integer in [1,10]');
  const protocol = { ...CODE_SEARCH_PROTOCOL, searchRounds: newCandidates };
  if (options.mode === 'official' && source !== 'official') throw Error('Official verification requires the official source');
  const directory = resolve(options.directory);
  const selection = options.mode === 'official'
    ? await loadOfficialSelection(options.dataset, options.selectedRun, directory) : undefined;
  await mkdir(directory, { recursive: true });
  const provider = codeSearchProvider(source);
  const judge = new DockerPythonJudge({ image: options.dockerImage });
  await judge.preflight();
  const loaded = await loadBenchmark(options.dataset, { dataDir: resolve(options.dataDir), split: 'validate', codeJudge: judge });
  const selectedIds = (options.mode === 'search' ? loaded.tasks : loaded.tasks.slice(0, 5)).map(task => task.id);
  const image = await promisify(execFile)('docker', ['image', 'inspect', '--format', '{{.Id}}', options.dockerImage], { windowsHide: true });
  const codeHash = await evaluationCodeHash(process.cwd());
  const identity = { codeHash, dataset: options.dataset, data: loaded.identity, selectedIds,
    protocol, generation: GENERATION, promptProfile: baselinePromptProfile(options.dataset),
    source, endpoint: provider.baseUrl, model: provider.model, imageId: image.stdout.trim(), mode: options.mode,
    ...(selection ? { officialSelection: selection.identity } : {}) };
  const identityHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  let priorManifest: Record<string, any> | undefined;
  try { priorManifest = await readJson(join(directory, 'manifest.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (priorManifest && priorManifest.identityHash !== identityHash) throw Error('Run identity changed; preserve the prior run and assess affected evidence before continuing');
  if (priorManifest?.status === 'complete') { console.log(JSON.stringify({ phase: 'already-complete', directory })); return; }
  const manifest = { ...priorManifest, createdAt: priorManifest?.createdAt ?? new Date().toISOString(), identity, identityHash,
    operations: { providerConcurrency: provider.concurrency, evaluationConcurrency: provider.concurrency,
      requestTimeoutMs: provider.timeoutMs, providerAttempts: 3, workflowAttempts: 5, maximumTransportAttemptsPerWorkflow: 15,
      workflowSupervisorMs: 1800000, supervisorFailure: 'invalid-evaluation-not-model-zero',
      formatRepairAttempts: 2, seed: 42, testModelCalls: 0 }, status: 'running', updatedAt: new Date().toISOString() };
  await json(join(directory, 'manifest.json'), manifest);
  process.env.DITTO_PROVIDER_LOG = join(directory, 'provider.jsonl');
  const experiment = createExperimentRuntime(provider);
  const executor = new WorkflowExecutor(experiment.runtime, experiment.providerName, experiment.model);
  const event = async (value: Record<string, unknown>) => {
    const record = { at: new Date().toISOString(), ...value };
    await appendFile(join(directory, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
  };
  const evaluate = async (plan: AgentPlanSpec): Promise<EvaluationSummary> => {
    const evaluationDir = join(directory, 'evaluations', plan.leafSearchNodeId);
    await json(join(evaluationDir, 'plan.json'), plan);
    const recovery = await CaseRecovery.open(join(directory, 'case-recovery'), { identity, plan }, manifest.operations);
    const summary = await loaded.evaluate(task => executor.run(plan, task, AbortSignal.timeout(1800000)), {
      repeats: 1, concurrency: provider.concurrency, retryAttempts: 5,
      ...(options.mode === 'search' ? {} : { engineeringTaskIds: selectedIds }),
      priorCases: recovery.priorCases,
      async onCase({ completed, total, result }) {
        await recovery.record(result);
        await appendFile(join(evaluationDir, 'attempts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n', 'utf8');
        await event({ phase: 'case', candidate: plan.leafSearchNodeId, completed, total, caseId: result.caseId,
          valid: result.valid, score: result.valid ? result.score : null, error: result.error ?? null });
      },
    });
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
      stoppedBecause: result.stoppedBecause, bestPlanId: result.bestPlan.id, bestEvaluationId: result.bestPlan.leafSearchNodeId });
    await event({ phase: 'complete', mode: options.mode, bestScore: result.bestLeaf.evaluation?.score, planId: result.bestPlan.id });
  } catch (error) {
    await json(join(directory, 'manifest.json'), { ...manifest, status: 'interrupted', updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await experiment.close(); }
}
