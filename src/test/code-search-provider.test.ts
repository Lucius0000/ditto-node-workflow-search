import test from 'node:test';
import assert from 'node:assert/strict';
import { codeSearchProvider } from '../code-search-provider.js';

test('code-run sources have separate exact identities and delivery defaults are official', () => {
  const env = { DS_API_KEY: 'official-fixture', ARK_PLAN_KEY_LIU: 'plan-fixture' };
  assert.equal(codeSearchProvider('official', env).baseUrl, 'https://api.deepseek.com');
  assert.equal(codeSearchProvider('official', env).apiKey, 'official-fixture');
  assert.equal(codeSearchProvider('ark-plan', env).baseUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3');
  assert.equal(codeSearchProvider('ark-plan', env).model, 'deepseek-v4.1-flash');
  assert.equal(codeSearchProvider('ark-plan', env).apiKey, 'plan-fixture');
  assert.throws(() => codeSearchProvider('ark-plan', {}), /ARK_PLAN_KEY_LIU/);
  assert.throws(() => codeSearchProvider('official', { ...env, CODE_SOUL_CONCURRENCY: '0' }), /concurrency/);
  assert.throws(() => codeSearchProvider('official', { ...env, CODE_SOUL_TIMEOUT_MS: '0' }), /deadline/);
});
