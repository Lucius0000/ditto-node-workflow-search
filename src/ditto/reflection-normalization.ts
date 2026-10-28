import { isDeepStrictEqual } from "node:util";
import type { SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { validateReflectionResponse } from "./reflection-schema.js";

/** Deterministic envelope repairs only. The assessment and answer are never inferred. */
export function normalizeReflectionResponse(
  content: SampleOutput["message"]["content"],
  mode: string,
): { readonly content: string; readonly repairs: readonly string[] } {
  return normalize(content, mode, false);
}

/** Retry anchors alone may omit unavailable optional fixes; ordinary normalization never does. */
export function prepareReflectionRetryAnchor(content: SampleOutput["message"]["content"], mode: string): string {
  return normalize(content, mode, true).content;
}

function normalize(
  content: SampleOutput["message"]["content"],
  mode: string,
  retryAnchor: boolean,
): { readonly content: string; readonly repairs: readonly string[] } {
  if (typeof content !== "string") throw new Error("REFLECT output must be a JSON object string");
  const repairs: string[] = [];
  // Match the published parser's existing fence handling without changing valid output.
  const unfenced = content.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const escaped = repairInvalidEscapes(unfenced, repairs);
  const candidate = trimSurplusObjectBraces(escaped, repairs);
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch { throw new Error("Invalid REFLECT JSON syntax; quotes or structure are ambiguous"); }
  if (!isObject(parsed)) throw new Error("REFLECT output must be a JSON object");
  rejectDuplicateKeys(candidate);

  let structureChanged = false;
  // A complete JSON string already supplies the answer. Only add the native
  // message envelope; never infer a missing/null answer, verdict or issues.
  const wrapAnswer = (container: Record<string, unknown>): void => {
    if (typeof container.revisedResult !== "string" || !container.revisedResult.trim()) return;
    container.revisedResult = { role: "assistant", content: container.revisedResult };
    repairs.push("wrap-string-revisedResult");
    structureChanged = true;
  };
  wrapAnswer(parsed);
  if (isObject(parsed.assessment)) {
    wrapAnswer(parsed.assessment);
    for (const field of ["issues", "revisedResult"] as const) {
      if (!Object.hasOwn(parsed.assessment, field)) continue;
      const nested = parsed.assessment[field];
      if (field === "issues" ? !Array.isArray(nested) : !isObject(nested)) {
        throw new Error(`assessment.${field} has an invalid type`);
      }
      if (Object.hasOwn(parsed, field)) {
        if (!isDeepStrictEqual(parsed[field], nested)) {
          throw new Error(`Conflicting top-level and assessment.${field}`);
        }
        repairs.push(`remove-redundant-assessment.${field}`);
      } else {
        parsed[field] = nested;
        repairs.push(`promote-assessment.${field}`);
      }
      delete parsed.assessment[field];
      structureChanged = true;
    }
  }
  if (retryAnchor && Array.isArray(parsed.issues)) {
    for (const issue of parsed.issues) {
      if (!isObject(issue) || issue.suggestedFix !== null) continue;
      delete issue.suggestedFix;
      repairs.push("omit-null-suggestedFix-for-retry-anchor");
      structureChanged = true;
    }
  }
  const normalized = structureChanged ? JSON.stringify(parsed) : candidate;
  if (structureChanged && !isDeepStrictEqual(parsed, JSON.parse(normalized))) {
    throw new Error("REFLECT normalization would change JSON values");
  }
  // Use the unchanged native schema as the final gate, including mode-specific fields.
  validateReflectionResponse(normalized, mode);
  return Object.freeze({ content: retryAnchor || repairs.length ? normalized : content, repairs: Object.freeze(repairs) });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function repairInvalidEscapes(source: string, repairs: string[]): string {
  const result: string[] = [];
  let inString = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (!inString) {
      result.push(character);
      if (character === '"') inString = true;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) throw new Error("Unescaped control character in REFLECT JSON string");
    if (character === '"') {
      inString = false;
      result.push(character);
      continue;
    }
    if (character !== "\\") {
      result.push(character);
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) throw new Error("Incomplete escape in REFLECT JSON string");
    if (next.charCodeAt(0) < 0x20) throw new Error("Unescaped control character after REFLECT JSON backslash");
    if ('"\\/bfnrt'.includes(next)) {
      result.push(character, next);
      index++;
    } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
      result.push(source.slice(index, index + 6));
      index += 5;
    } else {
      // Only double the offending slash; preserve all following text and valid escapes.
      result.push("\\\\");
      repairs.push("escape-invalid-backslash");
    }
  }
  if (inString) throw new Error("Unterminated REFLECT JSON string");
  return result.join("");
}

function trimSurplusObjectBraces(source: string, repairs: string[]): string {
  const start = source.search(/\S/);
  if (start < 0 || source[start] !== "{") throw new Error("REFLECT output must start with a valid JSON object");
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== (character === "}" ? "{" : "[")) throw new Error("Mismatched REFLECT JSON brackets");
      if (stack.length) continue;
      const tail = source.slice(index + 1);
      if (!tail.trim()) return source;
      if (!/^[}\s]+$/.test(tail)) throw new Error("REFLECT JSON has trailing content beyond surplus closing braces");
      for (const character of tail) if (character === "}") repairs.push("remove-surplus-closing-brace");
      return source.slice(0, index + 1);
    }
  }
  throw new Error("Incomplete REFLECT JSON object");
}

/** JSON.parse discards duplicate keys; reject them before any structural rewriting. */
function rejectDuplicateKeys(source: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/.test(source[index] ?? "") && index < source.length) index++; };
  const string = (): string => {
    const start = index++;
    while (index < source.length) {
      const character = source[index++]!;
      if (character === "\\") index++;
      else if (character === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    throw new Error("Unterminated REFLECT JSON string");
  };
  const value = (): void => {
    whitespace();
    if (source[index] === "{") {
      index++;
      whitespace();
      const seen = new Set<string>();
      while (source[index] !== "}") {
        whitespace();
        const key = string();
        if (seen.has(key)) throw new Error(`Ambiguous duplicate REFLECT JSON key: ${JSON.stringify(key.slice(0, 60))}`);
        seen.add(key);
        whitespace();
        index++; // colon; JSON.parse has already validated the grammar.
        value();
        whitespace();
        if (source[index] !== ",") break;
        index++;
      }
      index++;
    } else if (source[index] === "[") {
      index++;
      whitespace();
      while (source[index] !== "]") {
        value();
        whitespace();
        if (source[index] !== ",") break;
        index++;
      }
      index++;
    } else if (source[index] === '"') {
      string();
    } else {
      while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index++;
    }
  };
  value();
}
