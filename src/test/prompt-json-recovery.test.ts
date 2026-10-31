import test from 'node:test';import assert from 'node:assert/strict';
import {parsePromptJSON,uniqueRecovery} from '../prompt-search/json-recovery.js';
import {parsePromptProposal,promptBaseline,validateTaskIdRules} from '../prompt-search/contract.js';
test('terminal recovery preserves strict JSON and only removes at most two terminal closing delimiters',()=>{
 const text=' {"text":"quoted } ]","a":[{}]} \n';assert.equal(parsePromptJSON(text).syntax.text,text);assert.equal(parsePromptJSON(text).syntax.recovered,false);
 for(const bad of ['{"a":1}}','{"a":1]}}']){const r=parsePromptJSON(bad);assert.deepEqual(r.value,{a:1});assert.equal(r.syntax.recovered,true);assert.ok(r.syntax.removed.length<=2);}
 for(const bad of ['{"a":]}','{"a":1','{}{}','{} prose','```json\n{}\n```','{"a":"ends with } ]"','{} } } }','{"a":1}}}}'])assert.throws(()=>parsePromptJSON(bad),bad);
 assert.throws(()=>uniqueRecovery(new Map([['{}',{}],['[]',[]]])),/exactly one/);
});
test('recovery retains full scope and task-ID checks',()=>{
 const p=promptBaseline('drop'),child=structuredClone(p);child.graphs[0]!.nodes[1]!.config.instruction='Reusable strategy';
 const raw=JSON.stringify({rationale:'test',definition:child})+'}';const r=parsePromptProposal(raw,p,'drop');assert.deepEqual(r.definition,child);
 child.output={nodeId:'bad',view:'answer'};assert.throws(()=>parsePromptProposal(JSON.stringify({rationale:'test',definition:child})+'}',p,'drop'));
 child.output=p.output;child.graphs[0]!.nodes[1]!.config.instruction='If drop:0 then return 2';const id=parsePromptProposal(JSON.stringify({rationale:'test',definition:child})+'}',p,'drop');assert.throws(()=>validateTaskIdRules(id.definition,'drop',['drop:0']));
});
