import { parentPort, workerData } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';
import { CODING_EXECUTION_POLICY } from './policy.js';

// Only JSON data enters this VM; no application API or host callback is exposed.
try {
  const data = workerData as { source: string; args: unknown };
  const source = /^(?:async\s+)?[a-zA-Z_$][\w$]*\s*\(/.test(data.source) && !/^function\b/.test(data.source)
    ? `function ${data.source}` : data.source;
  const result = runInNewContext(`JSON.stringify((${source})(JSON.parse(argsJson)))`,
    { argsJson: JSON.stringify(data.args), Date: undefined, process: undefined, fetch: undefined },
    { timeout: CODING_EXECUTION_POLICY.toolVmMs, contextCodeGeneration: { strings: false, wasm: false } });
  if (typeof result !== 'string' || result.length > CODING_EXECUTION_POLICY.maxToolOutputCharacters) throw Error('Tool must return at most 65536 characters of JSON');
  parentPort!.postMessage({ ok: true, value: JSON.parse(result) });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
