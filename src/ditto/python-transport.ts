import type { ProviderCallDiagnostics } from "../domain.js";
import { currentProviderDiagnostics } from "./provider-diagnostics.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProviderSettings } from "../config.js";
import type { ExperimentModelProfile } from "../model-profile.js";

interface PendingRequest {
  responseModelSeen?:boolean;
  resolve(value: Response): void;
  reject(error: Error): void;
  cleanup(): void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  diagnostics?: ProviderCallDiagnostics[];
}

interface BridgeReply {
  id: number;
  status?: number;
  body?: unknown;
  diagnostics?: ProviderCallDiagnostics;
  event?: "start" | "chunk" | "end" | "error";
}

export interface PythonTransportOptions {
  readonly profile?: ExperimentModelProfile;
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
  readonly #timeoutMs: number;
  readonly #expectedResponseModel:string|undefined;
  #failure: Error | undefined;
  #closed = false;
  readonly #exit: Promise<void>;

  constructor(settings: ProviderSettings, options: PythonTransportOptions = {}) {
    this.#timeoutMs = settings.timeoutMs;
    this.#expectedResponseModel=settings.expectedResponseModel;
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
      catch(error) { this.#fail(error instanceof Error&&error.message.startsWith('Provider returned')?error:new Error("Provider bridge protocol error")); }
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
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => this.#cancel(id, new Error("Provider bridge request cancelled"));
      const cleanup = (): void => init.signal?.removeEventListener("abort", aborted);
      this.#pending.set(id, { resolve, reject, cleanup, ...(diagnostics ? { diagnostics } : {}) });
      init.signal?.addEventListener("abort", aborted, { once: true });
      if (init.signal?.aborted) { aborted(); return; }
      this.#write({ id, body, profile: this.#profile, timeoutMs: this.#timeoutMs });
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
    // Cancellation can predate the SDK's terminal usage record. Keep a known
    // lower-bound attempt rather than silently treating the paid tail as zero.
    pending.diagnostics?.push({requestId:id,attempts:1,failedAttempts:1,unknownUsageAttempts:1,usageKnown:false,inputTokens:0,outputTokens:0,totalTokens:0});
    pending.cleanup();
    if (pending.controller) pending.controller.error(error);
    else pending.reject(error);
    this.#write({ cancel: id });
  }

  #reply(reply: BridgeReply): void {
    if (!Number.isSafeInteger(reply.id)) throw new Error("Invalid request id");
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    const model=reply.body&&typeof reply.body==='object'?(reply.body as {model?:unknown}).model:undefined;
    if(this.#expectedResponseModel&&model!==undefined&&model!==this.#expectedResponseModel)throw Error('Provider returned a different frozen model identity; stop and review before resuming');
    if(model===this.#expectedResponseModel&&this.#expectedResponseModel)pending.responseModelSeen=true;
    if(this.#expectedResponseModel&&(reply.event==='end'||!reply.event&&reply.status===200)&&!pending.responseModelSeen)throw Error('Provider returned no frozen model identity; stop and review before resuming');
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
