import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {automationAdapter,automationSplitProtocol} from './automation.js';

test('balanced Automation public split loads full disjoint 200/600 with preserved family membership',async()=>{
  const dataDir=new URL('../../protocols/automationbench-balanced-public-v2/',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const search=await automationAdapter.load({dataDir:fileURLToPath(dataDir),split:'validate'});
  const heldout=await automationAdapter.load({dataDir:fileURLToPath(dataDir),split:'test'});
  assert.equal(search.tasks.length,200);assert.equal(heldout.tasks.length,600);
  assert.equal(search.identity?.protocol,'automationbench-balanced-public-v2');
  const searchIds=new Set(search.tasks.map(t=>t.id));
  assert.equal(heldout.tasks.filter(t=>searchIds.has(t.id)).length,0);
  const labels=JSON.parse(await readFile(new URL('annotations.json',dataDir),'utf8')) as Record<string,{domain:string;family:string}>;
  const familySplits=new Map<string,boolean>();
  for(const [id,label] of Object.entries(labels)){
    const selected=searchIds.has(id);
    if(familySplits.has(label.family))assert.equal(selected,familySplits.get(label.family));
    familySplits.set(label.family,selected);
  }
  for(const domain of ['simple','sales','marketing','operations','support','finance','hr']){
    assert.equal(search.tasks.filter(t=>labels[t.id]?.domain===domain).length,domain==='simple'?50:25);
    assert.equal(heldout.tasks.filter(t=>labels[t.id]?.domain===domain).length,domain==='simple'?150:75);
  }
  const bytes=await readFile(new URL('search.jsonl',dataDir));
  assert.throws(()=>automationSplitProtocol(createHash('sha256').update(Buffer.concat([bytes,Buffer.from(' ')])).digest('hex'),'validate'),/pinned/);
  assert.throws(()=>automationSplitProtocol(search.identity!.rawSha256,'test'),/pinned/);
  assert.equal(automationSplitProtocol('926b0d17a075f71a4851f505bc23c02fb982bb6e01e12506db8a605f40033354','validate'),'automationbench-public-simple-v1');
});
