import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanevalAdapter, mbppAdapter } from "./code-adapters.js";
import { DockerPythonJudge, extractPythonCandidate } from "./docker-python-judge.js";

test("indented function bodies retain nested indentation", () => {
  assert.equal(extractPythonCandidate("    if x:\n        return x\n    return 0", "def answer(x):\n", "answer"), "def answer(x):\n    if x:\n        return x\n    return 0");
  assert.equal(extractPythonCandidate("```python\n    if x:\n        return x\n    return 0\n```", "def answer(x):\n", "answer"), "def answer(x):\n    if x:\n        return x\n    return 0");
});

test("complete solutions retain public prompt helpers and imports", () => {
  const prompt = "import math\ndef helper(x):\n    return x*x\n\ndef answer(x):\n    \"\"\"Square x.\"\"\"\n";
  const candidate = extractPythonCandidate("Explanation\n```python\ndef answer(x):\n    return helper(x)\n```", prompt, "answer");
  assert.match(candidate, /^import math\ndef helper/);
  assert.equal(candidate.match(/def answer/g)?.length, 1);
  const fragments = extractPythonCandidate("```python\nimport math\ndef helper(x):\n    return math.sqrt(x)\n```\nThen use it:\n```python\ndef answer(x):\n    return helper(x)\n```", "def answer(x):\n", "answer");
  assert.match(fragments, /^import math/);
  assert.match(fragments, /def helper/);
});

test("engineering membership is explicit, checked and retains actual extracted code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-code-membership-"));
  try {
    await writeFile(join(directory, "humaneval_validate.jsonl"), [1, 2].map(id => JSON.stringify({
      task_id: String(id), prompt: "def answer(x):\n", entry_point: "answer", canonical_solution: "return x",
      test: "PRIVATE_TEST_MARKER",
    })).join("\n"));
    const loaded = await humanevalAdapter.load({ dataMode: "fixture", dataDir: directory, split: "validate", codeJudge: {
      async judge() { return { passed: true, diagnostics: "ok", durationMs: 1 }; },
    } });
    const runner = async () => ({ answer: "return x", executedNodeIds: [], executedGraphIds: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    for (const engineeringTaskIds of [[], ["humaneval:1", "humaneval:1"], ["missing"]]) {
      assert.throws(() => loaded.evaluate(runner, { engineeringTaskIds }), /nonempty, unique/);
    }
    const selected = await loaded.evaluate(runner, { engineeringTaskIds: ["humaneval:2"] });
    assert.equal(selected.results.length, 1);
    assert.equal(selected.results[0]!.caseId, "humaneval:2#1");
    assert.equal(JSON.stringify(selected).includes("PRIVATE_TEST_MARKER"), false);
    assert.match(JSON.stringify(selected), /def answer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MBPP natural-language task prefix never becomes executable Python", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-mbpp-prompt-"));
  try {
    await writeFile(join(directory, "mbpp_validate.jsonl"), JSON.stringify({
      task_id: "127", prompt: "Write a function to multiply two integers.\n\ndef multiply_int(x, y):",
      entry_point: "multiply_int", code: "def multiply_int(x, y): return x*y", test: "def check(): pass",
    }));
    const candidates: string[] = [];
    const loaded = await mbppAdapter.load({ dataMode: "fixture", dataDir: directory, split: "validate", codeJudge: {
      async judge(request) { candidates.push(request.candidate); return { passed: true, diagnostics: "ok", durationMs: 1 }; },
    } });
    for (const answer of ["def multiply_int(x, y):\n    return x*y", "    return x*y"]) {
      await loaded.evaluate(async () => ({ answer, executedNodeIds: [], executedGraphIds: [], inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
    }
    assert.deepEqual(candidates, ["def multiply_int(x, y):\n    return x*y", "def multiply_int(x, y):\n    return x*y"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real Docker distinguishes candidate failures from infrastructure and supervisor failures", { skip: process.env.DITTO_DOCKER_TEST !== "1" }, async () => {
  const judge = new DockerPythonJudge();
  await judge.preflight();
  const request = { dataset: "humaneval" as const, taskId: "engineering", entryPoint: "answer", testSource: "def check(candidate):\n    assert candidate(2)==4", testImports: [] };
  assert.equal((await judge.judge({ ...request, candidate: "def answer(x):\n    return x*2" })).passed, true);
  for (const candidate of ["def answer(x):\n    return x", "print('__DITTO_PRIVATE_TESTS_PASSED__')\nraise SystemExit(0)", "raise SystemExit(0)", "while True: pass"]) {
    assert.equal((await judge.judge({ ...request, candidate })).passed, false);
  }
  await assert.rejects(new DockerPythonJudge({ image: "ditto-missing:never" }).judge({ ...request, candidate: "pass" }), /infrastructure failed/);
  await assert.rejects(new DockerPythonJudge({ timeoutMs: 1 }).judge({ ...request, candidate: "pass" }), /timed out/);
});
