import assert from 'node:assert/strict';
import test from 'node:test';
import { accountQuery } from '../unified/ark-account.js';

const alias = 'OFFLINE_QUOTA_TEST';
const keys = [`ARK_AUDIT_ACCESS_KEY_ID_${alias}`, `ARK_AUDIT_SECRET_ACCESS_KEY_${alias}`];
function credentials() {
  const old = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'offline-signing-fixture'; });
  return () => keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
}
const response = (code?: string) => new Response(JSON.stringify(code
  ? { ResponseMetadata: { Error: { Code: code, Message: 'offline fixture' } } }
  : { Result: { Status: 'Running' } }), { status: 200 });

test('concurrent quota refreshes share each read-only account query, then expire', async t => {
  const restore = credentials(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return response(); });
  try {
    await Promise.all(Array.from({ length: 18 }, () => Promise.all([
      accountQuery('GetPersonalPlan', alias), accountQuery('GetAFPUsage', alias),
    ])));
    assert.equal(calls, 2);
    await accountQuery('GetAFPUsage', alias);
    assert.equal(calls, 3, 'settled queries cannot become stale persistent quota caches');
  } finally { restore(); }
});

test('control-plane rate limits retry within one shared three-attempt query', async t => {
  const restore = credentials(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => response(++calls < 3 ? 'AccountFlowLimitExceeded' : undefined));
  try {
    const results = await Promise.all(Array.from({ length: 18 }, () => accountQuery('GetAFPUsage', alias)));
    assert.equal(calls, 3); assert.ok(results.every(result => result.Status === 'Running'));
  } finally { restore(); }
});

test('persistent control-plane throttling stops after three attempts; permissions never retry', async t => {
  const restore = credentials(); let calls = 0, code = 'AccountFlowLimitExceeded';
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(code); });
  try {
    await assert.rejects(accountQuery('GetAFPUsage', alias), /AccountFlowLimitExceeded/);
    assert.equal(calls, 3);
    calls = 0; code = 'AccessDenied';
    await assert.rejects(accountQuery('GetAFPUsage', alias), /AccessDenied/);
    assert.equal(calls, 1);
  } finally { restore(); }
});
