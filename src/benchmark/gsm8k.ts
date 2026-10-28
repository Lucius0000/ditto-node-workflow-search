import type { BenchmarkTask, ScoreEvidence } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { searchSubset } from "./search-subset.js";
import { readBenchmarkSplit } from "./fixed-splits.js";
import { requireRecord, requireString, stableId } from "./io.js";
import { lengthBucket } from "./sampling.js";
import { extractLastNumber, scoreGsm8kAnswer } from "./text-scores.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkIdentity, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark, PrivateScorer } from "./types.js";

interface Gsm8kRow {
  readonly task: BenchmarkTask;
  readonly reference: string;
}

export const gsm8kAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "gsm8k",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const { rows, identity } = await readBenchmarkSplit("gsm8k", options, (value, row, path): Gsm8kRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.question, "question", path, row);
      const reference = requireString(raw.answer, "answer", path, row);
      const sourceId = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : stableId("row", prompt);
      return Object.freeze({
        task: Object.freeze({
          id: `gsm8k:${sourceId}`,
          dataset: "gsm8k",
          prompt,
          outputInstruction: "",
          metadata: Object.freeze({ split: options.split, sourceId, lengthBucket: lengthBucket(prompt.length) }),
        }),
        reference,
      });
    }, (row) => String(row.task.metadata.lengthBucket));
    return loadedGsm8k(options.split, rows, identity);
  },
});

function loadedGsm8k(split: "validate" | "test", rows: readonly Gsm8kRow[], identity: BenchmarkIdentity): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.reference]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  const scorer: PrivateScorer = {
    async score(taskId, prediction): Promise<ScoreEvidence> {
      const reference = referenceFor(references, taskId);
      if (extractLastNumber(reference) === undefined) throw new Error(`Invalid GSM8K reference for ${taskId}`);
      return scoreGsm8kAnswer(reference, prediction);
    },
    expectedLabel(taskId): string {
      return referenceFor(references, taskId);
    },
  };
  return Object.freeze({
    dataset: "gsm8k",
    split,
    tasks,
    identity,
    evaluate: (runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(tasks, scorer, runner, options),
    evaluateSearchSubset: (taskIds: readonly string[], runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(searchSubset(split,tasks,taskIds),scorer,runner,options),
  });
}

function referenceFor(references: ReadonlyMap<string, string>, taskId: string): string {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown GSM8K task: ${taskId}`);
  return reference;
}
