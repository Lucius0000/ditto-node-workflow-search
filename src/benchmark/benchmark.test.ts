import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunResult } from "../domain.js";
import { humanevalAdapter, mbppAdapter } from "./code-adapters.js";
import { extractPythonCandidate } from "./docker-python-judge.js";
import { evaluateTasks } from "./evaluator.js";
import { stratifiedSample } from "./sampling.js";
import { scoreCompetitionMathAnswer, scoreDropAnswer, scoreGsm8kAnswer } from "./text-scores.js";
import type { CodeJudge } from "./types.js";

test("text benchmark scorers match their declared semantics", () => {
  assert.equal(scoreDropAnswer("The red fox|fox", "a fox").score, 1);
  assert.equal(scoreGsm8kAnswer("1,234", "work... final 1234").score, 1);
  assert.equal(scoreCompetitionMathAnswer("Therefore \\boxed{\\frac{1}{2}}", "Answer: \\boxed{0.5}").score, 1);
});

test("stratified sampling is deterministic and covers strata", () => {
  const values = ["a1", "a2", "a3", "b1", "b2", "c1"];
  const first = stratifiedSample(values, 3, 7, (value) => value[0]!);
  const second = stratifiedSample(values, 3, 7, (value) => value[0]!);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((value) => value[0])), new Set(["a", "b", "c"]));
});

test("candidate extraction prefers a fenced complete entry point", () => {
  const extracted = extractPythonCandidate("text\n```python\ndef answer(x):\n    return x\n```", "def answer(x):", "answer");
  assert.match(extracted, /^def answer/);
  const completion = extractPythonCandidate("if x:\n    return x\nreturn 0", "def answer(x):", "answer");
  assert.equal(completion, "def answer(x):\n    if x:\n        return x\n    return 0");
});

test("candidate extraction preserves public helpers, support blocks and body indentation", () => {
  const preamble = "from math import sqrt\n\ndef helper(x):\n    return sqrt(x)";
  const entry = "def answer(x):\n    return helper(x)";
  assert.equal(extractPythonCandidate(entry, `${preamble}\n\ndef answer(x):`, "answer"), `${preamble}\n\n${entry}`);
  assert.equal(extractPythonCandidate("```python\ndef helper(x):\n    return x\n```\nExample:\n```py\ndef answer(x):\n    return helper(x)\n```", "def answer(x):", "answer"), "def helper(x):\n    return x\n\ndef answer(x):\n    return helper(x)");
  for (const body of ["    if x:\n        return x\n    return 0", "```python\n    if x:\n        return x\n    return 0\n```", "\n    if x:\n        return x\n    return 0\n"]) {
    assert.equal(extractPythonCandidate(body, "def answer(x):", "answer"), "def answer(x):\n    if x:\n        return x\n    return 0");
  }
});

test("candidate extraction excludes REPL, prose, tests and indented usage fences", () => {
  const entry = "def answer(x):\n    return helper(x)";
  const helper = "from math import sqrt\n\ndef helper(x):\n    return sqrt(x)";
  const blocks = [
    "```\na(n, m) = a(n-1, m)\n```",
    `\`\`\`python\n${entry}\n\`\`\``,
    "```python\n>>> answer(4)\n2.0\n```",
    "```\nRow 0: 1\nRow 1: 1 2\n```",
    "```python\n  return sorted(x, reverse=True)\n```",
    "```python\nassert answer(4) == 2\n```",
    "```python\nx = [1, 2]\nprint(answer(x))\n```",
    `\`\`\`\n${helper}\n\`\`\``,
  ];
  assert.equal(extractPythonCandidate(blocks.join("\n"), "def answer(x):", "answer"), `${entry}\n\n${helper}`);
});

test("support-block parsing preserves constants, multiline imports and decorated helpers without executing them", () => {
  const support = "from functools import (\n    lru_cache,\n)\nFACTOR = 2\n\n@lru_cache(None)\ndef helper(x):\n    \"\"\"计算倍率。\"\"\"\n    return x * FACTOR";
  const entry = "def answer(x):\n    return helper(x)";
  assert.equal(extractPythonCandidate(`\`\`\`python\n${support}\n\`\`\`\n\`\`\`python\n${entry}\n\`\`\``, "def answer(x):", "answer"), `${support}\n\n${entry}`);
  // An invalid first implementation remains the candidate, rather than
  // silently choosing a later implementation that happens to parse.
  const invalid = "def answer(x):\n    return x +";
  assert.equal(extractPythonCandidate(`\`\`\`python\n${invalid}\n\`\`\`\n\`\`\`python\n${entry}\n\`\`\``, "def answer(x):", "answer"), invalid);
});

test("an explanatory signature-only fence cannot replace the implementation", () => {
  const entry = "def answer(x):\n    return x";
  for (const signature of ["def answer(x):", "def answer(\n    x: int,\n) -> int:", "import math\n\ndef answer(x):\n    # implementation follows"]) {
    assert.equal(extractPythonCandidate(`\`\`\`python\n${signature}\n\`\`\`\n\`\`\`python\n${entry}\n\`\`\``, "def answer(x):", "answer"), entry);
  }
  const badImplementation = "def answer(x):\n    return x +";
  assert.equal(extractPythonCandidate(`\`\`\`python\n${badImplementation}\n\`\`\`\n\`\`\`python\n${entry}\n\`\`\``, "def answer(x):", "answer"), badImplementation);
});

test("MBPP body completion excludes prose and retains the actual graded candidate privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-mbpp-"));
  const expected = "def answer(x):\n    if x:\n        return x\n    return 0";
  try {
    await writeFile(join(directory, "mbpp_validate.jsonl"), JSON.stringify({ task_id: 1, prompt: "Write an identity function.\n\ndef answer(x):\n", entry_point: "answer", code: expected, test: "def check():\n    assert answer(1) == 1" }) + "\n", "utf8");
    const loaded = await mbppAdapter.load({ dataMode: "fixture", dataDir: directory, split: "validate", codeJudge: { async judge(request) {
      assert.equal(request.candidate, expected);
      return { passed: true, diagnostics: "ok", durationMs: 1 };
    } } });
    const summary = await loaded.evaluate(async () => ({ answer: "    if x:\n        return x\n    return 0", executedNodeIds: [], executedGraphIds: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
    assert.equal(summary.score, 1);
    assert.equal(summary.results[0]?.details?.candidate, expected);
    assert.equal(JSON.stringify(loaded.tasks).includes("assert answer"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("code adapter keeps tests private and delegates to the injected judge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-benchmark-"));
  let observedTest = "";
  const judge: CodeJudge = {
    async judge(request) {
      observedTest = request.testSource;
      return { passed: true, diagnostics: "ok", durationMs: 1 };
    },
  };
  try {
    await writeFile(join(directory, "humaneval_validate.jsonl"), `${JSON.stringify({
      task_id: "HumanEval/0",
      prompt: "def answer(x):\n    \"\"\"identity\"\"\"\n",
      entry_point: "answer",
      canonical_solution: "    return x",
      test: "def check(candidate):\n    assert candidate(1) == 1",
    })}\n`, "utf8");
    const loaded = await humanevalAdapter.load({ dataMode: "fixture", dataDir: directory, split: "validate", codeJudge: judge });
    assert.equal(JSON.stringify(loaded.tasks).includes("candidate(1)"), false);
    const result: AgentRunResult = {
      answer: "```python\ndef answer(x):\n    return x\n```",
      executedNodeIds: [],
      executedGraphIds: [],
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
    const summary = await loaded.evaluate(async () => result);
    assert.equal(summary.score, 1);
    assert.match(observedTest, /candidate\(1\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation reports monotonic live progress without exposing judge references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-progress-"));
  const updates: Array<{ completed: number; total: number; score: number }> = [];
  try {
    await writeFile(join(directory, "humaneval_validate.jsonl"), `${JSON.stringify({
      task_id: "HumanEval/1",
      prompt: "def answer(x):\n",
      entry_point: "answer",
      canonical_solution: "    return x",
      test: "def check(candidate):\n    assert candidate(1) == 1",
    })}\n`, "utf8");
    const loaded = await humanevalAdapter.load({ dataMode: "fixture",
      dataDir: directory,
      split: "validate",
      codeJudge: { async judge() { return { passed: true, diagnostics: "ok", durationMs: 1 }; } },
    });
    await loaded.evaluate(async () => ({
      answer: "def answer(x):\n    return x",
      executedNodeIds: [], executedGraphIds: [], inputTokens: 1, outputTokens: 1, totalTokens: 2,
    }), {
      repeats: 2,
      onCase: ({ completed, total, result }) => { updates.push({ completed, total, score: result.score }); },
    });
    assert.deepEqual(updates, [
      { completed: 1, total: 2, score: 1 },
      { completed: 2, total: 2, score: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Ditto deadline failures receive one retry and remain separately classified", async () => {
  const task = {
    id: "math:validate:retry",
    dataset: "math" as const,
    prompt: "1+1",
    outputInstruction: "Return a boxed answer.",
    metadata: {},
  };
  const scorer = {
    async score(_taskId: string, prediction: string) {
      return { score: prediction === "ok" ? 1 : 0, expected: "ok", prediction, normalizedExpected: "ok", normalizedPrediction: prediction, method: "fixture" };
    },
    expectedLabel() { return "ok"; },
  };
  let attempts = 0;
  const recovered = await evaluateTasks([task], scorer, async () => {
    attempts++;
    if (attempts === 1) throw new Error("Node failed [TIMEOUT]: INFER deadline exceeded");
    return { answer: "ok", executedNodeIds: [], executedGraphIds: [], inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  }, { retryAttempts: 2 });
  assert.equal(attempts, 2);
  assert.equal(recovered.score, 1);
  assert.equal(recovered.timeoutRuns, 0);

  attempts = 0;
  const exhausted = await evaluateTasks([task], scorer, async () => {
    attempts++;
    throw new Error("Node failed [TIMEOUT]: INFER deadline exceeded");
  }, { retryAttempts: 2 });
  assert.equal(attempts, 2);
  assert.equal(exhausted.failedRuns, 1);
  assert.equal(exhausted.timeoutRuns, 1);
  assert.equal(exhausted.wrongRuns, 0);
  assert.equal(exhausted.results[0]?.failureKind, "timeout");
});
