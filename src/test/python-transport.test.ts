import assert from "node:assert/strict";
import test from "node:test";
import { createHttpProvider, type SampleInput } from "@codesoul-co/ditto/worker/infer";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { PythonTransport } from "../ditto/python-transport.js";
import { GENERATION } from "../protocol.js";

const settings = { baseUrl: "https://example.invalid", model: "fixture", apiKey: "offline-fixture", concurrency: 1, timeoutMs: 600_000 };
const input: SampleInput = { model: { model: "fixture" }, messages: [{ role: "user", content: "fixture" }], generation: GENERATION };
const callOptions = { signal: new AbortController().signal };

// This subprocess exercises the real JSONL transport and npm SSE parser offline.
const fixtureProcess = String.raw`
import { createInterface } from 'node:readline';
const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
const cancelled = [];
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.cancel !== undefined) { cancelled.push(request.cancel); return; }
  const { id, body } = request;
  if (body.mode === 'inspect') { emit({ id, status: 200, body: { cancelled } }); return; }
  if (body.mode === 'pending') return;
  emit({ id, status: 200, event: 'start' });
  if (body.mode === 'crash') { process.exit(7); return; }
  if (body.mode === 'error') { emit({ id, status: 599, event: 'error', body: { error: { type: 'FixtureError' } } }); return; }
  if (body.mode === 'wait') { emit({ id, event: 'chunk', body: { choices: [{ delta: { content: 'partial' } }] } }); return; }
  emit({ id, event: 'chunk', body: { choices: [{ index: 0, delta: { content: 'read ', reasoning_content: 'fixture reasoning', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] } }] } });
  emit({ id, event: 'chunk', body: { choices: [{ index: 0, delta: { content: 'file', tool_calls: [{ index: 0, function: { name: 'file', arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] } });
  emit({ id, event: 'chunk', body: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } } } });
  emit({ id, event: 'end' });
});`;

function fixtureTransport(): PythonTransport {
  return new PythonTransport(settings, { profile: "math", command: process.execPath, arguments: ["--input-type=module", "-e", fixtureProcess] });
}

test("JSONL transport streams real SSE with text, split tool calls, finish reason and trailing usage", async () => {
  const transport = fixtureTransport();
  try {
    const provider = createHttpProvider({ kind: "openai-compatible", baseUrl: settings.baseUrl,
      sandbox: new Sandbox(process.cwd(), { network: [settings.baseUrl] }), fetch: transport.fetch });
    const events = [];
    for await (const event of provider.stream!(input, callOptions)) events.push(event);
    assert.deepEqual(events.filter(event => event.type === "text_delta").map(event => event.delta), ["read ", "file"]);
    const result = events.find(event => event.type === "result");
    assert.ok(result?.type === "result");
    assert.equal(result.output.finishReason, "action_request");
    assert.deepEqual(result.output.actionRequests, [{ id: "call-1", name: "read_file", arguments: { path: "x" } }]);
    assert.deepEqual(result.output.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 1 });
    assert.equal(result.output.message.metadata?.reasoningContent, "fixture reasoning");
  } finally { await transport.close(); }
});

test("JSONL transport cancels pending and active streams and propagates bridge errors", async () => {
  const transport = fixtureTransport();
  const send = (mode: string, signal?: AbortSignal): Promise<Response> => transport.fetch(settings.baseUrl, {
    body: JSON.stringify({ mode }), ...(signal ? { signal } : {}),
  });
  try {
    const controller = new AbortController();
    const pending = send("pending", controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    const active = new AbortController();
    const stream = await send("wait", active.signal);
    const reader = stream.body!.getReader();
    await reader.read();
    const next = reader.read();
    active.abort();
    await assert.rejects(next, /cancelled/);
    const error = await send("error");
    await assert.rejects(error.text(), /failed/);
    const inspection = await (await send("inspect")).json() as { cancelled: number[] };
    assert.deepEqual(inspection.cancelled, [1, 2]);
    const closing = await send("wait");
    const closingText = closing.text();
    const closeError = assert.rejects(closingText, /closed/);
    await transport.close();
    await closeError;
  } finally { await transport.close(); }
});

test("JSONL transport propagates subprocess exit to an active streamed response", async () => {
  const transport = fixtureTransport();
  try {
    const response = await transport.fetch(settings.baseUrl, { body: JSON.stringify({ mode: "crash" }) });
    await assert.rejects(response.text(), /exited \(7\)/);
  } finally { await transport.close(); }
});

test('locked response model rejects changed or missing identities before accepting a complete output',async()=>{
  for(const model of ['expected','changed',undefined]){
    const script=`import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const {id}=JSON.parse(line);process.stdout.write(JSON.stringify({id,status:200,body:{${model===undefined?'':`model:${JSON.stringify(model)},`}choices:[]}})+'\\n');});`;
    const transport=new PythonTransport({...settings,expectedResponseModel:'expected'},{command:process.execPath,arguments:['--input-type=module','-e',script]});
    try{
      const pending=transport.fetch(settings.baseUrl,{body:'{}'});
      if(model==='expected')assert.equal((await pending).status,200);
      else await assert.rejects(pending,/frozen model identity/);
    }finally{await transport.close();}
  }
});
