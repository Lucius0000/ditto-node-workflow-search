import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetName } from "../domain.js";
import { stratifiedSample } from "./sampling.js";
import type { BenchmarkIdentity, BenchmarkLoadOptions, BenchmarkSplit } from "./types.js";

export const MFLOW_BASELINE_REPOSITORY = "https://github.com/erwinmsmith/MFlow";
export const MFLOW_BASELINE_COMMIT = "9279d7d91bbce039656f5cd3a6bb539cea75fe85";
export const AFLOW_UPSTREAM_COMMIT = "3f457218fc716093fe53f6df8a5d5e6379d66346";
export const FIXED_SPLIT_PROTOCOL = "aflow-fixed-v1";

/** Published exceptions are retained; never deduplicate or regroup these passages. */
export const MFLOW_DROP_KNOWN_PROMPT_OVERLAPS = Object.freeze([
  Object.freeze({ searchId: "drop:563", testId: "drop:5145", promptHash: "d142d8eefddf17dc4c6b2786b206499505791a8990d7d221e24106f863978be3" }),
  Object.freeze({ searchId: "drop:5872", testId: "drop:7202", promptHash: "dcf738c75bbe59726d15d5631497bc6d39211a30052d3e0332c8f8e4dcd1d061" }),
  Object.freeze({ searchId: "drop:8540", testId: "drop:4560", promptHash: "af774a6731624ec05457c468032b13a4e14bb5f9ece4a3c8e80885419825c377" }),
  Object.freeze({ searchId: "drop:3024", testId: "drop:871", promptHash: "1ff587a57a1c61f2f1d8f61eef83a1b2bdd65c49999c897d4968e8656b3d8166" }),
  Object.freeze({ searchId: "drop:131", testId: "drop:3879", promptHash: "abd3a8aa80e8447f8afd59f5490f31e2a1a89267acb77e85b324461c782fd922" }),
]);

export interface FixedSplitLock {
  readonly count: number;
  readonly sha256: string;
}

// Raw byte identities from MFlow data/aflow.lock.json at MFLOW_BASELINE_COMMIT.
// Do not substitute convertedSha256: these adapters consume AFlow's raw files.
export const FIXED_SPLIT_LOCKS: Readonly<Record<`${Exclude<DatasetName, 'automationbench'>}_${BenchmarkSplit}.jsonl`, FixedSplitLock>> = Object.freeze({
  "drop_validate.jsonl": Object.freeze({ count: 200, sha256: "fa761d3f46c3c995278532ee9354fe78fd03fa6567774ea359e149dea5cf2362" }),
  "drop_test.jsonl": Object.freeze({ count: 800, sha256: "a0ae6fac687d2bb393c9c6a43d966edf9ed24d0d157cfb7f7a4747cc8b3d9742" }),
  "humaneval_validate.jsonl": Object.freeze({ count: 33, sha256: "7c09e2424572a0e82b14d2dc145bf86feb2aeef9828b8b37c7e87dfe88d902f7" }),
  "humaneval_test.jsonl": Object.freeze({ count: 131, sha256: "5f7417d249b5a1153d1313c944fafe61f5bcb19717b8d952eb45e6ea5aaa23d9" }),
  "mbpp_validate.jsonl": Object.freeze({ count: 86, sha256: "04c54e076bb2cb1a583d8e57110e3a644ae3125699b3309104d3b8cf95436216" }),
  "mbpp_test.jsonl": Object.freeze({ count: 341, sha256: "0e9485dee21c836087453255557f92457b145dce7dad22b980e007c0500a12b0" }),
  "gsm8k_validate.jsonl": Object.freeze({ count: 264, sha256: "0502dcec3263f5172e450141ff79da1f84401ed0c7e5d51016b3f773fb7ee869" }),
  "gsm8k_test.jsonl": Object.freeze({ count: 1055, sha256: "2b8372f7b81d842fea01efb66193152b42506e2b23c890c3d90d2aef228dd788" }),
  "math_validate.jsonl": Object.freeze({ count: 119, sha256: "0ade63e8c9fe01fb8964fa22f73423be5e1c78addc9942808de464cabab188c0" }),
  "math_test.jsonl": Object.freeze({ count: 486, sha256: "343361223de598f1a8ca101edd5d4a063b8152a3ae80f845855b0d8cfb858e5c" }),
});

export function fixedSplitLock(dataset: DatasetName, split: BenchmarkSplit): FixedSplitLock {
  if (dataset === "automationbench") throw new Error("AutomationBench uses its official public-simple split manifest");
  return FIXED_SPLIT_LOCKS[`${dataset}_${split}.jsonl`];
}

/** Verify before exposing records to any actor or scorer. */
export function verifySplitBytes(bytes: Uint8Array, expected: FixedSplitLock, sourceFile: string): string {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256) {
    throw new Error(`MFlow ${FIXED_SPLIT_PROTOCOL} SHA-256 mismatch for ${sourceFile}: expected ${expected.sha256}, got ${sha256}. Refusing a changed benchmark.`);
  }
  const count = Buffer.from(bytes).toString("utf8").split(/\r?\n/).filter((line) => line.trim()).length;
  if (count !== expected.count) {
    throw new Error(`MFlow ${FIXED_SPLIT_PROTOCOL} row count mismatch for ${sourceFile}: expected ${expected.count}, got ${count}.`);
  }
  return sha256;
}

export async function readBenchmarkSplit<T>(
  dataset: DatasetName,
  options: BenchmarkLoadOptions,
  validate: (value: unknown, row: number, path: string) => T,
  fixtureStratum: (value: T) => string,
): Promise<{ readonly rows: readonly T[]; readonly identity: BenchmarkIdentity }> {
  const dataMode = options.dataMode ?? "formal";
  if (dataMode !== "formal" && dataMode !== "fixture") throw new Error(`Unknown benchmark data mode: ${dataMode}`);
  const limit = options.limit ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Benchmark limit must be a nonnegative safe integer.");
  if (dataMode === "formal" && limit !== 0) {
    throw new Error(`MFlow ${FIXED_SPLIT_PROTOCOL} formal evaluation requires the complete fixed split in its published order; limit/sampling is forbidden.`);
  }
  const sourceFile = `${dataset}_${options.split}.jsonl`;
  const path = join(options.dataDir, sourceFile);
  // Hash and parse exactly the same immutable read; a second read can race a file change.
  const bytes = await readFile(path);
  const rawSha256 = dataMode === "formal"
    ? verifySplitBytes(bytes, fixedSplitLock(dataset, options.split), sourceFile)
    : createHash("sha256").update(bytes).digest("hex");
  const rows: T[] = [];
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON at ${path}:${index + 1}`, { cause: error });
    }
    rows.push(validate(value, index + 1, path));
  }
  if (!rows.length) throw new Error(`Dataset split is empty: ${path}`);
  const selected = dataMode === "fixture"
    ? stratifiedSample(rows, limit, options.seed ?? 42, fixtureStratum)
    : Object.freeze(rows);
  return Object.freeze({
    rows: selected,
    identity: Object.freeze({
      protocol: dataMode === "formal" ? FIXED_SPLIT_PROTOCOL : "fixture",
      dataMode,
      baselineRepository: MFLOW_BASELINE_REPOSITORY,
      baselineCommit: MFLOW_BASELINE_COMMIT,
      upstreamCommit: AFLOW_UPSTREAM_COMMIT,
      sourceFile,
      rawSha256,
      sourceCount: rows.length,
      selectedCount: selected.length,
      splitRole: options.split === "validate" ? "search" : "test",
      verified: dataMode === "formal",
      knownPromptOverlaps: dataset === "drop" && dataMode === "formal" ? MFLOW_DROP_KNOWN_PROMPT_OVERLAPS : Object.freeze([]),
    }),
  });
}
