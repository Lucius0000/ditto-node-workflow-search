import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluationCodeHash, evaluationCompiledHash, evaluationRuntimeIdentity, assertEvaluationRuntimeIdentity } from "../run/case-recovery.js";
import { checkpointForPlan, assertCheckpointExecutionIdentity } from "../run/checkpoints.js";
import { materializeAgentPlan, createRootNode, createInitialSampleNode } from "../workflow/spec.js";

const environment = { pythonExecutable: "fixture/python", pythonVersion: "3.13.0", openaiVersion: "2.14.0", httpxVersion: "0.28.1" };
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ditto-runtime-identity-"));
  for (const name of ["src", "scripts", "dist"]) await mkdir(join(root, name));
  await writeFile(join(root, "src", "fixture.ts"), "export const value = 1;\n");
  await writeFile(join(root, "dist", "fixture.js"), "export const value = 1;\n");
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "requirements-provider.txt"), "openai==2.14.0\nhttpx==0.28.1\n");
  return root;
}

test("provider dependency pins participate in normalized source identity", async () => {
  const root = await fixture();
  try {
    const original = await evaluationCodeHash(root);
    await writeFile(join(root, "requirements-provider.txt"), "openai==2.14.0\r\nhttpx==0.28.1\r\n");
    assert.equal(await evaluationCodeHash(root), original);
    await writeFile(join(root, "requirements-provider.txt"), "openai==1.82.0\nhttpx==0.28.1\n");
    assert.notEqual(await evaluationCodeHash(root), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale compiled bytes and actual SDK changes cannot match the frozen execution identity", async () => {
  const root = await fixture();
  try {
    const original = await evaluationRuntimeIdentity(root, environment);
    assertEvaluationRuntimeIdentity(original, await evaluationRuntimeIdentity(root, environment));
    await writeFile(join(root, "dist", "fixture.js"), "export const value = 2;\n");
    const stale = await evaluationRuntimeIdentity(root, environment);
    assert.equal(stale.sourceSha256, original.sourceSha256);
    assert.notEqual(stale.compiledSha256, original.compiledSha256);
    assert.throws(() => assertEvaluationRuntimeIdentity(original, stale), /compiled artifact/);
    await writeFile(join(root, "dist", "fixture.js"), "export const value = 1;\n");
    const changedSdk = await evaluationRuntimeIdentity(root, { ...environment, openaiVersion: "1.82.0" });
    assert.notEqual(changedSdk.providerEnvironmentSha256, original.providerEnvironmentSha256);
    assert.throws(() => assertEvaluationRuntimeIdentity(original, changedSdk), /provider environment/);
    await assert.rejects(evaluationRuntimeIdentity(root, { ...environment, apiKey: "secret" }), /Invalid provider environment field/);
    await assert.rejects(evaluationRuntimeIdentity(root, { pythonVersion: "3.13" }), /actual pythonExecutable/);
    await assert.rejects(evaluationCompiledHash(root, "missing"), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new checkpoints carry and enforce the exact runtime identity while legacy checkpoints remain readable", async () => {
  const root = await fixture();
  try {
    const actual = await evaluationRuntimeIdentity(root, environment);
    const plan = materializeAgentPlan("search-001", [createRootNode(), createInitialSampleNode()]);
    const manifest = { dataset: "math", model: "fixture", endpoint: "https://example.invalid", protocol: {},
      metricProfile: "fixture", dittoVersion: "0.1.1", executionIdentity: actual };
    const checkpoint = checkpointForPlan(plan, manifest);
    assert.deepEqual(checkpoint.executionIdentity, actual);
    assertCheckpointExecutionIdentity(checkpoint, actual);
    const legacy = checkpointForPlan(plan, { ...manifest, executionIdentity: undefined });
    assert.throws(() => assertCheckpointExecutionIdentity(legacy, actual), /Missing frozen execution identity/);
    const changed = await evaluationRuntimeIdentity(root, { ...environment, pythonVersion: "3.12.14" });
    assert.throws(() => assertCheckpointExecutionIdentity(checkpoint, changed), /differs from frozen/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
