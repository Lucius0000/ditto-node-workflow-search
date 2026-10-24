import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBenchmark, sha256File } from "./benchmark/index.js";
import { loadProviderSettings } from "./config.js";
import { createExperimentRuntime } from "./ditto/runtime.js";
import { PROTOCOL } from "./protocol.js";
import { parseRoundTestArguments } from "./round-test-config.js";
import { discoverCheckpoints, writeArtifact, type WorkflowCheckpoint } from "./run/checkpoints.js";
import { IndependentRoundTests } from "./run/independent-tests.js";
import { acquireTestLock } from "./run/test-lock.js";
import { createWorkflowRunner } from "./workflow/runner.js";
import { assertExplicitTimeBudget, type TimeBudgetPolicy } from "./execution/time-budget.js";

async function main(): Promise<void> {
  const options = parseRoundTestArguments(process.argv.slice(2));
  const discovered = await discoverCheckpoints(options.runDirectory);
  const testFile = join(options.dataDirectory, "math_test.jsonl");
  const testDataHash = await sha256File(testFile);
  const manifest = JSON.parse(await readFile(join(options.runDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (manifest.dataset !== "math") throw new Error("This independent runner currently supports MATH only");
  if (manifest.metricProfile !== "aflow-symbolic-plus-declared-answer-normalized-v3") throw new Error("Test scoring must match the frozen search scoring version");
  const benchmark = await loadBenchmark("math", { dataDir: options.dataDirectory, split: "test", limit: 0, seed: 43 });
  if (options.dryRun) {
    // No runtime/provider construction, writes, scorer process or model calls.
    console.log(JSON.stringify({ phase: "round-test-dry-run", searchRun: options.runDirectory,
      output: options.outputDirectory, model: manifest.model, metricProfile: manifest.metricProfile,
      testExamples: benchmark.tasks.length, testDataHash, repeats: options.repeats,
      sampleConcurrency: options.concurrency, providerConcurrency: options.providerConcurrency,
      workflowConcurrency: options.workflowConcurrency, checkpoints: discovered.map((checkpoint) => ({
        id: checkpoint.searchNodeId, planId: checkpoint.plan.id, planHash: checkpoint.planHash, nodeCount: checkpoint.plan.nodes.length,
      })), readOnlySearch: true, scoresReturnedToSearch: false }, null, 2));
    return;
  }
  const provider = Object.freeze({ ...loadProviderSettings(), concurrency: options.providerConcurrency });
  const timeBudget = manifest.timeBudget as TimeBudgetPolicy | undefined;
  assertExplicitTimeBudget(timeBudget);
  if (manifest.model !== provider.model || manifest.endpoint !== provider.baseUrl || JSON.stringify(manifest.protocol) !== JSON.stringify(PROTOCOL)) throw new Error("Test model/endpoint/protocol differs from frozen search");
  const releaseLock = await acquireTestLock(options.outputDirectory);
  const experiment = createExperimentRuntime(provider, { timeBudget });
  const executor = createWorkflowRunner(experiment, provider);
  const validate = (checkpoint: WorkflowCheckpoint): void => {
    if (checkpoint.dataset !== "math" || checkpoint.model !== provider.model || checkpoint.endpoint !== provider.baseUrl
      || checkpoint.metricProfile !== manifest.metricProfile || checkpoint.dittoVersion !== manifest.dittoVersion
      || JSON.stringify(checkpoint.protocol) !== JSON.stringify(PROTOCOL)) throw new Error("Checkpoint metadata differs from the frozen experiment");
    if (JSON.stringify(checkpoint.timeBudget) !== JSON.stringify(timeBudget)) throw Error("Checkpoint time budget differs from frozen search");
  };
  const runner = new IndependentRoundTests({
    outputDirectory: options.outputDirectory, workflowConcurrency: options.workflowConcurrency,
    sampleConcurrency: options.concurrency, providerConcurrency: options.providerConcurrency,
    testDataHash, testRepeats: options.repeats,
  }, async (checkpoint, onCase) => {
    validate(checkpoint);
    if (await sha256File(testFile) !== testDataHash) throw new Error("The fixed test set changed");
    return benchmark.evaluate((task) => executor.run(checkpoint.plan, task), {
      repeats: options.repeats, concurrency: options.concurrency, retryAttempts: 5, timeBudget,
      async onCase(progress) {
        await onCase(progress.result);
        console.log(JSON.stringify({ phase: "round-test-progress", searchNodeId: checkpoint.searchNodeId,
          completed: progress.completed, total: progress.total, caseId: progress.result.caseId,
          caseScore: progress.result.score, failed: progress.result.error !== undefined, at: new Date().toISOString() }));
      },
    });
  });
  const saveStatus = async (): Promise<void> => writeArtifact(join(options.outputDirectory, "status.json"), {
    at: new Date().toISOString(), searchRun: options.runDirectory, testDataHash,
    model: provider.model, sampleConcurrency: options.concurrency, providerConcurrency: options.providerConcurrency,
    pending: runner.pending, jobs: runner.jobs, scoresReturnedToSearch: false,
  });
  try {
    do {
      for (const checkpoint of await discoverCheckpoints(options.runDirectory)) { validate(checkpoint); await runner.enqueue(checkpoint); }
      await saveStatus();
      const latest = JSON.parse(await readFile(join(options.runDirectory, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (!options.watch || ["frozen", "complete", "failed"].includes(String(latest.status))) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    } while (true);
    await runner.drain();
    await saveStatus();
    console.log(JSON.stringify({ phase: "round-tests-complete", jobs: runner.jobs }));
  } finally {
    try { await runner.drain(); await experiment.close(); }
    finally { await releaseLock(); }
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ phase: "round-test-runner-error", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
