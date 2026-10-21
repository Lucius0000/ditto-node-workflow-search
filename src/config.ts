import { resolve } from "node:path";
import { DATASETS, type DatasetName } from "./domain.js";

export interface ProviderSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly expectedResponseModel?:string;
}

export function loadProviderSettings(env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  const baseUrl = env.CODE_SOUL_BASE_URL ?? "https://api.deepseek.com";
  const model = env.CODE_SOUL_MODEL ?? "deepseek-flash";
  const apiKey = env.CODE_SOUL_API_KEY;
  if (!apiKey?.trim()) throw new Error("CODE_SOUL_API_KEY is required. Put it in an ignored .env file or the process environment.");
  const concurrency = integer(env.CODE_SOUL_CONCURRENCY ?? "3", "CODE_SOUL_CONCURRENCY", 1, 4_096);
  const timeoutMs = integer(env.CODE_SOUL_TIMEOUT_MS ?? "600000", "CODE_SOUL_TIMEOUT_MS", 1_000, 30 * 60_000);
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CODE_SOUL_BASE_URL must be a plain HTTP(S) URL without credentials, query, or fragment");
  }
  if (model !== "deepseek-flash" || url.origin !== "https://api.deepseek.com" || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("The fixed experiment requires deepseek-flash on the official https://api.deepseek.com endpoint");
  }
  return Object.freeze({ baseUrl: url.href.replace(/\/$/, ""), model, apiKey, concurrency, timeoutMs });
}

export interface ExperimentOptions {
  readonly command: "search" | "test";
  readonly dataset: DatasetName;
  readonly dataDir: string;
  readonly runDir?: string;
  readonly resumeDir?: string;
  readonly resumeRound?: number;
  readonly outputRoot: string;
  readonly searchLimit: number;
  readonly testLimit: number;
  readonly rounds: number;
  readonly repeats: number;
  readonly testRepeats: number;
  readonly evaluationConcurrency: number;
  readonly searchConcurrency: number;
  readonly testConcurrency: number;
  readonly searchProviderConcurrency: number;
  readonly testProviderConcurrency: number;
  readonly topK: number;
  readonly patience: number;
  readonly seed: number;
  readonly maximumDepth: number;
  readonly dockerImage: string;
}

const FLAGS = new Set([
  "dataset", "data-dir", "run-dir", "output-root", "search-limit", "test-limit", "rounds", "repeats",
  "test-repeats", "evaluation-concurrency", "search-concurrency", "test-concurrency", "resume-dir", "resume-round",
  "search-provider-concurrency", "test-provider-concurrency", "top-k", "patience", "seed", "maximum-depth", "docker-image",
]);

export function parseArguments(argv: readonly string[], cwd = process.cwd()): ExperimentOptions {
  const [rawCommand, ...rest] = argv;
  if (rawCommand !== "search" && rawCommand !== "test") {
    throw new Error(`Usage: cli.js <search|test> --dataset <${DATASETS.join("|")}> [options]`);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!FLAGS.has(key)) throw new Error(`Unknown option: --${key}`);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }
  const rawDataset = values.get("dataset") ?? "math";
  if (!isDataset(rawDataset)) throw new Error(`Unsupported dataset: ${rawDataset}`);
  const staged=['humaneval','mbpp','automationbench'].includes(rawDataset);
  if(rawCommand==='test'&&staged)throw Error('These staged workflows have no authorized Test entry; use frozen official full-Search evaluation');
  if (rawCommand === "search" && (values.has("top-k") || values.has("maximum-depth"))) {
    throw new Error(staged?'The staged protocol fixes Top-4 parent selection and 24 active nodes; remove --top-k and --maximum-depth':'Optimizer-directed search has no sampled parents or tree depth; remove --top-k and --maximum-depth');
  }
  for (const flag of ["search-limit", "test-limit"]) {
    if (values.has(flag) && values.get(flag) !== "0") throw new Error(`${flag} must be 0: formal evaluation uses the complete pinned MFlow split without sampling`);
  }
  const runDir = values.get("run-dir");
  const resumeDir = values.get("resume-dir");
  const resumeRound = values.get("resume-round");
  if(staged){
    if(resumeRound!==undefined)throw Error('Staged search resumes its saved pending candidate; do not select a historical resume-round');
    if(values.has('seed')&&values.get('seed')!=='42'||values.has('patience')&&values.get('patience')!=='5')throw Error('Staged search fixes seed42 and convergence patience5');
    for(const flag of ['test-repeats','test-concurrency','test-provider-concurrency'])if(values.has(flag))throw Error('Staged Search has Test0; remove Test configuration');
  }else if ((resumeDir === undefined) !== (resumeRound === undefined) || (resumeDir && rawCommand !== "search")) throw new Error("search resume requires both --resume-dir and --resume-round");
  if (rawCommand === "test" && !runDir) throw new Error("test requires --run-dir <completed search run>");
  const searchConcurrency = integer(values.get("search-concurrency") ?? values.get("evaluation-concurrency")
    ?? process.env.DITTO_SEARCH_CONCURRENCY ?? "3", "search-concurrency", 1, 4_096);
  const testConcurrency = integer(values.get("test-concurrency") ?? values.get("evaluation-concurrency")
    ?? process.env.DITTO_TEST_CONCURRENCY ?? "200", "test-concurrency", 1, 4_096);
  return Object.freeze({
    command: rawCommand,
    dataset: rawDataset,
    dataDir: resolve(cwd, values.get("data-dir") ?? "data/datasets"),
    ...(runDir ? { runDir: resolve(cwd, runDir) } : {}),
    ...(resumeDir ? { resumeDir: resolve(cwd, resumeDir),...(!staged?{resumeRound: integer(resumeRound!, "resume-round", 0, 1_000)}:{}) } : {}),
    outputRoot: resolve(cwd, values.get("output-root") ?? "runs"),
    searchLimit: integer(values.get("search-limit") ?? "0", "search-limit", 0, 100_000),
    testLimit: integer(values.get("test-limit") ?? "0", "test-limit", 0, 100_000),
    rounds: integer(values.get("rounds") ?? (["humaneval", "mbpp","automationbench"].includes(rawDataset) ? "10" : "20"), "rounds", 1, 1_000),
    repeats: integer(values.get("repeats") ?? "5", "repeats", 1, 20),
    testRepeats: integer(values.get("test-repeats") ?? "3", "test-repeats", 1, 20),
    evaluationConcurrency: rawCommand === "search" ? searchConcurrency : testConcurrency,
    searchConcurrency,
    testConcurrency,
    searchProviderConcurrency: integer(values.get("search-provider-concurrency") ?? String(searchConcurrency), "search-provider-concurrency", 1, 4_096),
    testProviderConcurrency: integer(values.get("test-provider-concurrency") ?? String(testConcurrency), "test-provider-concurrency", 1, 4_096),
    topK: integer(values.get("top-k") ?? "4", "top-k", 1, 100),
    patience: integer(values.get("patience") ?? "5", "patience", 1, 100),
    seed: integer(values.get("seed") ?? "42", "seed", 0, 0x7fffffff),
    maximumDepth: integer(values.get("maximum-depth") ?? "10", "maximum-depth", 2, 24),
    dockerImage: values.get("docker-image") ?? process.env.CODE_JUDGE_IMAGE ?? "python:3.12-alpine",
  });
}

function isDataset(value: string): value is DatasetName {
  return (DATASETS as readonly string[]).includes(value);
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return parsed;
}
