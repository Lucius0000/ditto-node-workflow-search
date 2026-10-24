import { Worker } from "node:worker_threads";
import type { JsonObject, JsonValue, RegisteredTool } from "@codesoul-co/ditto";

export class CapabilityToolInputError extends Error {
  readonly kind = "input";
}

export class CapabilityToolLimitError extends Error {
  readonly kind = "limit";
}

/** Worker startup, protocol, or execution faults are infrastructure failures. */
export class CapabilityToolWorkerError extends Error {
  readonly kind = "worker";
}

export interface CapabilityToolFactoryOptions {
  /** Test-only hook for proving parent-enforced timeout and worker replacement. */
  readonly testDelayMs?: number;
  readonly testCrash?: boolean;
}

type ToolName = "bounded_arithmetic" | "literal_text_find";
type WorkerReply =
  | { id: number; ok: true; value: JsonValue }
  | { id: number; ok: false; kind: "input" | "limit"; message: string };
type WorkerRequest = { id: number; tool: ToolName; args: JsonObject };

class ToolWorkerManager {
  private worker: Worker | undefined;
  private pending: { id: number; worker: Worker; resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private requestId = 0;
  private queue: Promise<void> = Promise.resolve();
  private firstWorker = true;

  constructor(private readonly testDelayMs?: number, private readonly testCrash = false) {}

  run(tool: ToolName, args: JsonObject): Promise<JsonValue> {
    const operation = this.queue.then(() => this.invoke(tool, args));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new CapabilityToolWorkerError("Benchmark tool worker closed during a call"));
      this.pending = undefined;
    }
    if (worker) await worker.terminate();
  }

  private invoke(tool: ToolName, args: JsonObject): Promise<JsonValue> {
    const worker = this.ensureWorker();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        this.worker = undefined;
        void worker.terminate();
        reject(new CapabilityToolLimitError("Benchmark tool exceeded its 1000 ms execution deadline"));
      }, 1000);
      this.pending = { id, worker, resolve, reject, timer };
      worker.postMessage({ id, tool, args } satisfies WorkerRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerData = this.firstWorker ? { ...(this.testDelayMs !== undefined ? { testDelayMs: this.testDelayMs } : {}), testCrash: this.testCrash } : undefined;
    this.firstWorker = false;
    const worker = new Worker(new URL("./benchmark-tool-worker.js", import.meta.url), {
      ...(workerData === undefined ? {} : { workerData }),
    });
    worker.on("message", (reply: WorkerReply) => {
      const pending = this.pending?.worker === worker && this.pending.id === reply.id ? this.pending : undefined;
      if (!pending) return;
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(reply.kind === "limit" ? new CapabilityToolLimitError(reply.message) : new CapabilityToolInputError(reply.message));
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.worker = undefined;
      const pending = this.pending?.worker === worker ? this.pending : undefined;
      if (pending) {
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.reject(new CapabilityToolWorkerError(`Benchmark tool worker failed: ${error.message}`));
      }
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = undefined;
      const pending = this.pending?.worker === worker ? this.pending : undefined;
      if (pending) {
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.reject(new CapabilityToolWorkerError(`Benchmark tool worker exited unexpectedly with code ${code}`));
      }
    });
    this.worker = worker;
    return worker;
  }
}

const owners = new WeakMap<readonly RegisteredTool[], ToolWorkerManager>();

export function createBenchmarkTools(options: CapabilityToolFactoryOptions = {}): readonly RegisteredTool[] {
  if (options.testDelayMs !== undefined && (!Number.isInteger(options.testDelayMs) || options.testDelayMs < 0 || options.testDelayMs > 5000)) {
    throw new RangeError("testDelayMs must be an integer from 0 to 5000");
  }
  if (options.testCrash !== undefined && typeof options.testCrash !== 'boolean') throw new TypeError('testCrash must be boolean');
  const manager = new ToolWorkerManager(options.testDelayMs, options.testCrash);
  const tools: readonly RegisteredTool[] = [
    {
      name: "bounded_arithmetic",
      description: "Evaluate bounded decimal arithmetic with +, -, *, /, parentheses, and integer powers.",
      inputSchema: {
        type: "object",
        properties: { expression: { type: "string", maxLength: 4096 } },
        required: ["expression"],
        additionalProperties: false,
      },
      effects: [],
      // Ditto ToolRegistry calls validate outside execute; keep expected input errors semantic.
      validate() {},
      async execute(args, _context) {
        try {
          validateExactStringArgs(args, ["expression"]);
          const result = await manager.run("bounded_arithmetic", args);
          return { status: "success", structuredContent: { result } };
        } catch (error) {
          return expectedToolFailure(error);
        }
      },
    },
    {
      name: "literal_text_find",
      description: "Find literal occurrences in supplied public text and return bounded positions and snippets.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 65536 },
          needle: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["text", "needle"],
        additionalProperties: false,
      },
      effects: ["read"],
      // Ditto ToolRegistry calls validate outside execute; keep expected input errors semantic.
      validate() {},
      async execute(args, _context) {
        try {
          validateExactStringArgs(args, ["text", "needle"]);
          const result = await manager.run("literal_text_find", args);
          return { status: "success", structuredContent: result as JsonValue };
        } catch (error) {
          return expectedToolFailure(error);
        }
      },
    },
  ];
  owners.set(tools, manager);
  return tools;
}

export async function closeBenchmarkTools(tools: readonly RegisteredTool[]): Promise<void> {
  const manager = owners.get(tools);
  if (!manager) return;
  owners.delete(tools);
  await manager.close();
}

function validateExactStringArgs(args: JsonObject, allowed: readonly string[]): void {
  const keys = Object.keys(args);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new CapabilityToolInputError(`arguments must contain exactly: ${allowed.join(", ")}`);
  }
  for (const key of allowed) {
    if (typeof args[key] !== "string") throw new CapabilityToolInputError(`${key} must be a string`);
  }
}

function expectedToolFailure(error: unknown): { status: "failed"; error: { code: string; message: string; retryable: false } } {
  if (error instanceof CapabilityToolInputError) {
    return { status: "failed", error: { code: "B_TOOL_INPUT", message: error.message, retryable: false } };
  }
  if (error instanceof CapabilityToolLimitError) {
    return { status: "failed", error: { code: "B_TOOL_LIMIT", message: error.message, retryable: false } };
  }
  throw error;
}
