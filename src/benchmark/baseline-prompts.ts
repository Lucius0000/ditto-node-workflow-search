import { createHash } from "node:crypto";
import type { DatasetName } from "../domain.js";
import {DROP_ANSWER_CONTRACT,DROP_ANSWER_CONTRACT_VERSION,publicAnswerContract} from './answer-contract.js';

/** Original seed provenance; DROP's revised user answer contract is versioned separately. */
export const MFLOW_PROMPT_SOURCE = Object.freeze({
  repository: "https://github.com/erwinmsmith/MFlow",
  commit: "9279d7d91bbce039656f5cd3a6bb539cea75fe85",
  seedFile: "src/aflow-seed.ts",
  messageFile: "src/composition.ts",
  profileFile: "src/types.ts",
});

export interface BaselinePrompts {
  readonly agent: string;
  readonly review: string;
  readonly integrate: string;
}

// Exact textPrompts strings from the pinned MFlow seed (GSM8K uses MATH seeds).
const gsm8kPrompts: BaselinePrompts = Object.freeze({
  agent: String.raw`Solve the following math problem step by step. Provide a clear, detailed reasoning process and end with the final answer in the format: \boxed{answer}. Ensure the answer is concise and matches the expected format (e.g., a number, a fraction, or a list of letters separated by commas).

Problem:`,
  review: String.raw`You are given a math problem and an initial solution. Carefully review the initial solution for any errors in reasoning, calculation, or interpretation. If you find mistakes, correct them and provide the correct final answer. If the initial solution is correct, confirm it and restate the final answer. Always end with the final answer in the format: \boxed{answer}. Ensure the answer is concise and matches the expected format (e.g., a number, a fraction, or a list of letters separated by commas).

Check each consequential step once. Once the answer is established, finish the response; do not repeatedly re-derive or recheck it. If an approach stalls, state the concrete obstacle instead of cycling through the same calculations.

Problem and Initial Solution:`,
  integrate: String.raw`Solve the original math problem using the supplied full derivations as evidence. Identify the exact step behind any disagreement; check it by calculation or a different argument. Correct unsupported assertions rather than voting on wording. Return a self-contained solution ending with \boxed{answer}. Do not replace the stated problem with a remembered variant.

Problem:`,
});

const dropContract = DROP_ANSWER_CONTRACT;
const dropPrompts: BaselinePrompts = Object.freeze({
  agent: 'Solve the original task accurately. Follow the public final-answer contract below.\n\nTask:',
  review: 'Review the supplied candidate against the ORIGINAL task. Correct concrete implementation, reasoning or interpretation errors. If it is correct, restate it unchanged. Follow the public final-answer contract below.\n\nTask and candidate:',
  integrate: 'Resolve disagreements by checking the original specification and the supplied candidates. Produce one correct solution, rather than voting on wording. Follow the public final-answer contract below.\n\nTask:',
});

const gsm8kRootProfile = Object.freeze({
  objective: "Solve the task and integrate relevant evidence.",
  capability: "General task reasoning and evidence integration",
  reasoning: "cot",
  expected_output: "Complete mathematical solution ending in a boxed final answer.",
  stop_condition: "A complete solution or a concrete unresolved obstacle is stated.",
  private_context: "",
});
const dropRootProfile = Object.freeze({
  objective: "Answer the supplied reading-comprehension question accurately.",
  capability: "Evidence-grounded reading comprehension",
  reasoning: "cot",
  expected_output: dropContract,
  stop_condition: "A complete answer or a concrete unresolved obstacle is stated.",
  private_context: "",
});

/** Only these two new adapters adopt this prompt contract; MATH stays unchanged. */
export function baselinePrompts(dataset: DatasetName): BaselinePrompts | undefined {
  return dataset === "gsm8k" ? gsm8kPrompts : dataset === "drop" ? dropPrompts : undefined;
}

/** Preserve original task text; DROP uses its versioned public final/intermediate contract. */
export function baselineTextMessages(
  dataset: "drop" | "gsm8k",
  instruction: string,
  taskPrompt: string,
  evidence: unknown = "",
): readonly { readonly role: "user"; readonly content: string }[] {
  const p = dataset === "drop" ? dropRootProfile : gsm8kRootProfile;
  return [{ role: "user", content: instruction + "\n\n" + taskPrompt
    + (evidence ? "\n\n" + (typeof evidence === "string" ? evidence : JSON.stringify(evidence)) : "")
    + `\n\nAssignment: ${p.objective}\nCapability: ${p.capability}\nReasoning approach: ${p.reasoning}\nExpected output: ${p.expected_output}\nStopping criterion: ${p.stop_condition}\n${p.private_context}` }];
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const promptProfiles = Object.freeze(Object.fromEntries((["drop", "gsm8k"] as const).map(dataset => [dataset, Object.freeze({
  id: dataset==='drop'?DROP_ANSWER_CONTRACT_VERSION:"mflow-seed-root-text-v1",
  dataset,
  source: MFLOW_PROMPT_SOURCE,
  ...(dataset==='drop'?{userAnswerContract:publicAnswerContract(dataset)}:{}),
  prompts: baselinePrompts(dataset)!,
  promptsSha256: digest(baselinePrompts(dataset)),
  rootMessageSha256: digest(baselineTextMessages(dataset, baselinePrompts(dataset)!.agent, "<PUBLIC_TASK_PROMPT>")),
  scope: dataset==='drop'?"Versioned DROP user answer contract; original task text, split and scorer remain fixed.":"Baseline seed prompts and initial root message; Ditto Node search remains the experiment variable.",
})])));

/** Save this public contract in manifests/checkpoints so prompt changes cannot resume silently. */
export function baselinePromptProfile(dataset: DatasetName): Readonly<Record<string, unknown>> | undefined {
  return promptProfiles[dataset];
}

export function assertBaselinePromptProfile(dataset: DatasetName, actual: unknown): void {
  const expected = baselinePromptProfile(dataset);
  if (expected && JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Frozen ${dataset} baseline prompt profile does not match the versioned public prompt contract`);
  }
}
