import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import type { ActionDescriptor } from "@codesoul-co/ditto/worker/infer";
import type { BenchmarkTask, ScoreEvidence } from "../domain.js";
import { currentEvaluationCaseId, evaluateTasks } from "./evaluator.js";
import { searchSubset } from "./search-subset.js";
import {currentTimeBudgetSignal,recordTimeBudgetInfrastructureFailure} from '../execution/time-budget.js';
import { requireRecord, requireString, sha256File } from "./io.js";
import type { BenchmarkAdapter, BenchmarkEvaluationOptions, BenchmarkLoadOptions, BenchmarkRunner, LoadedBenchmark } from "./types.js";

export const AUTOMATION_TOOLS = ["api_search", "api_fetch", "base64_encode"] as const;
const REVISION = "4a8e1061254004d9dac807054eed33fad7d1ff14";
const LOCK_HASH = "c7d275af5ad98caa7058edce5806281a340f63781cdff3062622c9c0d5d7c521";
const SPLIT_HASHES = { validate: "926b0d17a075f71a4851f505bc23c02fb982bb6e01e12506db8a605f40033354", test: "fdc0c83b9c1275d8809d28d5c3300e0f38a8b0a8ae2e23eb7700c7195f323331" };
export function automationSplitLock(split:'validate'|'test'){return{sha256:SPLIT_HASHES[split],count:split==='validate'?200:600};}

/** Only public tool access is placed in actor scope; world/rubric operations stay private. */
export interface AutomationSession {
  readonly tools: ActionDescriptor[];
  call(name: string, args: JsonObject): Promise<{ content: string }>;
  record(entry: Readonly<Record<string, unknown>>): void;
  assertHealthy(): void;
}
export const automationScope = new AsyncLocalStorage<AutomationSession>();

export interface AutomationSnapshot {
  readonly world: Record<string, unknown>;
  readonly contract: string;
}
interface AutomationGrade { readonly score: number; readonly partialCredit: number; readonly assertions: unknown }
interface SavedExecution { readonly taskId:string;readonly caseId:string;readonly snapshot: AutomationSnapshot; readonly trace: readonly Readonly<Record<string, unknown>>[]; readonly answer: string; readonly sessionId: string; readonly executionBudget?: import('../domain.js').AgentRunResult['executionBudget'] }

/** Verify the bytes actually executed and fingerprint the official scoring environment. */
export async function automationIdentity() {
  const sourceRoot = resolve(process.env.DITTO_AUTOMATION_ROOT ?? "../AutomationBench-source");
  const python = process.env.DITTO_AUTOMATION_PYTHON ?? "python";
  const execute = promisify(execFile);
  const revision = (await execute("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim();
  const uvLockSha256 = await sha256File(join(sourceRoot, "uv.lock"));
  if (revision !== REVISION || uvLockSha256 !== LOCK_HASH) throw new Error("AutomationBench source revision/lock does not match the frozen protocol");
  await execute("git", ["-C", sourceRoot, "diff", "--exit-code", "HEAD", "--", "automationbench", "pyproject.toml", "uv.lock"], { windowsHide: true });
  const environment = JSON.parse((await execute(python, ["-c", "import json,sys,importlib.metadata as m,importlib.util as u; print(json.dumps({'python':sys.version,'packages':sorted((p.metadata['Name'],p.version) for p in m.distributions()),'module':u.find_spec('automationbench').origin}))"], { windowsHide: true, timeout: 30_000 })).stdout) as { python: string; packages: [string, string][]; module: string };
  const packages = Object.fromEntries(environment.packages);
  if (packages["automation-bench"] !== "1.0.6" || packages.verifiers !== "0.2.1") throw new Error("AutomationBench Python must use the pinned official environment");
  if (resolve(environment.module).toLowerCase() !== resolve(sourceRoot, "automationbench/__init__.py").toLowerCase()) throw new Error("AutomationBench interpreter imports a different source checkout");
  return Object.freeze({
    protocol: "automationbench-public-simple-v1",
    source: Object.freeze({ revision, uvLockSha256, trackedSourceClean: true }),
    environment: Object.freeze({ ...environment, packages: Object.freeze(environment.packages.map((entry) => Object.freeze(entry))), sha256: createHash("sha256").update(JSON.stringify(environment)).digest("hex") }),
    bridge: Object.freeze({ sha256: await sha256File(fileURLToPath(new URL("../../scripts/automation_bridge.py", import.meta.url))), mflowOriginalSha256: "42fb7e9611e0d4834e02440c9c6619901d084bc210f2186df9fdfbcb650549cd", change: "api_search derived index cache relocated outside the source checkout" }),
    scorer: Object.freeze({ module: "automationbench.rubric", functions: Object.freeze(["partial_credit", "task_completed_correctly"]), strictAssertions: true, snapshotContractChecked: true }),
  });
}

/** Serialized environment operations multiplex independent official worlds; model calls stay concurrent. */
export class AutomationBridge {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: AsyncIterator<string>;
  readonly #exit: Promise<void>;
  #queue: Promise<unknown> = Promise.resolve();
  #failure: Error | undefined;
  #stderr = "";
  #closed = false;

  private constructor(python: string, sourceRoot: string) {
    this.#child = spawn(python, ["-B", "-X", "utf8", "-u", fileURLToPath(new URL("../../scripts/automation_bridge.py", import.meta.url))], {
      cwd: sourceRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", AUTOMATIONBENCH_STRICT_ASSERTIONS: "1" },
    });
    this.#lines = createInterface({ input: this.#child.stdout })[Symbol.asyncIterator]();
    this.#child.stderr.on("data", (value) => { this.#stderr = (this.#stderr + String(value)).slice(-4000); });
    this.#child.stdin.on("error", (error) => { this.#failure = error; });
    this.#exit = new Promise((resolveExit) => {
      this.#child.once("error", (error) => { this.#failure = error; resolveExit(); });
      this.#child.once("close", (code) => { this.#failure ??= new Error(`AutomationBench environment exited (${String(code)}): ${this.#stderr}`); resolveExit(); });
    });
  }

  static async open(): Promise<AutomationBridge> {
    const sourceRoot = resolve(process.env.DITTO_AUTOMATION_ROOT ?? "../AutomationBench-source");
    const python = process.env.DITTO_AUTOMATION_PYTHON ?? "python";
    await automationIdentity();
    return new AutomationBridge(python, sourceRoot);
  }

  request<T>(value: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const next = this.#queue.then(async () => {
      signal?.throwIfAborted();
      if (this.#failure) throw this.#failure;
      if (this.#closed) throw new Error("AutomationBench environment is closed");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        const reply = await Promise.race([
          new Promise<never>((_,reject)=>{
            abort=()=>{this.#failure=new Error('AutomationBench active environment call cancelled; world outcome unknown');this.#child.kill();recordTimeBudgetInfrastructureFailure(this.#failure);reject(this.#failure);};
            signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
          }),
          new Promise<IteratorResult<string>>((resolveReply, reject) => {
            this.#child.stdin.write(JSON.stringify(value) + "\n", (error) => { if (error) reject(error); });
            void this.#lines.next().then(resolveReply, reject);
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            this.#failure = new Error("AutomationBench environment request timed out");
            this.#child.kill(); reject(this.#failure);
          }, 60_000); }),
        ]);
        if (reply.done) throw this.#failure ?? new Error(`AutomationBench environment exited: ${this.#stderr}`);
        const data = JSON.parse(reply.value) as { ok: boolean; result: T; error?: string };
        if (data.ok !== true) throw new Error(`AutomationBench environment: ${data.error ?? "invalid response"}`);
        return data.result;
      } finally { if (timer) clearTimeout(timer); if(abort)signal?.removeEventListener('abort',abort); }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  assertHealthy(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new Error("AutomationBench environment is closed");
  }

  async start(taskId: string): Promise<OfficialAutomationSession> {
    const id = randomUUID();
    const start = await this.request<{ tools: { function: { name: string; description?: string; parameters: Record<string, unknown> } }[]; contract: string }>({ op: "start", taskId, session: id },currentTimeBudgetSignal());
    if (!/^[a-f0-9]{64}$/.test(start.contract)) throw new Error("AutomationBench task contract is missing or invalid");
    const tools = start.tools.map(({ function: tool }): ActionDescriptor => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.parameters }));
    if (tools.length !== AUTOMATION_TOOLS.length || new Set(tools.map(t=>t.name)).size!==tools.length || tools.some((tool) => !AUTOMATION_TOOLS.includes(tool.name as typeof AUTOMATION_TOOLS[number]) || tool.inputSchema?.type !== 'object')) throw new Error("AutomationBench tool registry changed");
    return new OfficialAutomationSession(this, id, taskId, start.contract, tools);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#queue;
    this.#closed = true;
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 5000);
    try { await this.#exit; } finally { clearTimeout(timer); }
  }
}

export class OfficialAutomationSession implements AutomationSession {
  readonly trace: Readonly<Record<string, unknown>>[] = [];
  #failure: Error | undefined;
  #closed = false;
  // Only endpoint contracts already returned by this world's public api_search
  // may reject a misplaced path parameter. Unknown endpoints remain official calls.
  readonly #publicEndpoints = new Map<string, PublicEndpoint>();
  constructor(readonly bridge: AutomationBridge, readonly id: string, readonly taskId: string, readonly contract: string, readonly tools: ActionDescriptor[]) {}
  record(entry: Readonly<Record<string, unknown>>): void { this.trace.push(Object.freeze({ at: new Date().toISOString(), ...structuredClone(entry) })); }
  assertHealthy(): void { if(this.#closed)throw new Error('Automation task world is closed');if (this.#failure) throw this.#failure; this.bridge.assertHealthy(); }

  async call(name: string, args: JsonObject): Promise<{ content: string }> {
    this.assertHealthy();
    const argumentError = validateToolArguments(name, args) ?? this.pathArgumentError(name, args);
    if (argumentError) {
      const result = { content: JSON.stringify({ error: { code: "INVALID_TOOL_ARGUMENTS", message: argumentError } }) };
      this.record({ type: "tool-call", name, arguments: args, result, argumentError: true });
      return result;
    }
    try {
      const result = await this.bridge.request<{ content: unknown }>({ op: "call", session: this.id, name, arguments: args },currentTimeBudgetSignal());
      const response = { content: typeof result.content === "string" ? result.content : JSON.stringify(result.content) };
      if (name === "api_search") for (const endpoint of publicEndpoints(response.content)) {
        this.#publicEndpoints.set(`${endpoint.method} ${endpoint.url}`, endpoint);
      }
      this.record({ type: "tool-call", name, arguments: args, result: response });
      return response;
    } catch (error) {
      this.#failure = error instanceof Error ? error : new Error(String(error));
      recordTimeBudgetInfrastructureFailure(this.#failure);
      this.record({ type: "environment-error", name, arguments: args, error: this.#failure.message });
      throw this.#failure;
    }
  }

  private pathArgumentError(name: string, args: JsonObject): string | undefined {
    if (name !== "api_fetch" || typeof args.method !== "string" || typeof args.url !== "string" || typeof args.params !== "string") return undefined;
    let params: unknown;
    try { params = JSON.parse(args.params); } catch { return undefined; }
    if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
    const method = args.method.toUpperCase(), url = args.url;
    const matches = [...this.#publicEndpoints.values()].filter((endpoint) => endpoint.method === method && endpoint.matches.test(url))
      .sort((left, right) => right.literalLength - left.literalLength);
    const endpoint = matches[0];
    // Prefer an explicitly discovered literal/specialized endpoint to a generic
    // placeholder. Ambiguous equally specific contracts stay official calls.
    if (!endpoint || matches[1]?.literalLength === endpoint.literalLength) return undefined;
    const duplicate = endpoint.pathParameters.filter((key) => Object.hasOwn(params, key));
    if (duplicate.length) return `api_fetch query params repeat path parameter(s): ${duplicate.join(", ")}. These fields belong only in the URL path according to the api_search contract; correct the request before retrying.`;
    return undefined;
  }

  async snapshot(): Promise<AutomationSnapshot> {
    this.assertHealthy();
    const snapshot = await this.bridge.request<AutomationSnapshot>({ op: "snapshot", session: this.id });
    if (snapshot.contract !== this.contract || !snapshot.world || typeof snapshot.world !== "object") throw new Error("AutomationBench world/contract checkpoint is invalid");
    return snapshot;
  }
  async grade(snapshot: AutomationSnapshot): Promise<AutomationGrade> {
    if (!snapshot?.world || snapshot.contract !== this.contract) throw new Error("AutomationBench scoring requires the saved world and matching task contract");
    return this.bridge.request<AutomationGrade>({ op: "grade", session: this.id, ...snapshot });
  }
  async close(): Promise<void> {
    if(this.#closed)return;
    this.#closed=true;
    // A dead process has already discarded every world; teardown must not
    // replace the original workflow error (and its consumption diagnostics).
    try { this.bridge.assertHealthy(); } catch { return; }
    await this.bridge.request({ op: "close", session: this.id });
  }
}

interface PublicEndpoint { readonly method: string; readonly url: string; readonly matches: RegExp; readonly literalLength: number; readonly pathParameters: readonly string[] }

/** Use only explicit public location:path declarations, never infer from errors. */
function publicEndpoints(content: string): PublicEndpoint[] {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return []; }
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) return [];
  const endpoints: PublicEndpoint[] = [];
  for (const entry of (value as { results: unknown[] }).results) {
    if (!entry || typeof entry !== "object") continue;
    const endpoint = entry as { method?: unknown; url?: unknown; parameters?: unknown };
    if (typeof endpoint.method !== "string" || typeof endpoint.url !== "string" || !endpoint.parameters || typeof endpoint.parameters !== "object" || Array.isArray(endpoint.parameters)) continue;
    const url = endpoint.url;
    const pathParameters = Object.entries(endpoint.parameters).filter(([key, spec]) => spec && typeof spec === "object"
      && (spec as { location?: unknown }).location === "path" && url.includes(`{${key}}`)).map(([key]) => key);
    // Escape every literal character; placeholders match exactly one URL segment.
    // Anchoring prevents a spreadsheet GET contract matching values/batch endpoints.
    const parts = url.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/);
    const isPlaceholder = (part: string) => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(part);
    const pattern = parts.map((part) => isPlaceholder(part)
      ? "[^/?#]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
    endpoints.push({ method: endpoint.method.toUpperCase(), url, matches: new RegExp(`^${pattern}$`), literalLength: parts.filter((part) => !isPlaceholder(part)).join("").length, pathParameters });
  }
  return endpoints;
}

function validateToolArguments(name: string, args: JsonObject): string | undefined {
  const empty = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  const optionalString = (value: unknown) => value === undefined || value === null || typeof value === "string" || empty(value);
  if (name === "api_search") {
    if (typeof args.query !== "string" || (args.top_k !== undefined && !empty(args.top_k) && !Number.isInteger(args.top_k))) return "api_search requires query:string and optional top_k:integer";
    if (Object.keys(args).some((key) => !["query", "top_k"].includes(key))) return "Unknown api_search argument";
  } else if (name === "api_fetch") {
    if (typeof args.method !== "string" || typeof args.url !== "string" || !optionalString(args.params) || !optionalString(args.body)) return "api_fetch requires method/url strings and optional params/body JSON strings";
    if (Object.keys(args).some((key) => !["method", "url", "params", "body"].includes(key))) return "Unknown api_fetch argument";
    // This endpoint's public api_search contract declares value in an object
    // body. A JSON string is valid JSON but crashes its router's **body before
    // any tool implementation runs. Report the argument error as an observation.
    let trelloPath: string | undefined;
    try { const url=new URL(args.url); if(url.hostname==='api.trello.com')trelloPath=url.pathname; }
    catch { if(/^\/?trello\//.test(args.url))trelloPath=args.url.replace(/^\/?trello/,''); }
    if(args.method.toUpperCase()==='POST' && /^\/1\/cards\/[^/]+\/idLabels\/?$/.test(trelloPath ?? '') && typeof args.body==='string' && args.body.length>0) {
      let body:unknown;
      try {body=JSON.parse(args.body);}catch{return undefined;} // Official malformed-JSON observation.
      if(!body || typeof body!=='object' || Array.isArray(body))return 'Trello add-label body must encode a JSON object, for example {"value":"label_id"}; a JSON string, array or null is not an object';
    }
    if (typeof args.params === "string" && args.params.length > 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(args.params); } catch { return undefined; } // Official API reports malformed JSON as its own 400 observation.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return 'api_fetch params must encode a JSON object; use actual null or "{}" for no query parameters, not the string "null"';
      if (typeof args.body === "string" && args.body.length > 0) {
        let body: unknown;
        try { body = JSON.parse(args.body); } catch { return undefined; } // Preserve official malformed-JSON handling and non-JSON body exceptions.
        if (body !== null && typeof body === "object" && !Array.isArray(body)) {
          const duplicate = Object.keys(parsed).filter((key) => Object.hasOwn(body, key));
          if (duplicate.length) return `api_fetch repeats fields in both params and body: ${duplicate.join(", ")}. Supply each field in only one location according to api_search.`;
        }
      }
    }
  } else if (name === "base64_encode") {
    if (typeof args.text !== "string" || Object.keys(args).some((key) => key !== "text")) return "base64_encode requires text:string";
  } else return `Undeclared official tool: ${name}`;
  return undefined;
}

export const automationAdapter: BenchmarkAdapter = Object.freeze({
  dataset: "automationbench",
  async load(options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
    if (options.limit || options.dataMode === "fixture") throw new Error("Automation formal evaluation requires the complete pinned split without sampling");
    const path = join(options.dataDir, options.split === "validate" ? "search.jsonl" : "test.jsonl");
    const bytes=await readFile(path),rawSha256=createHash('sha256').update(bytes).digest('hex');
    if (rawSha256 !== SPLIT_HASHES[options.split]) throw new Error("AutomationBench split bytes differ from the frozen MFlow manifest");
    const rows = bytes.toString('utf8').split(/\r?\n/).filter(line=>line.trim()).map((line,index):BenchmarkTask => {
      const value:unknown=JSON.parse(line),row=index+1;
      const raw = requireRecord(value, path, row);
      const dataset = requireRecord(raw.dataset, path, row);
      const reference = requireRecord(raw.reference, path, row);
      if (dataset.protocol !== "automationbench-public-simple-v1" || dataset.split !== (options.split === "validate" ? "search" : "test")) throw new Error("AutomationBench split protocol mismatch");
      const taskId = requireString(reference.automationTaskId, "automationTaskId", path, row);
      const id = requireString(raw.id, "id", path, row);
      if (id !== `automationbench:${taskId}`) throw new Error("AutomationBench public task ID mismatch");
      return Object.freeze({ id, dataset: "automationbench", prompt: requireString(raw.prompt, "prompt", path, row), outputInstruction: "", metadata: Object.freeze({ split: options.split, domain: taskId.split(".")[0]! }) });
    });
    if(options.limit)throw Error('Automation formal evaluation uses the complete pinned split');
    if(rows.length!==(options.split==='validate'?200:600)||new Set(rows.map(t=>t.id)).size!==rows.length)throw Error('Automation count/IDs differ from the fixed split');
    const tasks = Object.freeze(rows);
    const identity={protocol:'automationbench-public-simple-v1' as const,dataMode:'formal' as const,baselineRepository:'https://github.com/erwinmsmith/MFlow',baselineCommit:'437040f17a17cbf430f3f41227ca64c576cf1056',upstreamCommit:REVISION,sourceFile:path,rawSha256,sourceCount:rows.length,selectedCount:rows.length,splitRole:options.split==='validate'?'search' as const:'test' as const,verified:true,knownPromptOverlaps:[]};
    const evaluate = async (selectedTasks: readonly BenchmarkTask[], runner: BenchmarkRunner, evaluationOptions?: BenchmarkEvaluationOptions) => {
        const bridge = await AutomationBridge.open();
        const snapshots = new Map<string, SavedExecution>();
        try {
          return await evaluateTasks(selectedTasks, {
            expectedLabel: () => "Official final-world assertions",
            recoveryData(taskId) { const saved = snapshots.get(taskId); snapshots.delete(taskId); return saved; },
            async score(taskId, _prediction, prior): Promise<ScoreEvidence> {
              const saved = snapshots.get(taskId) ?? prior?.judgeRecovery as SavedExecution | undefined;
              if (!saved?.snapshot.world) throw new Error("AutomationBench scoring requires a saved world, not a textual answer");
              if(saved.taskId!==taskId||saved.caseId!==currentEvaluationCaseId()||saved.answer!==_prediction)throw new Error('Automation scoring checkpoint task/repeat/prediction identity differs');
              const session = await bridge.start(taskId.slice("automationbench:".length));
              try {
                const grade = await session.grade(saved.snapshot);
                if ((grade.score !== 0 && grade.score !== 1) || !Number.isFinite(grade.partialCredit) || grade.partialCredit < 0 || grade.partialCredit > 1) throw new Error("Invalid official AutomationBench grade");
                snapshots.delete(taskId);
                return { score: saved.executionBudget?0:grade.score, expected: "Official final-world assertions", prediction: saved.answer, normalizedExpected: "official state assertions", normalizedPrediction: String(saved.executionBudget?0:grade.score), method: "automationbench-official-assertions-v1", details: { strictWorldScore:grade.score,executionBudget:saved.executionBudget,partialCredit: grade.partialCredit, assertions: grade.assertions, finalWorld: saved.snapshot.world, taskContract: saved.snapshot.contract, taskId, officialRevision: REVISION, toolTrace: saved.trace, sessionId: saved.sessionId } };
              } finally { try { await session.close(); } catch (error) { snapshots.set(taskId, saved); throw error; } }
            },
          }, async (task) => {
            const session = await bridge.start(task.id.slice("automationbench:".length));
            try {
              const run = await automationScope.run(session, () => runner(task));
              session.assertHealthy();
              const snapshot = await session.snapshot();
              const caseId=currentEvaluationCaseId();if(!caseId)throw new Error('Automation runner has no evaluator case identity');
              const saved = { taskId:task.id,caseId,snapshot, trace: Object.freeze([...session.trace]), answer: run.answer, sessionId: session.id, ...(run.executionBudget?{executionBudget:run.executionBudget}:{}) };
              snapshots.set(task.id, saved);
              await saveArtifact(options.artifactDir, session.id, { officialRevision: REVISION, ...saved });
              return run;
            } catch (error) {
              let snapshot: AutomationSnapshot | undefined;
              let snapshotError: string | undefined;
              try { snapshot = await session.snapshot(); } catch (failure) { snapshotError = String(failure); }
              await saveArtifact(options.artifactDir, session.id, { taskId: task.id, officialRevision: REVISION,
                error: error instanceof Error ? error.message : String(error), snapshot, snapshotError, trace: session.trace });
              throw error;
            } finally { await session.close(); }
          }, { ...evaluationOptions, cumulativeRetries: true });
        } finally { await bridge.close(); }
      };
    return Object.freeze({ dataset: "automationbench", split: options.split, tasks,identity,
      evaluate: (runner: BenchmarkRunner, evaluationOptions?: BenchmarkEvaluationOptions) => evaluate(tasks, runner, evaluationOptions),
      evaluateSearchSubset: (ids: readonly string[], runner: BenchmarkRunner, evaluationOptions?: BenchmarkEvaluationOptions) => evaluate(searchSubset(options.split,tasks,ids),runner,evaluationOptions),
    });
  },
});

async function saveArtifact(directory: string | undefined, sessionId: string, evidence: Readonly<Record<string, unknown>>): Promise<void> {
  if (!directory) return;
  const target = join(directory, "automation-worlds");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, `${sessionId}.json`), JSON.stringify(evidence, null, 2) + "\n", "utf8");
}
