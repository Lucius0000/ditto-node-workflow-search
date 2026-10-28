import { createHash } from "node:crypto";
import type { BenchmarkTask } from "../domain.js";
import { evaluateTasks } from "./evaluator.js";
import { searchSubset } from "./search-subset.js";
import { AFlowMathScorer } from "./aflow-math-scorer.js";
import { readBenchmarkSplit } from "./fixed-splits.js";
import { requireRecord, requireString } from "./io.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkIdentity, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark } from "./types.js";

interface MathRow {
  readonly task: BenchmarkTask;
  readonly solution: string;
}

export const mathAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "math",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    const { rows, identity } = await readBenchmarkSplit("math", options, (value, row, path): MathRow => {
      const raw = requireRecord(value, path, row);
      const prompt = requireString(raw.problem, "problem", path, row);
      const solution = requireString(raw.solution, "solution", path, row);
      const level = typeof raw.level === "string" ? raw.level : "unknown";
      const type = typeof raw.type === "string" ? raw.type : "unknown";
      return Object.freeze({
        task: Object.freeze({
          id: `math:${createHash("sha256").update(prompt).digest("hex")}`,
          dataset: "math",
          prompt,
          // AFlow's initial MATH workflow supplies the raw problem with no
          // additional answer-format instruction. Its scorer handles boxed and
          // final-sentence answers, so Ditto must not receive a stricter prompt.
          outputInstruction: "",
          metadata: Object.freeze({ split: options.split, level, type }),
        }),
        solution,
      });
    }, (row) => `${row.task.metadata.type}:${row.task.metadata.level}`);
    return loadedMath(options.split, rows, identity);
  },
});

function loadedMath(split: "validate" | "test", rows: readonly MathRow[], identity: BenchmarkIdentity): LoadedBenchmark {
  const references = new Map(rows.map((row) => [row.task.id, row.solution]));
  const tasks = Object.freeze(rows.map((row) => row.task));
  return Object.freeze({
    dataset: "math",
    split,
    tasks,
    identity,
    async evaluate(runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) {
      const scorer = new AFlowMathScorer(references);
      try {
        await scorer.preflight();
        return await evaluateTasks(tasks, scorer, runner, options);
      } finally {
        await scorer.close();
      }
    },
    async evaluateSearchSubset(taskIds: readonly string[], runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions) {
      const selected=searchSubset(split,tasks,taskIds);
      const scorer=new AFlowMathScorer(references);
      try {await scorer.preflight();return await evaluateTasks(selected,scorer,runner,options);}
      finally {await scorer.close();}
    },
  });
}
