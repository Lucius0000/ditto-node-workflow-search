/** One request policy for all new benchmark and optimizer calls. */
export const EXPERIMENT_GENERATION = Object.freeze({ temperature: 0, maxTokens: 393_216 });
export const EXPERIMENT_PROVIDER_OPTIONS = Object.freeze({
  thinking: Object.freeze({ type: "disabled" }),
  n: 1,
  response_format: Object.freeze({ type: "text" }),
});
export const EXPERIMENT_EXECUTION = Object.freeze({
  maxSteps: Number.MAX_SAFE_INTEGER,
  maxIterations: Number.MAX_SAFE_INTEGER,
});

/** Only the explicit optimizer profile may select a structured response format. */
export type ExperimentModelProfile = "math" | "automationbench" | "optimizer";
