import type { DeliberationMode, ReflectionMode } from "@codesoul-co/ditto/worker/infer";

export const DATASETS = ["drop", "humaneval", "mbpp", "gsm8k", "math"] as const;
export type DatasetName = (typeof DATASETS)[number];

export const STRATEGIES = ["cot", "long-cot", "tot", "got", "self-consistency"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export type SearchableNodeType =
  | "CONTEXT.LOAD"
  | "INFER.REASONING.SAMPLE"
  | "INFER.REASONING.TRAJECTORY"
  | "INFER.REASONING.REFLECT"
  | "INFER.REASONING.DELIBERATE";

export interface GenerationSpec {
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface ContextLoadNodeSpec {
  readonly id: string;
  readonly type: "CONTEXT.LOAD";
  readonly graphId: "prepare";
  readonly dependencies: readonly [];
  readonly config: { readonly includeTaskMetadata: boolean };
}

export interface SampleNodeSpec {
  readonly id: string;
  readonly type: "INFER.REASONING.SAMPLE";
  readonly graphId: "solve" | "refine";
  readonly dependencies: readonly string[];
  readonly config: {
    readonly role: "solver" | "finalizer";
    readonly instruction: string;
    readonly generation: GenerationSpec;
  };
}

export interface TrajectoryNodeSpec {
  readonly id: string;
  readonly type: "INFER.REASONING.TRAJECTORY";
  readonly graphId: "solve";
  readonly dependencies: readonly string[];
  readonly config: {
    readonly instruction: string;
    readonly strategy: StrategyName;
    readonly options: Readonly<Record<string, number>>;
    readonly generation: GenerationSpec;
    readonly maxSteps: number;
  };
}

export interface ReflectNodeSpec {
  readonly id: string;
  readonly type: "INFER.REASONING.REFLECT";
  readonly graphId: "refine";
  readonly dependencies: readonly string[];
  readonly config: {
    readonly mode: ReflectionMode;
    readonly criteria: readonly string[];
    readonly generation: GenerationSpec;
  };
}

export interface DeliberateNodeSpec {
  readonly id: string;
  readonly type: "INFER.REASONING.DELIBERATE";
  readonly graphId: "solve";
  readonly dependencies: readonly string[];
  readonly config: {
    readonly mode: DeliberationMode;
    readonly generation: GenerationSpec;
  };
}

export type WorkflowNodeSpec = ContextLoadNodeSpec | SampleNodeSpec | TrajectoryNodeSpec | ReflectNodeSpec | DeliberateNodeSpec;
export type NodeProposal = Omit<SampleNodeSpec, "id"> | Omit<TrajectoryNodeSpec, "id"> | Omit<ReflectNodeSpec, "id"> | Omit<DeliberateNodeSpec, "id">;

export interface SearchNodeStatistics {
  readonly visits: number;
  readonly scoreSum: number;
  readonly meanScore: number;
  readonly bestScore: number;
  readonly failedRuns: number;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
}

export interface SearchTreeNode {
  readonly organizationBinding?: import("./workflow/organization-types.js").OrganizationSpec["nodes"][number];
  readonly id: string;
  readonly searchParentId: string | null;
  readonly depth: number;
  /** Exactly one real Ditto Node. Search metadata is never represented as a fake Node. */
  readonly node: WorkflowNodeSpec;
  readonly pathHash: string;
  readonly evaluation?: EvaluationSummary;
  readonly statistics: SearchNodeStatistics;
}

export interface LocalGraphSpec {
  readonly id: string;
  readonly nodeIds: readonly string[];
}

export type OutputCondition = {
  readonly sourceNodeId: string;
  readonly path?: readonly string[];
  readonly operator: "equals" | "not-equals" | "truthy" | "falsy";
  readonly value?: unknown;
};

export type GraphTransition =
  | { readonly kind: "end" }
  | { readonly kind: "next"; readonly graphId: string }
  | { readonly kind: "repeat"; readonly graphId: string; readonly maxVisits: number; readonly until: OutputCondition; readonly nextGraphId?: string }
  | { readonly kind: "switch"; readonly cases: readonly { readonly when: OutputCondition; readonly graphId: string }[]; readonly defaultGraphId?: string };

export interface AgentPlanSpec {
  readonly organization?: import("./workflow/organization-types.js").OrganizationSpec;
  readonly id: string;
  readonly leafSearchNodeId: string;
  readonly nodes: readonly WorkflowNodeSpec[];
  readonly graphs: readonly LocalGraphSpec[];
  readonly loop: {
    readonly entryGraphId: string;
    readonly transitions: Readonly<Record<string, GraphTransition>>;
    readonly maxGraphRuns: number;
  };
  readonly outputNodeId: string;
}

export interface BenchmarkTask {
  readonly id: string;
  readonly dataset: DatasetName;
  readonly prompt: string;
  readonly outputInstruction: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface BenchmarkCase {
  readonly task: BenchmarkTask;
  /** Kept outside model input and used only by the deterministic evaluator. */
  readonly reference: unknown;
}

export interface ScoreEvidence {
  readonly score: number;
  readonly expected: string;
  readonly prediction: string;
  readonly normalizedExpected: string;
  readonly normalizedPrediction: string;
  readonly method: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CaseResult extends ScoreEvidence {
  readonly executedNodeIds?: readonly string[];
  readonly executedGraphIds?: readonly string[];
  readonly nodeOutputs?: Readonly<Record<string, unknown>>;
  readonly loopTrace?: readonly { readonly graphId: string; readonly visit: number; readonly nextGraphId?: string; readonly outputNodeId: string; readonly nodeOutputs?: Readonly<Record<string, unknown>> }[];

  readonly checkerAudits?: readonly CheckerAudit[];
  readonly generationOutcomes?: readonly GenerationOutcome[];
  readonly providerDiagnostics?: readonly ProviderCallDiagnostics[];
  readonly providerAttempts?: number;
  readonly unknownUsageAttempts?: number;
  readonly failedProviderAttempts?: number;
  /** Earlier unsuccessful evaluation records, retained during infrastructure recovery. */
  readonly previousResults?: readonly CaseResult[];
  /** A numeric score is usable only when valid is true (legacy results also require no error). */
  readonly valid?: boolean;
  readonly attempts?: readonly {
    readonly attempt: number;
    readonly error: string;
    readonly failureKind: "timeout" | "provider" | "execution" | "judge";
    readonly usageKnown: boolean;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly failedProviderAttempts?: number;
    readonly providerAttempts?: number;
    readonly unknownUsageAttempts?: number;
    readonly providerDiagnostics?: readonly ProviderCallDiagnostics[];
  }[];
  readonly usageKnown?: boolean;
  readonly caseId: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly failureKind?: "timeout" | "provider" | "execution" | "judge";
  readonly error?: string;
}

export interface EvaluationSummary {
  readonly providerAttemptCount?: number;
  readonly unknownUsageAttemptCount?: number;
  /** Totals never imply zero cost for requests with missing usage. */
  readonly tokenUsageStatus?: "complete" | "known-lower-bound";
  /** False means score/repeatScores are placeholders, never optimizer feedback. */
  readonly valid?: boolean;
  readonly validRuns?: number;
  readonly unknownUsageRuns?: number;
  readonly failedAttemptCount?: number;
  readonly repeatScores?: readonly number[];
  readonly score: number;
  readonly standardDeviation: number;
  readonly repeats: number;
  readonly examples: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly timeoutRuns: number;
  readonly wrongRuns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly results: readonly CaseResult[];
}

export interface SearchExperience {
  readonly constructionBranchId?: string;
  readonly comparisonEvaluationId?: string;
  readonly organization?: import("./workflow/organization-types.js").OrganizationSpec;
  readonly searchNodeId: string;
  readonly parentSearchNodeId: string | null;
  readonly node: WorkflowNodeSpec;
  readonly score: number;
  readonly delta: number | null;
  readonly outcome: "root" | "improved" | "regressed" | "tied";
  readonly failures: readonly Pick<CaseResult, "caseId" | "prediction" | "expected" | "error">[];
}

/** One logical provider invocation, including each underlying HTTP retry. */
export interface ProviderCallDiagnostics {
  readonly requestId: number;
  readonly attempts: number;
  readonly failedAttempts: number;
  readonly unknownUsageAttempts: number;
  readonly usageKnown: boolean;
  /** Known lower bounds when usageKnown is false. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface GenerationOutcome {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly finishReason: "length";
  readonly usable: boolean;
  readonly content: unknown;
  readonly parseError?: string;
}

export interface AgentRunResult {
  readonly nodeOutputs?: Readonly<Record<string, unknown>>;
  readonly loopTrace?: readonly { readonly graphId: string; readonly visit: number; readonly nextGraphId?: string; readonly outputNodeId: string; readonly nodeOutputs?: Readonly<Record<string, unknown>> }[];
  readonly checkerAudits?: readonly CheckerAudit[];
  readonly generationOutcomes?: readonly GenerationOutcome[];
  readonly answer: string;
  readonly executedNodeIds: readonly string[];
  readonly executedGraphIds: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly usageKnown?: boolean;
  readonly providerAttempts?: number;
  readonly failedProviderAttempts?: number;
  readonly unknownUsageAttempts?: number;
  readonly providerDiagnostics?: readonly ProviderCallDiagnostics[];
}

/** Public model evidence only. Private benchmark references never enter this record. */
export interface CheckerAudit {
  readonly policy: string;
  readonly nodeId: string;
  readonly mode: string;
  readonly targetNodeId: string;
  readonly originalAnswer: string;
  readonly assessment: { readonly passed?: boolean; readonly summary: string };
  readonly issues: readonly { readonly severity: string; readonly description: string; readonly suggestedFix?: string }[];
  readonly proposedAnswer?: string;
  readonly finalAnswer: string;
  readonly decision: "check-only" | "revision-adopted" | "preserved-passed-or-no-error";
  readonly feedbackNodeIds: readonly string[];
  readonly criteria: readonly string[];
}
