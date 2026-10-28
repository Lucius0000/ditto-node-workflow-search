import type { BenchmarkTask, ScoreEvidence } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { searchSubset } from "./search-subset.js";
import { readBenchmarkSplit } from "./fixed-splits.js";
import { requireRecord, requireString, stableId } from "./io.js";
import { lengthBucket } from "./sampling.js";
import { scoreDropAnswer } from "./text-scores.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkIdentity, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark, PrivateScorer } from "./types.js";

interface DropRow {
  readonly task: BenchmarkTask;
  readonly reference: string;
}

export const dropAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "drop",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const { rows, identity } = await readBenchmarkSplit("drop", options, (value, row, path): DropRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.context, "context", path, row);
      const reference = requireString(raw.ref_text, "ref_text", path, row);
      const sourceId = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : stableId("row", prompt);
      return Object.freeze({
        task: Object.freeze({
          id: `drop:${sourceId}`,
          dataset: "drop",
          prompt,
          outputInstruction: "",
          metadata: Object.freeze({ split: options.split, sourceId, lengthBucket: lengthBucket(prompt.length) }),
        }),
        reference,
      });
    }, (row) => String(row.task.metadata.lengthBucket));
    return loadedDrop(options.split, rows, identity);
  },
});

function loadedDrop(split: "validate" | "test", rows: readonly DropRow[], identity: BenchmarkIdentity): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.reference]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  const scorer: PrivateScorer = {
    async score(taskId, prediction): Promise<ScoreEvidence> {
      const reference = referenceFor(references, taskId);
      if (!reference.split("|").some(part => part.trim())) throw new Error(`Invalid DROP reference for ${taskId}`);
      return scoreDropAnswer(reference, prediction);
    },
    expectedLabel(taskId): string {
      return referenceFor(references, taskId);
    },
  };
  return Object.freeze({
    dataset: "drop",
    split,
    tasks,
    identity,
    evaluate: (runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(tasks, scorer, runner, options),
    evaluateSearchSubset: (taskIds: readonly string[], runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) => evaluateTasks(searchSubset(split,tasks,taskIds),scorer,runner,options),
  });
}

function referenceFor(references: ReadonlyMap<string, string>, taskId: string): string {
  const reference = references.get(taskId);
  if (reference === undefined) throw new Error(`Unknown DROP task: ${taskId}`);
  return reference;
}
