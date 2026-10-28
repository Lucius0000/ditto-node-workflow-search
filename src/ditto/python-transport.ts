import type { ProviderCallDiagnostics } from "../domain.js";
import { currentProviderDiagnostics } from "./provider-diagnostics.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../config.js";
import type { ExperimentModelProfile } from "../model-profile.js";
import { currentTimeBudgetPolicy, timeBudgetFailureRecorder } from "../execution/time-budget.js";

interface PendingRequest {
  resolve(value: Response): void;
  reject(error: Error): void;
  cleanup(): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  diagnostics?: ProviderCallDiagnostics[];
  progress?: ProviderCallDiagnostics;
  recordFailure(error: Error): void;
}

interface BridgeReply {
  id: number;
  status?: number;
  body?: unknown;
  diagnostics?: ProviderCallDiagnostics;
  event?: "start" | "chunk" | "end" | "error" | "attempt";
}

export interface PythonTransportOptions {
  readonly profile?: ExperimentModelProfile;
  readonly requestTimeoutMs?: number | null;
  /** Connection establishment has a separate infrastructure deadline. */
  readonly connectTimeoutMs?: number;
  /** Fixture process hook; never needed for the production transport. */
  readonly command?: string;
  readonly arguments?: readonly string[];
}

/** Public fetch injection; neither Ditto npm nor AFlow source is patched. */
export class PythonTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #profile: ExperimentModelProfile;
  readonly #encoder = new TextEncoder();
  #id = 0;
  readonly #timeoutMs: number | null;
  readonly #connectTimeoutMs: number;
  #failure: Error | undefined;
  #closed = false;
  readonly #exit: Promise<void>;

  constructor(settings: ProviderSettings, options: PythonTransportOptions = {}) {
    this.#timeoutMs = options.requestTimeoutMs === undefined ? settings.timeoutMs : options.requestTimeoutMs;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#connectTimeoutMs) || this.#connectTimeoutMs < 1) throw new Error("Connect timeout must be positive integer milliseconds");
    this.#profile = options.profile ?? "math";
    const python = options.command ?? process.env.DITTO_PROVIDER_PYTHON ?? process.env.AFLOW_SCORER_PYTHON ?? "python";
    this.#child = spawn(python, options.arguments ? [...options.arguments] : ["-u", fileURLToPath(new URL("../../scripts/provider_bridge.py", import.meta.url))], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", CODE_SOUL_BASE_URL: settings.baseUrl, CODE_SOUL_API_KEY: settings.apiKey },
    });
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stderr.resume();
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      try { this.#reply(JSON.parse(line) as BridgeReply); }
      catch { this.#fail(new Error("Provider bridge protocol error")); }
    });
    this.#exit = new Promise<void>((resolve) => {
      this.#child.once("error", (error) => { this.#fail(error); resolve(); });
      this.#child.once("close", (code) => {
        this.#fail(new Error(`Provider bridge exited (${String(code)})`));
        resolve();
      });
    });
  }

  readonly fetch: typeof globalThis.fetch = async (_url, init) => {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new Error("Provider bridge is closed");
    init?.signal?.throwIfAborted();
    if (typeof init?.body !== "string") throw new Error("Provider bridge requires a JSON body");
    const id = ++this.#id;
    const body: unknown = JSON.parse(init.body);
    const diagnostics = currentProviderDiagnostics();
    const recordFailure = timeBudgetFailureRecorder();
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => this.#cancel(id, new Error("Provider bridge request cancelled"));
      const cleanup = (): void => init.signal?.removeEventListener("abort", aborted);
      this.#pending.set(id, { resolve, reject, cleanup, recordFailure, ...(diagnostics ? { diagnostics } : {}) });
      init.signal?.addEventListener("abort", aborted, { once: true });
      if (init.signal?.aborted) { aborted(); return; }
      const policy = currentTimeBudgetPolicy();
      this.#write({ id, body, profile: this.#profile, timeoutMs: policy ? policy.requestMs : this.#timeoutMs, connectTimeoutMs: this.#connectTimeoutMs, reportAttempts: true });
    });
  };

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const id of this.#pending.keys()) this.#cancel(id, new Error("Provider bridge closed"));
      this.#child.stdin.end();
    }
    const timer = setTimeout(() => this.#child.kill(), 5_000);
    try { await this.#exit; } finally { clearTimeout(timer); }
  }

  #write(message: unknown): void {
    if (this.#failure || this.#child.stdin.destroyed) return;
    this.#child.stdin.write(JSON.stringify(message) + "\n", (error) => { if (error) this.#fail(error); });
  }

  #cancel(id: number, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.cleanup();
    // Cancellation can occur during an SDK retry before its final reply. Retain
    // the last admitted HTTP-attempt count instead of pretending this was one call.
    if (pending.progress) pending.diagnostics?.push({ ...pending.progress,
      failedAttempts: pending.progress.attempts, unknownUsageAttempts: pending.progress.attempts, usageKnown: false });
    if (pending.controller) pending.controller.error(error);
    else pending.reject(error);
    this.#write({ cancel: id });
  }

  #reply(reply: BridgeReply): void {
    if (!Number.isSafeInteger(reply.id)) throw new Error("Invalid request id");
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    if (reply.event === "attempt") {
      if (!reply.diagnostics) throw new Error("Attempt event omitted diagnostics");
      pending.progress = reply.diagnostics;
      if (reply.status !== undefined && reply.status >= 400) pending.recordFailure(new Error(`HTTP ${reply.status}: provider request failed before budget expiry`));
      else if (reply.diagnostics.attempts > 1) pending.recordFailure(new Error("fetch failed: provider SDK retried after a transport failure"));
      return;
    }
    if (reply.diagnostics) pending.diagnostics?.push(reply.diagnostics);
    if (reply.event === "start") {
      if (pending.controller) throw new Error("Duplicate stream start");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { pending.controller = controller; },
        cancel: () => this.#cancel(reply.id, new Error("Provider bridge stream cancelled")),
      });
      pending.resolve(new Response(stream, { status: reply.status ?? 200, headers: { "content-type": "text/event-stream" } }));
      return;
    }
    if (reply.event === "chunk") {
      if (!pending.controller || reply.body === undefined) throw new Error("Stream chunk without start");
      pending.controller.enqueue(this.#encoder.encode(`data: ${JSON.stringify(reply.body)}\n\n`));
      return;
    }
    if (reply.event === "end") {
      if (!pending.controller) throw new Error("Stream end without start");
      this.#pending.delete(reply.id);
      pending.cleanup();
      pending.controller.enqueue(this.#encoder.encode("data: [DONE]\n\n"));
      pending.controller.close();
      return;
    }
    if (!pending.controller && (!Number.isInteger(reply.status) || reply.status! < 200 || reply.status! > 599)) throw new Error("Invalid HTTP status");
    const response = pending.controller ? undefined : new Response(JSON.stringify(reply.body), {
      status: reply.status!, headers: { "content-type": "application/json" },
    });
    this.#pending.delete(reply.id);
    pending.cleanup();
    if (pending.controller) {
      pending.controller.error(new Error(`Provider bridge stream failed (HTTP ${String(reply.status ?? 599)})`));
    } else {
      pending.resolve(response!);
    }
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const item of this.#pending.values()) {
      item.cleanup();
      if (item.controller) item.controller.error(error);
      else item.reject(error);
    }
    this.#pending.clear();
  }
}
