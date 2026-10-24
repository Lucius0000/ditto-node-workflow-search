import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { JsonObject, RegisteredTool } from "@codesoul-co/ditto";
import { createTaskMemory } from "../ditto/task-memory.js";
import { closeBenchmarkTools, createBenchmarkTools } from "../ditto/benchmark-tools.js";

const ownedToolSets: Array<readonly RegisteredTool[]> = [];

afterEach(async () => {
  await Promise.all(ownedToolSets.splice(0).map(closeBenchmarkTools));
});

describe("Benchmark tools", () => {
  it('keeps unexpected implementation failures invalid instead of turning them into input zeroes', async () => {
    const tools=createBenchmarkTools({testCrash:true});ownedToolSets.push(tools);
    await assert.rejects(callTool(tools,'bounded_arithmetic',{expression:'1 + 1'}), /Benchmark tool worker failed: Injected tool implementation fault/);
  });
  it("evaluates bounded arithmetic in the trusted tool worker", async () => {
    const tools = createBenchmarkTools();
    ownedToolSets.push(tools);
    assert.deepEqual(await callTool(tools, "bounded_arithmetic", { expression: "(12 + 3) * 2 ^ 3 / 4" }), {
      status: "success",
      structuredContent: { result: 30 },
    });
    assert.deepEqual(await callTool(tools, "bounded_arithmetic", { expression: "-2^2" }), {
      status: "success",
      structuredContent: { result: -4 },
    });
  });

  it("rejects code, malformed input, and tool-schema keys", async () => {
    const tools = createBenchmarkTools();
    ownedToolSets.push(tools);
    tools[0]!.validate({ expression: "1 + 1", script: "process.exit()" });
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "globalThis.process.exit()" })).error?.code, "B_TOOL_INPUT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "1 + (" })).error?.code, "B_TOOL_INPUT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "1 / 0" })).error?.code, "B_TOOL_INPUT");
  });

  it("enforces arithmetic syntax, size, magnitude, and exponent limits", async () => {
    const tools = createBenchmarkTools();
    ownedToolSets.push(tools);
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "2^101" })).error?.code, "B_TOOL_INPUT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: `${"9".repeat(32)}^100` })).error?.code, "B_TOOL_LIMIT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "1".repeat(33) })).error?.code, "B_TOOL_LIMIT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: `1${"+1".repeat(128)}` })).error?.code, "B_TOOL_LIMIT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: `(${"(".repeat(33)}1${")".repeat(33)})` })).error?.code, "B_TOOL_LIMIT");
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "1".repeat(4097) })).error?.code, "B_TOOL_LIMIT");
  });

  it("finds literal text with bounded positions and snippets", async () => {
    const tools = createBenchmarkTools();
    ownedToolSets.push(tools);
    assert.deepEqual(await callTool(tools, "literal_text_find", { text: "a.b a.b", needle: "." }), {
      status: "success",
      structuredContent: {
        count: 2,
        truncated: false,
        matches: [
          { position: 1, snippet: "a.b a.b" },
          { position: 5, snippet: "a.b a.b" },
        ],
      },
    });
    assert.equal((await callTool(tools, "literal_text_find", { text: "abc", needle: "" })).error?.code, "B_TOOL_INPUT");
    assert.equal((await callTool(tools, "literal_text_find", { text: "x".repeat(65537), needle: "x" })).error?.code, "B_TOOL_LIMIT");
    assert.equal((await callTool(tools, "literal_text_find", { text: "abc", needle: "x".repeat(257) })).error?.code, "B_TOOL_LIMIT");
    const many = await callTool(tools, "literal_text_find", { text: "x".repeat(101), needle: "x" });
    assert.equal((many.structuredContent as { count: number }).count, 100);
    assert.equal((many.structuredContent as { truncated: boolean }).truncated, true);
  });

  it("kills a timed-out worker and recovers with a new worker", async () => {
    const tools = createBenchmarkTools({ testDelayMs: 1500 });
    ownedToolSets.push(tools);
    assert.equal((await callTool(tools, "bounded_arithmetic", { expression: "1+1" })).error?.code, "B_TOOL_LIMIT");
    // The same manager starts a fresh worker after terminating the blocked one.
    assert.equal(((await callTool(tools, "bounded_arithmetic", { expression: "2+2" })).structuredContent as { result: number }).result, 4);
  });
});

describe("task-local MemoryResources", () => {
  it("writes actual records and isolates IDs, keys, and lexical search by instance", async () => {
    const first = createTaskMemory();
    const second = createTaskMemory();
    const written = await first.store.write({ memories: [{ key: "evidence", content: "The harbor opened in 1912." }] });
    assert.equal(written.length, 1);
    assert.equal(written[0]!.content, "The harbor opened in 1912.");
    assert.deepEqual(await first.store.get({ ids: [written[0]!.id] }), written);
    assert.deepEqual(await second.store.get({ ids: [written[0]!.id], keys: ["evidence"] }), []);
    assert.deepEqual(await first.search!.search({ query: "harbor 1912" }), [{ memory: written[0]!, score: 1 }]);
    assert.deepEqual(await first.search!.search({ query: "ocean" }), []);
    assert.deepEqual(await second.search!.search({ query: "harbor" }), []);
  });
});

async function callTool(
  tools: readonly RegisteredTool[],
  name: string,
  args: Record<string, string>,
): Promise<{ status: string; error?: { code: string }; structuredContent?: unknown }> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  const jsonArgs = args as JsonObject;
  tool.validate(jsonArgs);
  return tool.execute(jsonArgs, {} as never);
}
