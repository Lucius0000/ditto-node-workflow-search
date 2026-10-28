import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateTasks } from "../benchmark/evaluator.js";
import type { BenchmarkTask } from "../domain.js";
import { CaseRecovery, displayScore, evaluationCodeHash } from "../run/case-recovery.js";

test("recovery code identity changes when the MFlow scorer or dependency pin changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-code-identity-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "requirements-scoring.txt"), "math-verify==0.9.0");
    const scorerPath = join(root, "scripts", "mflow_math_scorer.py");
    await writeFile(scorerPath, "first");
    const first = await evaluationCodeHash(root);
    await writeFile(scorerPath, "second");
    const second = await evaluationCodeHash(root);
    assert.notEqual(first, second);
    await writeFile(join(root, "requirements-scoring.txt"), "math-verify==changed");
    assert.notEqual(second, await evaluationCodeHash(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v3 source identity normalizes only CRLF text line endings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-code-line-endings-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    const files = ["src/fixture.ts", "scripts/fixture.py", "package-lock.json", "requirements.txt", "requirements-scoring.txt"];
    const lf = "first line\nsecond line\nthird line\n";
    const writeText = async (text: string): Promise<void> => {
      for (const name of files) await writeFile(join(root, name), text, "utf8");
    };
    await writeText(lf);
    const expected = await evaluationCodeHash(root);
    await writeText(lf.replace(/\n/g, "\r\n"));
    assert.equal(await evaluationCodeHash(root), expected, "CRLF text matches LF");
    await writeText("first line\r\nsecond line\nthird line\r\n");
    assert.equal(await evaluationCodeHash(root), expected, "mixed text matches LF");
    await writeText(lf);
    for (const changed of [
      lf.replace("second", "changed"),
      lf.replace("first line", "first line "),
      lf.replace("first line", "first\tline"),
      lf.slice(0, -1),
      lf.replace(/\n/g, "\r"),
      "\uFEFF" + lf,
    ]) {
      await writeFile(join(root, files[0]!), changed, "utf8");
      assert.notEqual(await evaluationCodeHash(root), expected, "code, whitespace, lone CR and BOM stay significant");
    }
    await writeFile(join(root, files[0]!), lf, "utf8");
    const binary = join(root, "scripts/fixture.bin");
    await writeFile(binary, Buffer.from([0xff, 0x0d, 0x0a]));
    const binaryCrLf = await evaluationCodeHash(root);
    await writeFile(binary, Buffer.from([0xff, 0x0a]));
    assert.notEqual(await evaluationCodeHash(root), binaryCrLf, "binary bytes are never normalized");
    await writeFile(join(root, files[0]!), Buffer.from([0xff]));
    await assert.rejects(evaluationCodeHash(root), /encoded data|encoding/i, "invalid UTF-8 text must fail instead of replacing bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("infrastructure recovery reuses only valid cases under the exact identity and retains errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-case-recovery-"));
  const tasks: BenchmarkTask[] = ["a", "b"].map(id => ({ id, dataset: "math", prompt: id, outputInstruction: "", metadata: {} }));
  const scorer = { expectedLabel: () => "2", async score(_id: string, prediction: string) {
    return { score: 1, expected: "2", prediction, normalizedExpected: "2", normalizedPrediction: "2", method: "fixture" };
  } };
  const identity = { planHash: "plan-a", codeHash: "code-a", dataHash: "data-a", protocol: "mflow-math-verify-0.9.0" };
  const answer = { answer: "2", executedNodeIds: [], executedGraphIds: [], inputTokens: 2, outputTokens: 1, totalTokens: 3 };
  try {
    const first = await CaseRecovery.open(root, identity);
    const failed = await evaluateTasks(tasks, scorer, async task => {
      if (task.id === "b") throw new Error("HTTP 402: balance");
      return answer;
    }, { onCase: async progress => first.record(progress.result) });
    await first.finish(failed.valid === true);
    const recovery = await CaseRecovery.open(root, identity);
    const calls: string[] = [];
    const recovered = await evaluateTasks(tasks, scorer, async task => { calls.push(task.id); return answer; }, {
      priorCases: recovery.priorCases, onCase: async progress => recovery.record(progress.result),
    });
    assert.deepEqual(calls, ["b"]);
    assert.equal(recovered.valid, true);
    assert.equal(recovered.results[1]?.previousResults?.[0]?.error, "HTTP 402: balance");
    assert.equal(recovered.results[1]?.attempts?.[0]?.error, "HTTP 402: balance");
    assert.equal(recovered.unknownUsageRuns, 1);
    await recovery.finish(true);
    assert.deepEqual((await CaseRecovery.open(root, identity)).priorCases, [], "completed independent runs must not inherit paid answers");
    for (const field of ["planHash", "codeHash", "dataHash", "protocol"]) {
      assert.deepEqual((await CaseRecovery.open(root, { ...identity, [field]: "changed" })).priorCases, []);
    }
    assert.equal(displayScore(false, 0), null);
    assert.equal(displayScore(true, 0), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lower operational concurrency reuses 117 paid successes and retries only two failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-concurrency-recovery-"));
  const tasks: BenchmarkTask[] = Array.from({ length: 119 }, (_, index) => ({
    id: `case-${index}`, dataset: "math", prompt: `${index}`, outputInstruction: "", metadata: {},
  }));
  const identity = { plan: "fixed-plan", model: "fixed-model", codeSha256: "fixed-code", dataSha256: "fixed-data", protocol: "fixed-protocol" };
  const scorer = { expectedLabel: () => "2", async score(_id: string, prediction: string) {
    return { score: 1, expected: "2", prediction, normalizedExpected: "2", normalizedPrediction: "2", method: "fixture" };
  } };
  const answer = { answer: "2", executedNodeIds: [], executedGraphIds: [], inputTokens: 2, outputTokens: 1, totalTokens: 3 };
  const originalOperations = { providerConcurrency: 48, evaluationConcurrency: 48 };
  const currentOperations = { providerConcurrency: 3, evaluationConcurrency: 3 };
  try {
    const first = await CaseRecovery.open(root, identity, originalOperations);
    const failed = await evaluateTasks(tasks, scorer, async task => {
      if (["case-117", "case-118"].includes(task.id)) throw new Error("HTTP 402: balance");
      return answer;
    }, { concurrency: 48, onCase: async progress => first.record(progress.result) });
    await first.finish(failed.valid === true);
    const recovery = await CaseRecovery.open(root, identity, currentOperations);
    assert.equal(recovery.identity, first.identity);
    assert.deepEqual(recovery.originalOperations, originalOperations);
    assert.deepEqual(recovery.currentOperations, currentOperations);
    const called: string[] = [];
    const recovered = await evaluateTasks(tasks, scorer, async task => { called.push(task.id); return answer; }, {
      concurrency: 3, priorCases: recovery.priorCases,
    });
    assert.deepEqual(called, ["case-117", "case-118"]);
    assert.equal(recovered.validRuns, 119);
    for (const field of ["plan", "model", "codeSha256", "dataSha256", "protocol"]) {
      assert.deepEqual((await CaseRecovery.open(root, { ...identity, [field]: "changed" }, currentOperations)).priorCases, []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
