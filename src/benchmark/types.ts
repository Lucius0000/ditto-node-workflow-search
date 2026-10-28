import type {
  AgentRunResult,
  BenchmarkTask,
  CaseResult,
  DatasetName,
  EvaluationSummary,
  ScoreEvidence,
} from "../domain.js";

export type BenchmarkSplit = "validate" | "test";

/** A workflow runner receives public problem material only. */
export type BenchmarkRunner = (task: BenchmarkTask) => Promise<AgentRunResult>;

export interface BenchmarkLoadOptions {
  readonly dataDir: string;
  readonly split: BenchmarkSplit;
  /** Formal runs verify the pinned MFlow file and preserve every row in order. */
  readonly dataMode?: "formal" | "fixture";
  /** Zero means the complete split. Nonzero limits are allowed only for explicit fixtures. */
  readonly limit?: number;
  readonly seed?: number;
  readonly codeJudge?: CodeJudge;
}

/** Public provenance only: no reference answers or private judge material. */
export interface BenchmarkIdentity {
  readonly protocol: "aflow-fixed-v1" | "fixture";
  readonly dataMode: "formal" | "fixture";
  readonly baselineRepository: string;
  readonly baselineCommit: string;
  readonly upstreamCommit: string;
  readonly sourceFile: string;
  readonly rawSha256: string;
  readonly sourceCount: number;
  readonly selectedCount: number;
  readonly splitRole: "search" | "test";
  readonly verified: boolean;
  readonly knownPromptOverlaps: readonly {
    readonly searchId: string;
    readonly testId: string;
    readonly promptHash: string;
  }[];
}

export interface BenchmarkEvaluationOptions {
  readonly timeBudget?: import("../execution/time-budget.js").TimeBudgetPolicy;
  readonly repeats?: number;
  readonly concurrency?: number;
  readonly retryAttempts?: number;
  /** Caller must verify the complete execution identity before supplying recovery records. */
  readonly priorCases?: readonly CaseResult[];
  /** Called after each case finishes; useful for live progress without exposing private judge data. */
  readonly onCase?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly result: CaseResult;
  }) => void | Promise<void>;
}

/**
 * Gold answers and executable tests are deliberately absent. Evaluation is a
 * closure over a private reference map created while loading the split.
 */
export interface LoadedBenchmark {
  readonly dataset: DatasetName;
  readonly split: BenchmarkSplit;
  readonly tasks: readonly BenchmarkTask[];
  readonly identity?: BenchmarkIdentity;
  evaluate(runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions): Promise<EvaluationSummary>;
  /** Validation-only, with private scoring material retained inside the adapter. */
  evaluateSearchSubset?(taskIds: readonly string[], runner: BenchmarkRunner, options?: BenchmarkEvaluationOptions): Promise<EvaluationSummary>;
}

export interface BenchmarkAdapter {
  readonly dataset: DatasetName;
  load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark>;
}

export interface PrivateScorer {
  score(taskId: string, prediction: string): Promise<ScoreEvidence>;
  expectedLabel(taskId: string): string;
}

export interface CodeJudgeRequest {
  readonly dataset: "humaneval" | "mbpp";
  readonly taskId: string;
  readonly entryPoint: string;
  readonly candidate: string;
  readonly testSource: string;
  readonly testImports: readonly string[];
}

export interface CodeJudgeResult {
  readonly passed: boolean;
  readonly diagnostics: string;
  readonly durationMs: number;
}

export interface CodeJudge {
  judge(request: CodeJudgeRequest, signal?: AbortSignal): Promise<CodeJudgeResult>;
}
