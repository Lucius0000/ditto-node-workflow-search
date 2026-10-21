import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CODE_SEARCH_PROTOCOL, loadOfficialSelection, runCodeSearch } from '../code-search.js';
import { buildOrganizationPlan, initialOrganization } from '../workflow/organization.js';
import {timeBudgetDecision} from '../search/time-budget.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');

test('official source cannot silently use a different Automation execution budget',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-budget-identity-'));
  try{
    const f=await fixture(root);
    const identity={...f.manifest.identity,protocol:{...CODE_SEARCH_PROTOCOL,automationExecutionBudget:{...CODE_SEARCH_PROTOCOL.automationExecutionBudget,maxActorCalls:61}}};
    await json(join(f.selectedRun,'manifest.json'),{...f.manifest,identity,identityHash:hash(JSON.stringify(identity))});
    await assert.rejects(loadOfficialSelection('humaneval',f.selectedRun,f.directory),/protocol differs/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('official freeze admits replayable time stopping, denies a forged reason or unresolved draft',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ditto-time-selection-'));
  try{
    const f=await fixture(root),state=JSON.parse(await readFile(join(f.selectedRun,'resume-state.json'),'utf8'));
    state.nodeConstruction.evaluations=state.nodeConstruction.evaluations.slice(0,3);state.completedRounds=2;
    for(const record of state.nodeConstruction.evaluations){record.evaluation.durationMs=120000;await json(join(f.selectedRun,'evaluations',record.id,'record.json'),record);}
    await json(join(f.selectedRun,'best','summary.json'),state.nodeConstruction.evaluations[0].evaluation);
    const timeBudget={deadlineAt:'2026-01-01T00:10:00Z',guardAt:'2026-01-01T00:05:00Z',minimumCandidateMs:1000,reserveMs:1000,safetyFactor:2};
    const identity={...f.manifest.identity,protocol:{...CODE_SEARCH_PROTOCOL,timeBudget}};
    const proof=timeBudgetDecision(timeBudget,[120000,120000,120000],2,Date.parse('2026-01-01T00:07:00Z'))!;
    const manifest={...f.manifest,identity,identityHash:hash(JSON.stringify(identity)),stoppedBecause:'time-budget',timeBudgetStop:proof};
    await json(join(f.selectedRun,'resume-state.json'),state);await json(join(f.selectedRun,'manifest.json'),manifest);
    await loadOfficialSelection('humaneval',f.selectedRun,f.directory);
    await json(join(f.selectedRun,'manifest.json'),{...manifest,timeBudgetStop:{...proof,estimateMs:1}});
    await assert.rejects(loadOfficialSelection('humaneval',f.selectedRun,f.directory),/replayable/);
    await json(join(f.selectedRun,'manifest.json'),{...manifest,timeBudgetStop:{...proof,checkedAt:'2026-01-01T00:01:00Z'}});
    await assert.rejects(loadOfficialSelection('humaneval',f.selectedRun,f.directory),/replayable/);
    await json(join(f.selectedRun,'manifest.json'),manifest);await json(join(f.selectedRun,'resume-state.json'),{...state,nodeConstruction:{...state.nodeConstruction,draft:{}}});
    await assert.rejects(loadOfficialSelection('humaneval',f.selectedRun,f.directory),/pending\/draft/);
  }finally{await rm(root,{recursive:true,force:true});}
});

async function fixture(root: string, name = 'search') {
  const selectedRun = join(root, name), directory = join(root, 'official');
  const plan = buildOrganizationPlan(initialOrganization('humaneval'));
  const selectedIds=Array.from({length:33},(_,i)=>`humaneval:${i}`);
  const identity = { mode: 'search', source: 'ark-plan', dataset: 'humaneval', protocol: CODE_SEARCH_PROTOCOL, codeHash: name,selectedIds };
  const manifest = { status: 'complete', identity, identityHash: hash(JSON.stringify(identity)),
    bestPlanId: plan.id, bestEvaluationId: plan.leafSearchNodeId,stoppedBecause:'converged',bestPlanSha256:hash(JSON.stringify(plan,null,2)+'\n') };
  const summary = { valid:true,score: 1,standardDeviation:0,repeatScores:[1,1,1,1,1],examples: 33, repeats: 5, successfulRuns: 165, failedRuns: 0,
    results:Array.from({length:5},(_,r)=>selectedIds.map(id=>({caseId:`${id}#${r+1}`,valid:true,score:1}))).flat() };
  const record = { id: plan.leafSearchNodeId, plan, evaluation: summary };
  await mkdir(join(selectedRun, 'best'), { recursive: true });
  await mkdir(join(selectedRun, 'evaluations', plan.leafSearchNodeId), { recursive: true });
  await mkdir(directory, { recursive: true });
  await json(join(selectedRun, 'manifest.json'), manifest);
  await json(join(selectedRun, 'best', 'plan.json'), plan);
  await json(join(selectedRun, 'best', 'summary.json'), summary);
  await json(join(selectedRun, 'evaluations', plan.leafSearchNodeId, 'record.json'), record);
  const evaluations=[record];
  for(let i=2;i<=6;i++){
    const initial=initialOrganization('humaneval');
    const child=buildOrganizationPlan({...initial,nodes:initial.nodes.map(n=>n.id==='sample-1'?{...n,config:{instruction:`Distinct candidate ${i}`}}:n)},`search-${String(i).padStart(3,'0')}`);
    const next={id:child.leafSearchNodeId,plan:child,evaluation:summary};evaluations.push(next);
    await mkdir(join(selectedRun,'evaluations',next.id),{recursive:true});
    await json(join(selectedRun,'evaluations',next.id,'record.json'),next);
  }
  await json(join(selectedRun,'resume-state.json'),{completedRounds:5,nodeConstruction:{version:2,evaluations,bestEvaluationId:record.id}});
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
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /original bytes changed/);
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
    await assert.rejects(loadOfficialSelection('humaneval', f.selectedRun, f.directory), /original bytes changed/);
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
