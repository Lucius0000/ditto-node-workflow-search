import type { BenchmarkTask, DatasetName, ScoreEvidence } from "../domain.js";
import { DockerPythonJudge, extractPythonCandidate } from "./docker-python-judge.js";
import { evaluateTasks } from "./evaluator.js";
import { searchSubset } from "./search-subset.js";
import { readBenchmarkSplit } from "./fixed-splits.js";
import { requireRecord, requireString, requireStringArray } from "./io.js";
import { lengthBucket } from "./sampling.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkIdentity, BenchmarkLoadOptions, BenchmarkRunner, CodeJudge, LoadedBenchmark, PrivateScorer } from "./types.js";

interface CodeReference {
  readonly publicPrompt: string;
  readonly entryPoint: string;
  readonly canonicalSolution: string;
  readonly testSource: string;
  readonly testImports: readonly string[];
}

interface CodeRow {
  readonly task: BenchmarkTask;
  readonly reference: CodeReference;
}

export const humanevalAdapter: BenchmarkAdapter = createCodeAdapter("humaneval");
export const mbppAdapter: BenchmarkAdapter = createCodeAdapter("mbpp");

function createCodeAdapter(dataset: "humaneval" | "mbpp"): BenchmarkAdapter {
  return Object.freeze({
    dataset,
    async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
      return dataset === "humaneval" ? loadHumanEval(options) : loadMbpp(options);
    },
  });
}

async function loadHumanEval(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
  const { rows, identity } = await readBenchmarkSplit("humaneval", options, (value, row, path): CodeRow => {
    const raw = requireRecord(value, path, row);
    const sourceId = requireString(raw.task_id, "task_id", path, row);
    const prompt = requireString(raw.prompt, "prompt", path, row);
    const entryPoint = requireString(raw.entry_point, "entry_point", path, row);
    const reference: CodeReference = Object.freeze({
      publicPrompt: prompt,
      entryPoint,
      canonicalSolution: requireString(raw.canonical_solution, "canonical_solution", path, row),
      testSource: requireString(raw.test, "test", path, row),
      testImports: Object.freeze([]),
    });
    return codeRow("humaneval", options.split, sourceId, prompt, entryPoint, reference);
  }, (row) => String(row.task.metadata.lengthBucket));
  return loadedCode("humaneval", options.split, rows, options.codeJudge ?? new DockerPythonJudge(), identity);
}

async function loadMbpp(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
  const { rows, identity } = await readBenchmarkSplit("mbpp", options, (value, row, path): CodeRow => {
    const raw = requireRecord(value, path, row);
    const rawId = raw.task_id;
    if (typeof rawId !== "string" && typeof rawId !== "number") throw new Error(`Expected task_id at ${path}:${row}`);
    const sourceId = String(rawId);
    const prompt = requireString(raw.prompt, "prompt", path, row);
    const entryPoint = requireString(raw.entry_point, "entry_point", path, row);
    const reference: CodeReference = Object.freeze({
      publicPrompt: prompt,
      entryPoint,
      canonicalSolution: requireString(raw.code, "code", path, row),
      testSource: requireString(raw.test, "test", path, row),
      testImports: raw.test_imports === undefined ? Object.freeze([]) : requireStringArray(raw.test_imports, "test_imports", path, row),
    });
    return codeRow("mbpp", options.split, sourceId, prompt, entryPoint, reference);
  }, (row) => String(row.task.metadata.lengthBucket));
  return loadedCode("mbpp", options.split, rows, options.codeJudge ?? new DockerPythonJudge(), identity);
}

function codeRow(
  dataset: "humaneval" | "mbpp",
  split: "validate" | "test",
  sourceId: string,
  prompt: string,
  entryPoint: string,
  reference: CodeReference,
): CodeRow {
  return Object.freeze({
    task: Object.freeze({
      id: `${dataset}:${sourceId}`,
      dataset,
      prompt,
      outputInstruction: "",
      metadata: Object.freeze({ split, sourceId, entryPoint, lengthBucket: lengthBucket(prompt.length) }),
    }),
    reference,
  });
}

function loadedCode(
  dataset: "humaneval" | "mbpp",
  split: "validate" | "test",
  rows: readonly CodeRow[],
  judge: CodeJudge,
  identity: BenchmarkIdentity,
): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.reference]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  const scorer: PrivateScorer = {
    async score(taskId, prediction): Promise<ScoreEvidence> {
      const reference = referenceFor(references, taskId, dataset);
      // MBPP places its Python signature after a natural-language description.
      const promptLines = reference.publicPrompt.split(/\r?\n/);
      const firstCodeLine = dataset === "mbpp"
        ? promptLines.findIndex(line => /^(?:from\s+\S+\s+import\s+|import\s+|(?:async\s+)?def\s+)/.test(line)) : 0;
      const codePrompt = firstCodeLine < 0 ? "" : promptLines.slice(firstCodeLine).join("\n");
      const candidate = extractPythonCandidate(prediction, codePrompt, reference.entryPoint);
      const judged = await judge.judge({
        dataset,
        taskId,
        entryPoint: reference.entryPoint,
        candidate,
        testSource: reference.testSource,
        testImports: reference.testImports,
      });
      return Object.freeze({
        score: judged.passed ? 1 : 0,
        expected: "pass private tests",
        prediction,
        normalizedExpected: "pass",
        normalizedPrediction: judged.passed ? "pass" : "fail",
        method: `${dataset}-docker-pass-at-1`,
        details: Object.freeze({ candidate, diagnostics: judged.diagnostics, judgeDurationMs: judged.durationMs }),
      });
    },
    expectedLabel(taskId): string {
      referenceFor(references, taskId, dataset);
      return "pass private tests";
    },
  };
  return Object.freeze({
    dataset,
    split,
    tasks,
    identity,
    evaluate: (runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(tasks, scorer, runner, options),
    evaluateSearchSubset: (taskIds: readonly string[], runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(searchSubset(split,tasks,taskIds),scorer,runner,options),
  });
}

function referenceFor(references: ReadonlyMap<string, CodeReference>, taskId: string, dataset: DatasetName): CodeReference {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown ${dataset} task: ${taskId}`);
  return reference;
}
