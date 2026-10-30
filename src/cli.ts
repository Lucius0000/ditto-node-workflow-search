import { CaseRecovery, evaluationCodeHash } from "./run/case-recovery.js";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DockerPythonJudge, loadBenchmark, sha256File } from "./benchmark/index.js";
import type { BenchmarkSplit, LoadedBenchmark } from "./benchmark/types.js";
import { loadProviderSettings, parseArguments, type ExperimentOptions, type ProviderSettings } from "./config.js";
import type { DatasetName, EvaluationSummary } from "./domain.js";
import { createExperimentRuntime, type ExperimentRuntime } from "./ditto/runtime.js";
import { searchDirectedWorkflows } from "./search/directed-search.js";
import { DirectedWorkflowProposer, DIRECTED_SEARCH_POLICY } from "./search/directed-proposer.js";
import { RunStore } from "./run/store.js";
import { loadDirectedResume } from "./run/directed-resume.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { GENERATION, PROTOCOL } from "./protocol.js";
import { createWorkflowRunner } from "./workflow/runner.js";
import { assertExplicitTimeBudget } from "./execution/time-budget.js";
import { assertBaselinePromptProfile, baselinePromptProfile, baselinePrompts } from "./benchmark/baseline-prompts.js";

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  assertExplicitTimeBudget(options.timeBudget);
  const provider = Object.freeze({ ...loadProviderSettings(),
    concurrency: options.command === "search" ? options.searchProviderConcurrency : options.testProviderConcurrency });
  const experiment = createExperimentRuntime(provider, { timeBudget: options.timeBudget });
  const executor = createWorkflowRunner(experiment, provider);
  try {
    if (options.command === "search") await search(options, provider, experiment, executor);
    else await testFrozen(options, provider, executor);
  } finally {
    await experiment.close();
  }
}

async function search(
  options: ExperimentOptions,
  provider: ProviderSettings,
  experiment: ExperimentRuntime,
  executor: Pick<WorkflowExecutor, "run">,
): Promise<void> {
  const store = await RunStore.create(options.outputRoot, options.dataset);
  const loaded = await openBenchmark(options, "validate");
  const dataPath = benchmarkPath(options, "validate");
  const dataHash = loaded.identity?.rawSha256 ?? await sha256File(dataPath);
  const restored = options.resumeDir ? await loadDirectedResume(options.resumeDir, options.resumeRound!, options.dataset) : undefined;
  if (restored) {
    const prior = restored.manifest;
    if (JSON.stringify(prior.timeBudget) !== JSON.stringify(options.timeBudget)) throw Error("Resume time budget differs; a new run is required");
    assertBaselinePromptProfile(options.dataset, prior.promptProfile);
    const priorSearch = prior.search as Record<string, unknown>;
    const expected = { rounds: options.rounds, repeats: options.repeats, testRepeats: options.testRepeats,
      policy: DIRECTED_SEARCH_POLICY, convergenceConsecutiveRounds: options.patience };
    if (prior.model !== provider.model || prior.endpoint !== provider.baseUrl || prior.dataset !== options.dataset
      || prior.metricProfile !== metricProfile(options.dataset) || JSON.stringify(prior.protocol) !== JSON.stringify(PROTOCOL)
      || JSON.stringify(prior.generation) !== JSON.stringify(GENERATION) || prior.dittoVersion !== await dittoVersion()
      || (prior.data as { sha256: string }).sha256 !== dataHash
      || JSON.stringify((prior.data as { identity?: unknown }).identity) !== JSON.stringify(loaded.identity)
      || JSON.stringify((prior.data as { selectedIds: string[] }).selectedIds) !== JSON.stringify(loaded.tasks.map(task => task.id))
      || Object.entries(expected).some(([key, value]) => priorSearch[key] !== value)) throw new Error("Resume model/data/search settings differ from the frozen experiment");
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    status: "searching",
    createdAt: new Date().toISOString(),
    dataset: options.dataset,
    split: "validate",
    metricProfile: metricProfile(options.dataset),
    dittoVersion: await dittoVersion(),
    package: "@codesoul-co/ditto",
    model: provider.model,
    endpoint: provider.baseUrl,
    providerConcurrency: provider.concurrency,
    evaluationConcurrency: options.evaluationConcurrency,
    independentRoundTests: { checkpointDirectory: "checkpoints", resultsUsedBySearch: false },
    generation: GENERATION,
    timeBudget: options.timeBudget,
    protocol: PROTOCOL,
    ...(baselinePromptProfile(options.dataset) ? { promptProfile: baselinePromptProfile(options.dataset) } : {}),
    ...(restored ? { resumedFrom: { directory: options.resumeDir, completedValidEvaluations: restored.state.validEvaluations,
      pendingCandidateId: restored.state.pending?.id, originalProviderConcurrency: restored.manifest.providerConcurrency } } : {}),
    search: {
      rounds: options.rounds,
      repeats: options.repeats,
      testRepeats: options.testRepeats,
      policy: DIRECTED_SEARCH_POLICY,
      budgetUnit: "completed-valid-workflow-evaluation-including-initial",
      convergenceTopK: 3,
      convergenceZ: 0,
      convergenceConsecutiveRounds: options.patience,
    },
    data: {
      file: basename(dataPath),
      sha256: dataHash,
      selectedExamples: loaded.tasks.length,
      selectedIds: loaded.tasks.map((task) => task.id),
      identity: loaded.identity,
    },
    ...(isCodeDataset(options.dataset) ? { codeJudge: { kind: "docker", image: options.dockerImage, network: "none" } } : {}),
  };
  await store.writeManifest(manifest);
  console.log(JSON.stringify({ phase: "search-start", dataset: options.dataset, examples: loaded.tasks.length, runDirectory: store.directory }));

  const evaluate = async (plan: Parameters<WorkflowExecutor["run"]>[0]): Promise<EvaluationSummary> => {
    // Publish locally before validation. A separate process consumes these
    // files; no test score or test completion enters this search process.
    await store.saveCheckpoint(plan);
    let scoreSum = 0;
    const recovery = await CaseRecovery.open(join(options.outputRoot, "case-recovery"), {
      codeHash: await evaluationCodeHash(process.cwd()), plan, model: provider.model, endpoint: provider.baseUrl,
      protocol: PROTOCOL, generation: GENERATION, metric: metricProfile(options.dataset), dataHash,
      timeBudget: options.timeBudget,
      selectedIds: loaded.tasks.map(task => task.id), promptProfile: baselinePromptProfile(options.dataset), repeats: options.repeats,
    }, { evaluationConcurrency: options.evaluationConcurrency, providerConcurrency: provider.concurrency });
    const summary = await loaded.evaluate(
      (task) => executor.run(plan, task),
      {
        repeats: options.repeats,
        ...(options.timeBudget ? { timeBudget: options.timeBudget } : {}),
        priorCases: recovery.priorCases,
        concurrency: options.evaluationConcurrency,
        retryAttempts: 5,
        async onCase(progress) {
          scoreSum += progress.result.score;
          await recovery.record(progress.result);
          await store.saveLiveCase(plan.leafSearchNodeId, progress.result);
          console.log(JSON.stringify({
            phase: "validation-progress",
            planId: plan.id,
            completed: progress.completed,
            total: progress.total,
            caseId: progress.result.caseId,
            caseScore: progress.result.score,
            runningScore: scoreSum / progress.completed,
            failed: progress.result.error !== undefined,
            failureKind: progress.result.failureKind ?? null,
            at: new Date().toISOString(),
          }));
        },
      },
    );
    await recovery.finish(summary.valid === true);
    await store.saveEvaluation(plan.leafSearchNodeId, summary);
    return summary;
  };
  const proposer = new DirectedWorkflowProposer(experiment.runtime, experiment.providerName, experiment.model);
  let checkpointScore = Math.max(-Infinity, ...(restored?.state.history.filter(candidate => candidate.status === "valid").map(candidate => candidate.evaluation!.score) ?? []));
  if (restored) {
    const best = [...restored.state.history].filter(candidate => candidate.status === "valid").sort((a, b) => b.evaluation!.score - a.evaluation!.score)[0];
    if (best) await store.saveDirectedBest(best, restored.state.validEvaluations, "search-in-progress");
  }
  try {
    const result = await searchDirectedWorkflows({
      dataset: options.dataset, maxValidEvaluations: options.rounds, patience: options.patience,
      taskGoal: taskGoal(options.dataset), initialInstruction: initialInstruction(options.dataset),
      propose: request => proposer.propose(request), evaluate,
      ...(restored ? { resume: restored.state } : {}),
      save: state => store.saveDirectedState(state),
      async candidate(candidate, state) {
        if (candidate.status === "valid" && candidate.evaluation!.score > checkpointScore) {
          checkpointScore = candidate.evaluation!.score;
          await store.saveDirectedBest(candidate, state.validEvaluations, "search-in-progress");
        }
      },
      async event(value) {
        await store.appendEvent({ at: new Date().toISOString(), ...value });
        console.log(JSON.stringify({ phase: "search-progress", ...value }));
      },
    });
    const validation = result.best.evaluation!;
    await store.saveDirectedBest(result.best, result.state.validEvaluations, result.stoppedBecause);
    Object.assign(manifest, {
      status: "frozen", frozenAt: new Date().toISOString(),
      validEvaluations: result.state.validEvaluations, stoppedBecause: result.stoppedBecause,
      best: { leafId: result.best.id, planId: result.best.plan.id, pathHash: result.best.planHash,
        nodeCount: result.best.plan.nodes.length, validationScore: validation.score },
    });
    await store.writeManifest(manifest);
    console.log(JSON.stringify({
      phase: "search-complete",
      dataset: options.dataset,
      runDirectory: store.directory,
      frozenLeaf: result.best.id,
      nodeCount: result.best.plan.nodes.length,
      validationScore: validation.score,
      next: `test --dataset ${options.dataset} --run-dir ${store.directory}`,
    }));
  } catch (error) {
    Object.assign(manifest, {
      status: "failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    await store.writeManifest(manifest);
    throw error;
  }
}

async function testFrozen(
  options: ExperimentOptions,
  provider: ProviderSettings,
  executor: Pick<WorkflowExecutor, "run">,
): Promise<void> {
  if (!options.runDir) throw new Error("test requires --run-dir");
  const store = await RunStore.open(options.runDir);
  const manifest = await store.readManifest();
  assertBaselinePromptProfile(options.dataset, manifest.promptProfile);
  if (manifest.model !== provider.model || manifest.endpoint !== provider.baseUrl
    || JSON.stringify(manifest.timeBudget) !== JSON.stringify(options.timeBudget)
    || JSON.stringify(manifest.protocol) !== JSON.stringify(PROTOCOL)
    || JSON.stringify(manifest.generation) !== JSON.stringify(GENERATION)
    || manifest.dittoVersion !== await dittoVersion()
    || manifest.metricProfile !== metricProfile(options.dataset)) {
    throw new Error("Frozen model/endpoint/generation/protocol/scoring/runtime does not match the current test configuration");
  }
  if (manifest.status === "complete") throw new Error("Final test already exists; refusing to overwrite it");
  if (manifest.dataset !== options.dataset) {
    throw new Error(`Frozen run belongs to ${String(manifest.dataset)}, not ${options.dataset}`);
  }
  if (manifest.status !== "frozen" && manifest.status !== "complete") {
    throw new Error(`Frozen run is not ready for test: status=${String(manifest.status)}`);
  }
  const plan = await store.readBestPlan();
  const loaded = await openBenchmark(options, "test");
  const dataPath = benchmarkPath(options, "test");
  const dataHash = loaded.identity?.rawSha256 ?? await sha256File(dataPath);
  console.log(JSON.stringify({ phase: "test-start", dataset: options.dataset, examples: loaded.tasks.length, frozenPlan: plan.id }));
  let scoreSum = 0;
  const summary = await loaded.evaluate(
    (task) => executor.run(plan, task),
    {
      repeats: options.testRepeats,
      ...(options.timeBudget ? { timeBudget: options.timeBudget } : {}),
      concurrency: options.evaluationConcurrency,
      retryAttempts: 5,
      async onCase(progress) {
        scoreSum += progress.result.score;
        await store.saveLiveCase("test", progress.result);
        console.log(JSON.stringify({
          phase: "test-progress",
          planId: plan.id,
          completed: progress.completed,
          total: progress.total,
          caseId: progress.result.caseId,
          caseScore: progress.result.score,
          runningScore: scoreSum / progress.completed,
          failed: progress.result.error !== undefined,
          failureKind: progress.result.failureKind ?? null,
          at: new Date().toISOString(),
        }));
      },
    },
  );
  Object.assign(manifest, {
    completedAt: new Date().toISOString(),
    test: {
      file: basename(dataPath),
      sha256: dataHash,
      selectedExamples: loaded.tasks.length,
      selectedIds: loaded.tasks.map((task) => task.id),
      identity: loaded.identity,
      score: summary.score,
      repeats: summary.repeats,
      standardDeviation: summary.standardDeviation,
    },
    execution: { model: provider.model, endpoint: provider.baseUrl },
  });
  await store.finishTest(manifest, summary);
  console.log(JSON.stringify({ phase: "test-complete", dataset: options.dataset, examples: loaded.tasks.length, score: summary.score, runDirectory: store.directory }));
}

async function openBenchmark(options: ExperimentOptions, split: BenchmarkSplit): Promise<LoadedBenchmark> {
  if (isCodeDataset(options.dataset)) {
    const judge = new DockerPythonJudge({ image: options.dockerImage });
    await judge.preflight();
    return loadBenchmark(options.dataset, {
      dataDir: options.dataDir,
      split,
      limit: split === "validate" ? options.searchLimit : options.testLimit,
      seed: split === "validate" ? options.seed : options.seed + 1,
      codeJudge: judge,
    });
  }
  return loadBenchmark(options.dataset, {
    dataDir: options.dataDir,
    split,
    limit: split === "validate" ? options.searchLimit : options.testLimit,
    seed: split === "validate" ? options.seed : options.seed + 1,
  });
}

function benchmarkPath(options: ExperimentOptions, split: BenchmarkSplit): string {
  return join(options.dataDir, `${options.dataset}_${split}.jsonl`);
}

function isCodeDataset(dataset: DatasetName): dataset is "humaneval" | "mbpp" {
  return dataset === "humaneval" || dataset === "mbpp";
}

function metricProfile(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return "aflow-drop-token-f1-v2";
    case "humaneval": return "docker-private-tests-pass-at-1-v1";
    case "mbpp": return "docker-private-tests-pass-at-1-v1";
    case "gsm8k": return "last-number-accuracy-v1";
    case "math": return "aflow-symbolic-plus-declared-answer-normalized-v3";
    case "automationbench": throw new Error("AutomationBench requires the declarative Graph/Loop executor");
  }
}

function taskGoal(dataset: DatasetName): string {
  const goal = {
    drop: "Search a compact Ditto Node path that answers DROP reading-comprehension questions with high token F1.",
    humaneval: "Search a compact Ditto Node path that produces correct HumanEval Python functions under private tests.",
    mbpp: "Search a compact Ditto Node path that produces correct MBPP Python functions under private tests.",
    gsm8k: "Search a compact Ditto Node path that solves GSM8K word problems with correct final numbers.",
    math: "Search a compact Ditto Node path that maximizes mathematical answer accuracy on competition problems.",
    automationbench: "Execute official AutomationBench tools inside a declarative Graph/Loop.",
  }[dataset];
  const prompts = baselinePrompts(dataset);
  return prompts ? `${goal}\nThe initial root uses the pinned MFlow agent seed. These public review and integration seeds are editable references for prompt search; preserve the dataset answer contract.\n\nReview seed:\n${prompts.review}\n\nIntegration seed:\n${prompts.integrate}` : goal;
}

function initialInstruction(dataset: DatasetName): string {
  switch (dataset) {
    case "drop": return baselinePrompts(dataset)!.agent;
    case "humaneval": return "Implement the requested Python function correctly for general inputs. Return one complete Python code block and no tests.";
    case "mbpp": return "Implement the requested Python function correctly for general inputs. Return one complete Python code block and no tests.";
    case "gsm8k": return baselinePrompts(dataset)!.agent;
    // AFlow round 1 calls Custom with instruction="" and the raw problem. Keep
    // Ditto's baseline objective empty; differences added by Ditto Node
    // semantics remain the intended framework variable.
    case "math": return "";
    case "automationbench": throw new Error("AutomationBench requires the declarative Graph/Loop executor");
  }
}

async function dittoVersion(): Promise<string> {
  try {
    const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    return lock.packages?.["node_modules/@codesoul-co/ditto"]?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ phase: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
