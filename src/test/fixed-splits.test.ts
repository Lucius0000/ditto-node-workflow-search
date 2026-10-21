import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AFLOW_DATASETS as DATASETS } from "../domain.js";
import { fixedSplitLock, MFLOW_DROP_KNOWN_PROMPT_OVERLAPS, verifySplitBytes } from "../benchmark/fixed-splits.js";
import { loadBenchmark } from "../benchmark/registry.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

test("fixed split verifier binds content, ordering, line endings, and count", () => {
  const bytes = Buffer.from('{"id":9}\n{"id":2}\n');
  const lock = { count: 2, sha256: digest(bytes) };
  assert.equal(verifySplitBytes(bytes, lock, "fixture.jsonl"), lock.sha256);
  for (const changed of [
    '{"id":9}\n{"id":3}\n',
    '{"id":2}\n{"id":9}\n',
    '{"id":9}\r\n{"id":2}\r\n',
  ]) {
    assert.throws(() => verifySplitBytes(Buffer.from(changed), lock, "fixture.jsonl"), /SHA-256 mismatch/);
  }
  assert.throws(() => verifySplitBytes(bytes, { ...lock, count: 3 }, "fixture.jsonl"), /row count mismatch/);
});

test("every formal adapter rejects limit/sampling before loading data", async () => {
  for (const dataset of DATASETS) {
    for (const split of ["validate", "test"] as const) {
      for (const limit of [1, fixedSplitLock(dataset, split).count]) {
        await assert.rejects(
          loadBenchmark(dataset, { dataDir: "nonexistent-dataset-directory", split, limit }),
          /complete fixed split.*sampling is forbidden/,
        );
      }
    }
  }
});

test("formal mode refuses arbitrary files, and fixtures must opt in explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-fixed-splits-"));
  try {
    const prompts = ["Passage: nine\nQuestion: which?\nAnswer:", "Passage: two\nQuestion: which?\nAnswer:"];
    await writeFile(join(directory, "drop_validate.jsonl"), [9, 2].map((id, index) => JSON.stringify({
      id, context: prompts[index], ref_text: "private-answer", completion: "private-completion",
    })).join("\n") + "\n");
    await assert.rejects(loadBenchmark("drop", { dataDir: directory, split: "validate" }), /SHA-256 mismatch/);
    const loaded = await loadBenchmark("drop", { dataDir: directory, split: "validate", dataMode: "fixture" });
    assert.deepEqual(loaded.tasks.map((task) => task.id), ["drop:9", "drop:2"]);
    assert.deepEqual(loaded.tasks.map((task) => task.prompt), prompts);
    assert.ok(loaded.tasks.every((task) => task.outputInstruction === ""));
    assert.doesNotMatch(JSON.stringify(loaded.tasks), /private-answer|private-completion/);
    assert.equal(loaded.identity?.protocol, "fixture");
    assert.equal(loaded.identity?.verified, false);
    assert.equal(loaded.identity?.sourceCount, 2);
    assert.equal(loaded.identity?.selectedCount, 2);
    assert.equal(loaded.identity?.splitRole, "search");
    assert.deepEqual(loaded.identity?.knownPromptOverlaps, []);
    const limited = await loadBenchmark("drop", { dataDir: directory, split: "validate", dataMode: "fixture", limit: 1 });
    assert.equal(limited.tasks.length, 1);
    assert.equal(limited.identity?.sourceCount, 2);
    assert.equal(limited.identity?.selectedCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all adapters preserve MFlow public prompts and IDs while keeping references private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-mflow-public-input-"));
  const prompt = "Keep this exact public prompt.\n";
  const fixtures = {
    drop: { id: 8, context: prompt, ref_text: "PRIVATE_GOLD", completion: "PRIVATE_COMPLETION" },
    gsm8k: { id: "gsm8k-test-8", question: prompt, answer: "PRIVATE_GOLD", cot: "PRIVATE_COT" },
    math: { problem: prompt, solution: "PRIVATE_GOLD", type: "Algebra", level: "Level 1" },
    humaneval: { task_id: "HumanEval/8", prompt, entry_point: "answer", canonical_solution: "PRIVATE_GOLD", test: "PRIVATE_TEST" },
    mbpp: { task_id: 8, prompt, entry_point: "answer", code: "PRIVATE_GOLD", test: "PRIVATE_TEST", test_imports: ["PRIVATE_IMPORT"] },
  };
  const expectedIds = {
    drop: "drop:8", gsm8k: "gsm8k:gsm8k-test-8", math: `math:${digest(Buffer.from(prompt))}`,
    humaneval: "humaneval:HumanEval/8", mbpp: "mbpp:8",
  };
  try {
    for (const dataset of DATASETS) {
      await writeFile(join(directory, `${dataset}_test.jsonl`), JSON.stringify(fixtures[dataset]) + "\n");
      await assert.rejects(loadBenchmark(dataset, { dataDir: directory, split: "test" }), /SHA-256 mismatch/);
      const loaded = await loadBenchmark(dataset, { dataDir: directory, split: "test", dataMode: "fixture" });
      assert.equal(loaded.tasks[0]?.id, expectedIds[dataset]);
      assert.equal(loaded.tasks[0]?.prompt, prompt);
      assert.equal(loaded.tasks[0]?.outputInstruction, "");
      assert.doesNotMatch(JSON.stringify(loaded.tasks), /PRIVATE_/);
      assert.equal(loaded.identity?.splitRole, "test");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DROP's five published overlap exceptions stay explicit", () => {
  assert.deepEqual(MFLOW_DROP_KNOWN_PROMPT_OVERLAPS.map(({ searchId, testId }) => [searchId, testId]), [
    ["drop:563", "drop:5145"], ["drop:5872", "drop:7202"], ["drop:8540", "drop:4560"],
    ["drop:3024", "drop:871"], ["drop:131", "drop:3879"],
  ]);
  assert.ok(MFLOW_DROP_KNOWN_PROMPT_OVERLAPS.every(({ promptHash }) => /^[a-f0-9]{64}$/.test(promptHash)));
});
