import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { CaseResult } from "../domain.js";
import { renameArtifact } from "./atomic.js";

const CODE_IDENTITY_DOMAIN = "ditto-evaluation-code-v2:utf8-crlf-to-lf\0";
const CODE_TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".ps1", ".json", ".txt"]);

/** Normalize only controlled UTF-8 text; binary assets retain their exact bytes. */
async function codeIdentityBytes(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  if (!CODE_TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return bytes;
  // Fatal decoding prevents lossy replacement; ignoreBOM preserves a real BOM.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
}

/** Versioned source identity is stable under Git's CRLF-to-LF text checkout. */
export async function evaluationCodeHash(root: string): Promise<string> {
  const hash = createHash("sha256").update(CODE_IDENTITY_DOMAIN);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__") continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) { hash.update(name); hash.update(await codeIdentityBytes(join(root, name))); }
    }
  }
  await visit("src");
  await visit("scripts");
  hash.update(await codeIdentityBytes(join(root, "package-lock.json")));
  try { hash.update(await codeIdentityBytes(join(root, "requirements.txt"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { hash.update(await codeIdentityBytes(join(root, "requirements-scoring.txt"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return hash.digest("hex");
}

/** Only incomplete evaluations recover; separate successful runs stay independent. */
export class CaseRecovery {
  readonly identity: string;
  readonly priorCases: readonly CaseResult[];
  readonly originalOperations: Readonly<Record<string, unknown>>;
  readonly currentOperations: Readonly<Record<string, unknown>>;
  readonly #path: string;
  readonly #identityFields: unknown;
  readonly #cases = new Map<string, CaseResult>();
  #writes = Promise.resolve();

  private constructor(path: string, identity: string, identityFields: unknown, prior: readonly CaseResult[],
    originalOperations: Readonly<Record<string, unknown>>, currentOperations: Readonly<Record<string, unknown>>) {
    this.#path = path; this.identity = identity; this.priorCases = prior;
    this.#identityFields = identityFields;
    this.originalOperations = originalOperations;
    this.currentOperations = currentOperations;
    for (const result of prior) this.#cases.set(result.caseId, result);
  }

  static async open(root: string, identityFields: unknown, operations: Readonly<Record<string, unknown>> = {}, reuseCompleted = false): Promise<CaseRecovery> {
    const identity = createHash("sha256").update(JSON.stringify(identityFields)).digest("hex");
    await mkdir(root, { recursive: true });
    const path = join(root, `${identity}.json`);
    let prior: CaseResult[] = [];
    let originalOperations = operations;
    try {
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        identity: string; complete: boolean; cases: CaseResult[]; originalOperations?: Readonly<Record<string, unknown>>;
      };
      if (saved.identity !== identity || !Array.isArray(saved.cases)) throw new Error("Invalid case recovery identity");
      // A staged pending evaluation may have completed case persistence just
      // before its search ledger commit was interrupted. This is still the same
      // candidate, never an independent repeat. Other entry points keep the
      // historical incomplete-only behavior.
      if (!saved.complete || reuseCompleted) {
        prior = saved.cases;
        originalOperations = saved.originalOperations ?? operations;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const recovery = new CaseRecovery(path, identity, identityFields, prior, originalOperations, operations);
    await recovery.#save(false);
    return recovery;
  }

  async record(result: CaseResult): Promise<void> {
    this.#cases.set(result.caseId, result);
    await this.#save(false);
  }

  async finish(valid: boolean): Promise<void> { await this.#save(valid); }

  async #save(complete: boolean): Promise<void> {
    const content = JSON.stringify({ schemaVersion: 1, identity: this.identity, identityFields: this.#identityFields,
      originalOperations: this.originalOperations, currentOperations: this.currentOperations,
      complete, cases: [...this.#cases.values()] });
    this.#writes = this.#writes.then(async () => {
      const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${content}\n`, "utf8");
      await renameArtifact(temporary, this.#path);
    });
    await this.#writes;
  }
}

export function displayScore(valid: boolean, score: number): number | null { return valid ? score : null; }
