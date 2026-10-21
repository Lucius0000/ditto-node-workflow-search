import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODE_SEARCH_PROTOCOL, loadOfficialSelection, runCodeSearch } from '../code-search.js';
import { buildOrganizationPlan, initialOrganization } from '../workflow/organization.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');

async function fixture(root: string, name = 'search') {
  const selectedRun = join(root, name), directory = join(root, 'official');
  const plan = buildOrganizationPlan(initialOrganization('humaneval'));
  const identity = { mode: 'search', source: 'ark-plan', dataset: 'humaneval', protocol: CODE_SEARCH_PROTOCOL, codeHash: name };
  const manifest = { status: 'complete', identity, identityHash: hash(JSON.stringify(identity)),
    bestPlanId: plan.id, bestEvaluationId: plan.leafSearchNodeId };
  const summary = { score: 1, examples: 1, repeats: 1, successfulRuns: 1, failedRuns: 0, results: [] };
  const record = { id: plan.leafSearchNodeId, plan, evaluation: summary };
  await mkdir(join(selectedRun, 'best'), { recursive: true });
  await mkdir(join(selectedRun, 'evaluations', plan.leafSearchNodeId), { recursive: true });
  await mkdir(directory, { recursive: true });
  await json(join(selectedRun, 'manifest.json'), manifest);
  await json(join(selectedRun, 'best', 'plan.json'), plan);
  await json(join(selectedRun, 'best', 'summary.json'), summary);
  await json(join(selectedRun, 'evaluations', plan.leafSearchNodeId, 'record.json'), record);
  return { selectedRun, directory, plan, manifest, record };
}

test('official selection binds the completed Search identity and exact frozen bytes; same choice resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ditto-official-selection-'));
  try {
    const f = await fixture(root);
    const selection = await loadOfficialSelection('humaneval', f.selectedRun, f.directory);
    assert.deepEqual(selection.plan, f.plan);
    assert.equal(selection.identity.selectedIdentityHash, f.manifest.identityHash);
    assert.equal(selection.identity.planSha256, hash(await readFile(join(f.selectedRun, 'best', 'plan.json'))));
    for (const status of ['running', 'complete']) {
      const prior = { status, identity: { officialSelection: selection.identity } };
      await json(join(f.directory, 'manifest.json'), prior);
      assert.deepEqual(await loadOfficialSelection('humaneval', f.selectedRun, f.directory), selection);
      assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8')), prior);
    }
    // Semantically identical JSON with different bytes is a different frozen artifact.
    await writeFile(join(f.selectedRun, 'best', 'plan.json'), JSON.stringify(f.plan), 'utf8');
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /Run identity changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completed official run rejects a different valid Search selection before external setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ditto-official-selection-'));
  try {
    const first = await fixture(root);
    const selected = await loadOfficialSelection('humaneval', first.selectedRun, first.directory);
    await json(join(first.directory, 'manifest.json'), { status: 'complete', identity: { officialSelection: selected.identity } });
    const second = await fixture(root, 'other-search');
    await assert.rejects(runCodeSearch({ dataset: 'humaneval', mode: 'official', directory: first.directory,
      selectedRun: second.selectedRun, dataDir: 'unused-data', dockerImage: 'unused-image' }), /Run identity changed/);
    // Historical unbound completed directories must not bypass the selection gate.
    await json(join(first.directory, 'manifest.json'), { status: 'complete', identity: {} });
    await assert.rejects(loadOfficialSelection('humaneval', first.selectedRun, first.directory), /Run identity changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official selection rejects missing, invalid, mismatched and unevaluated frozen selections offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ditto-official-selection-'));
  try {
    const options = { dataset: 'humaneval' as const, mode: 'official' as const, directory: join(root, 'official'),
      dataDir: 'unused-data', dockerImage: 'unused-image' };
    await assert.rejects(runCodeSearch(options), /needs the frozen Search directory/);
    await assert.rejects(runCodeSearch({ ...options, selectedRun: join(root, 'missing') }), /ENOENT/);
    for (const change of [
      { status: 'interrupted' },
      { identity: { mode: 'official', source: 'ark-plan', dataset: 'humaneval' } },
      { identity: { mode: 'search', source: 'official', dataset: 'humaneval' } },
      { identity: { mode: 'search', source: 'ark-plan', dataset: 'mbpp' } },
      { identity: { mode: 'search', source: 'ark-plan', dataset: 'humaneval', protocol: { ...CODE_SEARCH_PROTOCOL, id: 'old-protocol' } } },
      { identityHash: 'not-a-hash' },
    ]) {
      const f = await fixture(root);
      const manifest = { ...f.manifest, ...change };
      if (!('identityHash' in change)) manifest.identityHash = hash(JSON.stringify(manifest.identity));
      await json(join(f.selectedRun, 'manifest.json'), manifest);
      await assert.rejects(runCodeSearch({ ...options, selectedRun: f.selectedRun }), /completed matching Ark Search/);
    }
    let f = await fixture(root);
    await json(join(f.selectedRun, 'best', 'plan.json'), { ...f.plan, outputNodeId: 'missing' });
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /Plan differs/);
    f = await fixture(root);
    await json(join(f.selectedRun, 'manifest.json'), { ...f.manifest, bestEvaluationId: 'search-002' });
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /best identity/);
    f = await fixture(root);
    await json(join(f.selectedRun, 'evaluations', f.plan.leafSearchNodeId, 'record.json'),
      { ...f.record, plan: { ...f.plan, outputNodeId: 'different' } });
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /selected Search evaluation/);
    f = await fixture(root);
    await json(join(f.selectedRun, 'best', 'summary.json'), { ...f.record.evaluation, failedRuns: 1 });
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /Invalid evaluation/);
    f = await fixture(root);
    await rm(join(f.selectedRun, 'evaluations', f.plan.leafSearchNodeId, 'record.json'));
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
