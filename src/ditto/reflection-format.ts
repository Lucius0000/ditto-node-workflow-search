import type { ModelProvider, SampleInput, SampleOutput, Usage } from "@codesoul-co/ditto/worker/infer";
import { GENERATION } from "../protocol.js";
import { normalizeReflectionResponse } from "./reflection-normalization.js";
import { assertReflectionRetryPreserves, reflectionRetryAnchor } from "./reflection-retry.js";
export { validateReflectionResponse } from "./reflection-schema.js";

export interface ReflectionRepairEvent {
  readonly phase: "reflect-format-repair";
  readonly outcome: "normalized" | "retry" | "recovered" | "exhausted";
  readonly attempt: number;
  readonly mode: string;
  readonly taskId?: unknown;
  readonly nodeId?: unknown;
  readonly error?: string;
  readonly repairs?: readonly string[];
  /** Audit evidence only; never supplied to the optimizer or benchmark scorer. */
  readonly rawContent?: SampleOutput["message"]["content"];
  readonly normalizedContent?: string;
  /** Public model messages only: deliberately exclude model options and credentials. */
  readonly requestMessages?: readonly { readonly role: string; readonly content: unknown }[];
  readonly finishReason?: SampleOutput["finishReason"];
}

/** Format-only application adapter; the published REFLECT Node validates the result. */
export function withReflectionFormatRepair(provider: ModelProvider, emit: (event: ReflectionRepairEvent) => void | Promise<void> = () => undefined): ModelProvider {
  return {
    async invoke(input, options) {
      if (input.metadata?.nodeType !== "INFER.REASONING.REFLECT") return provider.invoke(input, options);
      const payload = JSON.parse(String(input.messages.at(-1)?.content)) as { mode?: unknown };
      if (!["critique", "verify", "revise"].includes(String(payload.mode))) throw new Error("REFLECT format repair requires the original published Node payload");
      const mode = String(payload.mode);
      const usages: Array<Usage | undefined> = [];
      const observations: Array<{ attempt: number; rawContent: SampleOutput["message"]["content"]; normalizedContent?: string; repairs?: readonly string[]; error?: string }> = [];
      let semanticAnchor: string | undefined;
      // Preserve the native first prompt, checker criteria and model settings.
      let request: SampleInput = { ...input, generation: GENERATION };
      for (let attempt = 1; attempt <= 3; attempt++) {
        options.signal.throwIfAborted();
        const requestMessages = request.messages.map(({ role, content }) => ({ role, content: structuredClone(content) }));
        const response = await provider.invoke(request, options);
        usages.push(response.usage);
        // Transport failures and normal output-length stops keep their existing semantics.
        if (response.finishReason !== "stop") return usages.length === 1 ? response : { ...response, usage: aggregateUsage(usages) };
        let error = "";
        let normalized: ReturnType<typeof normalizeReflectionResponse> | undefined;
        try {
          const candidate = normalizeReflectionResponse(response.message.content, mode);
          if (attempt > 1) assertReflectionRetryPreserves(semanticAnchor!, candidate.content);
          normalized = candidate;
        }
        catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        if (normalized) {
          observations.push({ attempt, rawContent: response.message.content, normalizedContent: normalized.content, repairs: normalized.repairs });
          if (normalized.repairs.length) await emit({ phase: "reflect-format-repair", outcome: "normalized", attempt, mode,
            taskId: input.metadata?.taskId, nodeId: input.metadata?.nodeId, repairs: normalized.repairs,
            rawContent: response.message.content, normalizedContent: normalized.content, requestMessages, finishReason: response.finishReason });
          if (attempt > 1) await emit({ phase: "reflect-format-repair", outcome: "recovered", attempt, mode, taskId: input.metadata?.taskId, nodeId: input.metadata?.nodeId });
          return { ...response, usage: aggregateUsage(usages), message: { ...response.message, content: normalized.content,
            metadata: { ...response.message.metadata, reflectionFormat: {
              policy: "reflect-format-v3", attempts: attempt, repairs: attempt - 1,
              normalizations: observations.reduce((sum, observation) => sum + (observation.repairs?.length ?? 0), 0),
              usageKnown: usages.every((usage) => usage?.inputTokens !== undefined && usage.outputTokens !== undefined), observations,
            } },
          } };
        }
        if (attempt === 1) semanticAnchor = reflectionRetryAnchor(response.message.content, mode);
        const exhausted = attempt === 3 || semanticAnchor === undefined;
        if (semanticAnchor === undefined) error += "; substantive fields cannot be safely preserved by format-only retries";
        observations.push({ attempt, rawContent: response.message.content, error });
        await emit({ phase: "reflect-format-repair", outcome: exhausted ? "exhausted" : "retry", attempt, mode,
          taskId: input.metadata?.taskId, nodeId: input.metadata?.nodeId, error, rawContent: response.message.content,
          requestMessages, finishReason: response.finishReason });
        if (exhausted) throw new Error(`[REFLECT_FORMAT_ERROR] Invalid reflection after ${attempt} response(s): ${error}`);
        // Retain prior failures and numbered feedback: deterministic retries must not repeat the same request.
        request = { ...request, messages: [
          ...request.messages,
          { role: "assistant", content: response.message.content },
          { role: "user", content: formatRepairInstruction(mode, error, attempt) },
        ] };
      }
      throw new Error("Unreachable REFLECT format repair state");
    },
  };
}

function formatRepairInstruction(mode: string, error: string, attempt: number): string {
  return [
    "Format correction " + attempt + "/2: your REFLECT response failed the published output schema: " + error + ".",
    "Return exactly one valid JSON object for mode=" + mode + ". Repair representation only. Do not reassess the target, introduce new issues, change the assessment verdict, or change answer content. Retain the original values; if the response lacks required substantive information, do not invent it merely to satisfy the schema.",
    "The root has assessment (object), issues (array), and optional revisedResult (message object). assessment has summary (string) and passed (boolean; required in verify mode). issues and revisedResult belong at the root, never inside assessment. Each issue has severity (info, warning, or error), description (nonempty string), and optional suggestedFix (string). suggestedFix must be a string when present. Optional fields must be omitted when unavailable, never null. revisedResult is required in revise mode: retain the supplied answer as role=assistant and content=the answer. The answer-only instruction applies to revisedResult.content, not the JSON envelope.",
    "Use JSON string escaping (a literal backslash must be doubled). Balance braces. Do not append another object, explanations, or Markdown. Consult all earlier corrections in this conversation; return the corrected JSON object only.",
  ].join("\n");
}

function aggregateUsage(usages: readonly (Usage | undefined)[]): Usage {
  const result: Usage = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const) {
    if (usages.every((usage) => usage?.[field] !== undefined)) result[field] = usages.reduce((sum, usage) => sum + usage![field]!, 0);
  }
  return result;
}
