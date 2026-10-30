import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CodeJudge, CodeJudgeRequest, CodeJudgeResult } from "./types.js";

const execFileAsync = promisify(execFile);
class CandidateOutputLimit extends Error {}

export interface DockerPythonJudgeOptions {
  /** Must be reviewed and pre-pulled; the judge never pulls during evaluation. */
  readonly image?: string;
  readonly timeoutMs?: number;
  /** Generated-program deadline inside the container; excludes Docker startup. */
  readonly programTimeoutMs?: number;
  readonly memory?: string;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  readonly outputLimitBytes?: number;
}

/**
 * Runs generated Python with no host mounts, network, credentials, or host
 * fallback. Docker availability is an explicit prerequisite, not something
 * silently bypassed with local exec.
 */
export class DockerPythonJudge implements CodeJudge {
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly programTimeoutMs: number;
  private readonly memory: string;
  private readonly cpus: number;
  private readonly pidsLimit: number;
  private readonly outputLimitBytes: number;

  constructor(options: DockerPythonJudgeOptions = {}) {
    this.image = options.image ?? process.env.CODE_JUDGE_IMAGE ?? "python:3.13-slim";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.programTimeoutMs = options.programTimeoutMs ?? 12_000;
    if (![this.timeoutMs, this.programTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) throw new Error("Invalid Python judge deadline");
    this.memory = options.memory ?? "256m";
    this.cpus = options.cpus ?? 1;
    this.pidsLimit = options.pidsLimit ?? 64;
    this.outputLimitBytes = options.outputLimitBytes ?? 64 * 1024;
  }

  /** Fail before an expensive search if Docker or the explicitly selected image is unavailable. */
  async preflight(): Promise<void> {
    try {
      await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        env: dockerClientEnvironment(),
        timeout: 5_000,
        windowsHide: true,
      });
      await execFileAsync("docker", ["image", "inspect", this.image], {
        env: dockerClientEnvironment(),
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Docker judge is not ready for image ${this.image}: ${message}`, { cause: error });
    }
  }

  async judge(request: CodeJudgeRequest, signal?: AbortSignal): Promise<CodeJudgeResult> {
    signal?.throwIfAborted();
    const started = Date.now();
    const name = `ditto-python-${randomUUID()}`;
    const passMarker = `DITTO_PASS_${randomUUID()}`;
    const startedMarker = `DITTO_STARTED_${randomUUID()}`;
    const script = buildHarness(request, passMarker);
    // A trusted parent supervises only the generated Python process. The host
    // watchdog remains an infrastructure error, even after startup succeeds.
    const supervisor = [
      "import subprocess, sys",
      "source = sys.stdin.read()",
      `print(${JSON.stringify(startedMarker)}, flush=True)`,
      "try:",
      `    result = subprocess.run([sys.executable, '-I', '-B', '-'], input=source.encode('utf-8'), timeout=${this.programTimeoutMs / 1000})`,
      "    sys.exit(0 if result.returncode == 0 else 1)",
      "except subprocess.TimeoutExpired:",
      "    print('Python program deadline exhausted', file=sys.stderr, flush=True)",
      "    sys.exit(124)",
    ].join("\n");
    const args = [
      "run", "--rm", "--init", "--pull=never", "--name", name,
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", String(this.pidsLimit),
      "--memory", this.memory,
      "--memory-swap", this.memory,
      "--cpus", String(this.cpus),
      "--ulimit", "nofile=64:64",
      "--ulimit", "nproc=32:32",
      "--user", "65534:65534",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--workdir", "/tmp",
      "--env", "HOME=/tmp",
      "--stop-timeout", "1",
      "-i", this.image,
      "python", "-I", "-B", "-c", supervisor,
    ];

    try {
      const execution = await runDocker(args, script, name, startedMarker, this.timeoutMs, this.outputLimitBytes, signal);
      if (!execution.stdout.startsWith(`${startedMarker}\n`) || [125, 126, 127].includes(execution.exitCode)) {
        throw new Error(`Docker judge infrastructure failed: ${compactDiagnostics(execution.stdout, execution.stderr, false)}`);
      }
      const passed = execution.exitCode === 0 && execution.stdout.trimEnd().endsWith(passMarker);
      return Object.freeze({
        passed,
        diagnostics: `exit=${execution.exitCode}; ${compactDiagnostics(execution.stdout.replace(`${startedMarker}\n`, "").replace(passMarker, ""), execution.stderr, passed)}`,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (error instanceof CandidateOutputLimit) return Object.freeze({ passed: false, diagnostics: error.message, durationMs: Date.now() - started });
      throw error;
    } finally {
      await removeContainer(name);
    }
  }
}

interface DockerExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runDocker(
  args: readonly string[],
  stdin: string,
  containerName: string,
  startedMarker: string,
  timeoutMs: number,
  outputLimitBytes: number,
  signal?: AbortSignal,
): Promise<DockerExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: dockerClientEnvironment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    let settled = false;

    const stop = (error: Error): void => {
      if (failure) return;
      failure = Object.assign(error, { programStarted: stdout.startsWith(`${startedMarker}\n`) });
      child.kill("SIGKILL");
      void removeContainer(containerName);
    };
    const cancel = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error("Python evaluation cancelled"));
    const timer = setTimeout(() => stop(new Error(`Docker judge host supervision timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > outputLimitBytes) stop(stdout.startsWith(`${startedMarker}\n`) ? new CandidateOutputLimit("Python stdout exceeded its limit") : new Error("Docker judge startup stdout exceeded its limit"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > outputLimitBytes) stop(stdout.startsWith(`${startedMarker}\n`) ? new CandidateOutputLimit("Python stderr exceeded its limit") : new Error("Docker judge startup stderr exceeded its limit"));
    });
    child.once("error", (error) => finish(() => reject(new Error(`Unable to start Docker: ${error.message}`, { cause: error }))));
    child.once("close", (code) => finish(() => failure ? reject(failure) : resolve({ exitCode: code ?? 125, stdout, stderr })));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      action();
    }
  });
}

async function removeContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", name], {
    env: dockerClientEnvironment(),
    timeout: 5_000,
    windowsHide: true,
  }).catch(() => undefined);
}

function dockerClientEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

function buildHarness(request: CodeJudgeRequest, passMarker: string): string {
  const imports = request.testImports.join("\n");
  const invocation = request.dataset === "humaneval" ? `check(${request.entryPoint})` : "check()";
  return [
    "from typing import *",
    "import collections, functools, hashlib, heapq, itertools, math, operator, random, re, statistics, string",
    humanEvalSupport(request.dataset, request.entryPoint),
    request.candidate,
    imports,
    request.testSource,
    `assert callable(${request.entryPoint}), ${JSON.stringify(`Entry point ${request.entryPoint} is not callable`)}`,
    invocation,
    `print(${JSON.stringify(passMarker)})`,
    "",
  ].filter(Boolean).join("\n\n");
}

function humanEvalSupport(dataset: "humaneval" | "mbpp", entryPoint: string): string {
  if (dataset !== "humaneval") return "";
  if (entryPoint === "decode_cyclic") {
    return `def encode_cyclic(s: str):\n    groups = [s[3*i:min(3*i+3, len(s))] for i in range((len(s)+2)//3)]\n    return \"\".join((g[1:]+g[0]) if len(g) == 3 else g for g in groups)`;
  }
  if (entryPoint === "decode_shift") {
    return `def encode_shift(s: str):\n    return \"\".join(chr(((ord(ch)+5-ord(\"a\"))%26)+ord(\"a\")) for ch in s)`;
  }
  if (entryPoint === "find_zero") return "def poly(xs: list, x: float):\n    return sum(coeff * (x ** i) for i, coeff in enumerate(xs))";
  return "";
}

function compactDiagnostics(stdout: string, stderr: string, passed: boolean): string {
  const cleanedOut = stdout.trim();
  const combined = [cleanedOut, stderr.trim()].filter(Boolean).join("\n");
  if (!combined) return passed ? "private tests passed" : "private tests failed without diagnostics";
  return combined.slice(-4_000);
}

export function extractPythonCandidate(modelOutput: string, publicPrompt: string, entryPoint: string): string {
  const fences = [...modelOutput.matchAll(/```(?:python|py)?[^\S\r\n]*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]!.trimEnd());
  const fencedWithEntry = fences.find((candidate) => containsEntryPoint(candidate, entryPoint));
  const extracted = fencedWithEntry ? fences.join("\n\n") : fences.sort((left, right) => right.length - left.length)[0] ?? stripPlainLanguagePrefix(modelOutput);
  if (containsEntryPoint(extracted, entryPoint)) {
    // Public imports and helpers precede HumanEval's incomplete entry point.
    const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const signature = new RegExp(`^(?:async\\s+)?def\\s+${escaped}\\s*\\(`, "m").exec(publicPrompt);
    const preamble = signature ? publicPrompt.slice(0, signature.index).trimEnd() : "";
    return preamble && !extracted.startsWith(preamble) ? `${preamble}\n\n${extracted}` : extracted;
  }
  const lines = extracted.split(/\r?\n/);
  const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)![0].length);
  const commonIndent = indents.length ? Math.min(...indents) : 0;
  const body = lines.map((line) => line.trim() ? `    ${line.slice(commonIndent)}` : "").join("\n");
  return `${publicPrompt.trimEnd()}\n${body}`;
}

function stripPlainLanguagePrefix(output: string): string {
  const lines = output.replace(/^\s*\r?\n/, "").trimEnd().split(/\r?\n/);
  const firstCodeLine = lines.findIndex((line) => /^\s*(?:@|from\s+\S+\s+import\s+|import\s+|(?:async\s+)?def\s+|class\s+)/.test(line));
  return (firstCodeLine < 0 ? lines : lines.slice(firstCodeLine)).join("\n").trimEnd();
}

function containsEntryPoint(source: string, entryPoint: string): boolean {
  const escaped = entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${escaped}\\s*\\(`, "m").test(source);
}
