import { EXPERIMENT_EXECUTION, EXPERIMENT_GENERATION, EXPERIMENT_PROVIDER_OPTIONS } from "./model-profile.js";

/** New runs share this policy; historical manifests remain immutable. */
export const GENERATION = EXPERIMENT_GENERATION;
export const PROTOCOL = Object.freeze({
  id: "mflow-fixed-flash-v9",
  searchPolicy: "optimizer-directed-workflow-v1",
  budgetUnit: "completed-valid-workflow-evaluation-including-initial",
  checkerPolicy: "checker-semantics-v1",
  reflectionAdapter: "reflect-format-v3",
  generation: GENERATION,
  providerOptions: EXPERIMENT_PROVIDER_OPTIONS,
  thinking: "disabled",
  reasoningEffort: "omitted",
  topP: "omitted (provider default)",
  stream: true,
  execution: EXPERIMENT_EXECUTION,
  splitProtocol: "aflow-fixed-v1",
  baselineCommit: "9279d7d91bbce039656f5cd3a6bb539cea75fe85",
  searchRounds: 20,
  validationRepeats: 5,
  testRepeats: 3,
  convergenceTopK: 3,
  convergenceZ: 0,
  convergenceConsecutiveRounds: 5,
  providerAttempts: 3,
  connectTimeoutMs: 10_000,
  readTimeoutMs: "explicit-run-policy",
  workflowAttempts: 5,
  workflowRetryDelayMs: 1_000,
});
