import assert from "node:assert/strict";
import test from "node:test";
import {AutomationBridge,OfficialAutomationSession,automationScope,automationAdapter} from "./automation.js";
import {automationBaseline} from '../graph-agent/automation-baseline.js';
import {runGraphAgent} from '../graph-agent/executor.js';
import {createExperimentRuntime} from '../ditto/runtime.js';
import {withWorkflowTimeBudget} from '../execution/time-budget.js';
const native=Boolean(process.env.DITTO_AUTOMATION_PYTHON && process.env.DITTO_AUTOMATION_ROOT && process.env.DITTO_AUTOMATION_DATA);

test('B Automation decisions consume actual official observations and mutate only their own world', {skip:!native},async()=>{
 const bridge=await AutomationBridge.open();
 const settings={baseUrl:'https://offline.invalid',apiKey:'offline',model:'fixture',concurrency:1,timeoutMs:3000};
 const calls:any[]=[];
 const experiment=createExperimentRuntime(settings,{provider:{async invoke(input){
  calls.push(input);
  const message=calls.length===1?{done:false,tool:'api_search',arguments:{query:'salesforce contacts update',top_k:1}}:
   calls.length===2?{done:false,tool:'api_fetch',arguments:{method:'PATCH',url:'https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001',params:null,body:JSON.stringify({Phone:'+1-555-0101'})}}:{done:true,tool:'',arguments:{}};
  return{message:{role:'assistant',content:JSON.stringify(message)},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
 }}});
 const changed=await bridge.start('simple.email_sf_contact_phone_update'),untouched=await bridge.start('simple.email_sf_contact_phone_update');
 try{
  const task={id:'automationbench:simple.email_sf_contact_phone_update',dataset:'automationbench' as const,prompt:'Update the contact phone from the public message.',outputInstruction:'',metadata:{}};
  const result=await automationScope.run(changed,()=>withWorkflowTimeBudget({requestMs:3000,workflowMs:30000},()=>runGraphAgent(automationBaseline(10),task,experiment,settings)));
  assert.equal(result.executionBudget,undefined);assert.equal(calls.length,3);
  assert.deepEqual(result.executedNodeIds,['decide','call-0','observe-0','decide','call-1','observe-1','decide']);
  assert.ok(calls[1].messages.some((m:any)=>String(m.content).includes('salesforce')),'actual search observation reaches the next inference');
  assert.equal((result.state.history as any[]).length,2);
  assert.equal((await changed.grade(await changed.snapshot())).score,1);
  assert.equal((await untouched.grade(await untouched.snapshot())).score,0);
  assert.equal(changed.trace.filter(row=>row.type==='tool-call').length,2,'no hidden action suffix');
 }finally{await changed.close();await untouched.close();await bridge.close();await experiment.close();}
});

test('Automation adapter verifies the full Search and grades textual completion against unchanged world', {skip:!native},async()=>{
 const loaded=await automationAdapter.load({dataDir:process.env.DITTO_AUTOMATION_DATA!,split:'validate'});
 assert.equal(loaded.tasks.length,200);assert.equal(loaded.identity?.verified,true);
 assert.doesNotMatch(JSON.stringify(loaded.tasks),/task_contract|assertions|"world"/);
 let attempts=0,prior:unknown;
 const ids=[loaded.tasks[0]!.id];
 const result=await loaded.evaluateSearchSubset!(ids,async()=>{
  const session=automationScope.getStore();assert.ok(session);assert.notEqual(prior,session);prior=session;
  if(++attempts===1)throw Error('Model provider HTTP 503 deterministic fault');
  return{answer:'The task is complete.',executedNodeIds:[],executedGraphIds:[],inputTokens:0,outputTokens:0,totalTokens:0};
 },{repeats:2,retryAttempts:2,concurrency:1});
 assert.equal(attempts,3);assert.equal(result.valid,true);assert.ok(result.results.every(row=>row.score===0));
 assert.equal(automationScope.getStore(),undefined);
 assert.throws(()=>loaded.evaluateSearchSubset!(['automationbench:unknown'],async()=>{throw Error('must not run');}),/Unknown search task/);
});

test('read-only SOQL parser depth error remains a correctable observation in the unchanged world', {skip:!native},async()=>{
  const bridge=await AutomationBridge.open();
  try{
    const session=await bridge.start('simple.email_sf_contact_account_update');
    try{
      const before=await session.snapshot();
      const q="SELECT Id, Name FROM Account WHERE "+Array.from({length:1000},(_,i)=>`Id = '001${String(i).padStart(3,'0')}'`).join(' OR ');
      const args={method:'GET',url:'https://yourinstance.salesforce.com/services/data/v61.0/query',params:JSON.stringify({q}),body:'null'};
      assert.match((await session.call('api_fetch',args)).content,/MALFORMED_QUERY.*deeply nested/);
      session.assertHealthy();assert.deepEqual(await session.snapshot(),before);
      const corrected=await session.call('api_fetch',{...args,params:JSON.stringify({q:"SELECT Id, Name FROM Account WHERE Id = '001005'"})});
      assert.doesNotMatch(corrected.content,/MALFORMED_QUERY|maximum recursion/);assert.deepEqual(await session.snapshot(),before);
    }finally{await session.close();}
    const closed=await bridge.start('simple.email_sf_contact_account_update');await closed.close();
    await assert.rejects(closed.call('api_fetch',{method:'GET',url:'https://yourinstance.salesforce.com/services/data/v61.0/query',params:'{}',body:'null'}),/closed|Start a task/i);
  }finally{await bridge.close();}
});

test("argument mistakes remain observations while broken environment state invalidates the session", async () => {
  const broken = new OfficialAutomationSession({ assertHealthy() {}, async request() { throw new Error("offline broken bridge"); } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  const result = await broken.call("api_fetch", { method: 7 });
  assert.match(result.content, /INVALID_TOOL_ARGUMENTS/);
  broken.assertHealthy();
  assert.equal(broken.trace.length, 1);
  await assert.rejects(broken.call("base64_encode", { text: "hello" }), /offline broken bridge/);
  assert.throws(() => broken.assertHealthy(), /offline broken bridge/);
  await assert.rejects(broken.grade({ contract: "a".repeat(64), world: undefined } as never), /saved world/);
});

test("JSON-null query strings are repairable tool observations without swallowing bridge faults", async () => {
  const calls: Record<string, unknown>[] = [];
  const session = new OfficialAutomationSession({ assertHealthy() {}, async request(value: Record<string, unknown>) { calls.push(value); return { content: "official response" }; } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  for (const params of ["null", "[]", "3", "true"]) {
    const response = await session.call("api_fetch", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", params, body: null });
    assert.match(response.content, /INVALID_TOOL_ARGUMENTS/);
    session.assertHealthy();
  }
  assert.equal(calls.length, 0, "non-object JSON query params never reach the official router's **params");
  for (const params of [null, "{}", '{"format":"full"}', {}, ""]) {
    const response = await session.call("api_fetch", { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", params, body: null });
    assert.equal(response.content, "official response");
  }
  assert.equal(calls.length, 5);
  assert.equal(session.trace.filter((entry) => entry.argumentError).length, 4);
});

test("the observed Gmail params mistake can be corrected in the same official world", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const session = await bridge.start("simple.email_sf_contact_account_update");
    try {
      const args = { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/msg_3005", body: null };
      assert.match((await session.call("api_fetch", { ...args, params: "null" })).content, /INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();
      const corrected = await session.call("api_fetch", { ...args, params: null });
      assert.equal(typeof corrected.content, "string");
      assert.doesNotMatch(corrected.content, /argument after \*\*/);
      session.assertHealthy();
    } finally { await session.close(); }
  } finally { await bridge.close(); }
});

test("duplicate query/body fields yield observations while corrected calls still surface real bridge faults", async () => {
  let calls = 0;
  const session = new OfficialAutomationSession({ assertHealthy() {}, async request() { calls++; throw new Error("offline genuine environment fault"); } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  const args = { method: "POST", url: "https://api.trello.com/1/cards/card/idLabels", params: '{"value":"label_urgent"}', body: '{"value":"label_urgent"}' };
  const result = await session.call("api_fetch", args);
  assert.match(result.content, /INVALID_TOOL_ARGUMENTS/);
  assert.match(result.content, /both params and body: value/);
  session.assertHealthy();
  assert.equal(calls, 0);
  assert.deepEqual(session.trace[0]?.arguments, args, "retain the original duplicate fields rather than silently choosing one");
  await assert.rejects(session.call("api_fetch", { ...args, body: null }), /genuine environment fault/);
  assert.equal(calls, 1);
  assert.throws(() => session.assertHealthy(), /genuine environment fault/);
});

test('Trello scalar label bodies remain repairable observations; a real bridge failure still invalidates',async()=>{
  let calls=0;
  const session=new OfficialAutomationSession({assertHealthy(){},async request(){calls++;throw Error('real bridge failure');}} as unknown as AutomationBridge,'fixture','fixture','a'.repeat(64),[]);
  const args={method:'POST',url:'https://api.trello.com/1/cards/card/idLabels',params:'{}'};
  for(const body of ['"label_urgent"','[]','3','true','null']){
    assert.match((await session.call('api_fetch',{...args,body})).content,/INVALID_TOOL_ARGUMENTS/);
    session.assertHealthy();
  }
  assert.equal(calls,0);
  await assert.rejects(session.call('api_fetch',{...args,body:'{"value":"label_urgent"}'}),/real bridge failure/);
  assert.equal(calls,1);assert.throws(()=>session.assertHealthy(),/real bridge failure/);
});

test('the observed scalar Trello body can be corrected without poisoning its official world',{skip:!native},async()=>{
  const bridge=await AutomationBridge.open();
  try{
    const session=await bridge.start('simple.trello_urgent_support_card');
    try{
      const created=JSON.parse((await session.call('api_fetch',{method:'POST',url:'https://api.trello.com/1/cards',params:null,body:JSON.stringify({idList:'lst_support_todo',idBoard:'brd_support',name:'Scalar-body regression fixture'})})).content) as {id:string};
      const args={method:'POST',url:`https://api.trello.com/1/cards/${created.id}/idLabels`,params:'{}'};
      const before=await session.snapshot();
      assert.match((await session.call('api_fetch',{...args,body:'"label_urgent"'})).content,/INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();assert.deepEqual(await session.snapshot(),before);
      assert.equal((await session.grade(await session.snapshot())).score,0,'bad arguments leave the unfinished task normally gradeable');
      const corrected=JSON.parse((await session.call('api_fetch',{...args,body:'{"value":"label_urgent"}'})).content) as unknown[];
      assert.ok(Array.isArray(corrected)&&corrected.length>0);session.assertHealthy();
      assert.notDeepEqual((await session.snapshot()).world,before.world);
    }finally{await session.close();}
  }finally{await bridge.close();}
});

test("only discovered matching endpoint path parameters become repairable query observations", async () => {
  const calls: Record<string, unknown>[] = [];
  const publicResult = JSON.stringify({ results: [{ method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}",
    parameters: { spreadsheetId: { type: "string", location: "path" }, includeGridData: { type: "boolean", location: "query" } } },
    { method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/current", parameters: { spreadsheetId: { type: "string", location: "query" } } }] });
  const bridge = { assertHealthy() {}, async request(value: Record<string, unknown>) {
    calls.push(value); return { content: value.name === "api_search" ? publicResult : "official response" };
  } } as unknown as AutomationBridge;
  const session = new OfficialAutomationSession(bridge, "fixture", "fixture", "a".repeat(64), []);
  const args = { method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/ss_csat", params: '{"spreadsheetId":"ss_csat"}', body: "null" };
  assert.equal((await session.call("api_fetch", args)).content, "official response", "undiscovered endpoints remain official calls");
  assert.equal((await session.call("api_search", { query: "sheets spreadsheets get", top_k: 10 })).content, publicResult, "discovery output is unchanged");
  const dispatched = calls.length;
  for (const value of ["ss_csat", "different", null, 0]) {
    const response = await session.call("api_fetch", { ...args, params: JSON.stringify({ spreadsheetId: value }) });
    assert.match(response.content, /INVALID_TOOL_ARGUMENTS/);
    assert.match(response.content, /path parameter\(s\): spreadsheetId/);
    session.assertHealthy();
  }
  assert.equal(calls.length, dispatched, "duplicate path fields never reach the official router");
  assert.deepEqual(session.trace[2]?.arguments, args, "the original arguments remain available, without silently dropping duplicates");
  for (const valid of [
    { ...args, params: '{"includeGridData":true}' },
    { ...args, params: '{"spreadsheetIdentifier":"ss_csat"}' },
    { ...args, params: "{}", body: '{"spreadsheetId":"ss_csat"}' },
    { ...args, method: "POST" },
    { ...args, url: args.url + "/values/Sheet1!A1:B2" },
    { ...args, url: "https://sheetsXgoogleapis.com/v4/spreadsheets/ss_csat" },
    { ...args, method: "POST", url: "https://sheets.googleapis.com/v4/spreadsheets/ss_csat:batchUpdate" },
    { ...args, url: "https://sheets.googleapis.com/v4/spreadsheets/current" },
    { ...args, params: "{invalid-json" },
  ]) assert.equal((await session.call("api_fetch", valid)).content, "official response", "only the exact discovered method and URL pattern may reject path/query collisions");
  const other = new OfficialAutomationSession(bridge, "another-world", "fixture", "a".repeat(64), []);
  assert.equal((await other.call("api_fetch", args)).content, "official response", "public endpoint observations stay in their own world");
});

test("discovered endpoints still expose real internal TypeErrors for valid arguments", async () => {
  const session = new OfficialAutomationSession({ assertHealthy() {}, async request(value: Record<string, unknown>) {
    if (value.name === "api_search") return { content: JSON.stringify({ results: [{ method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}", parameters: { spreadsheetId: { location: "path" } } }] }) };
    throw new TypeError("official internal TypeError unrelated to argument binding");
  } } as unknown as AutomationBridge, "fixture", "fixture", "a".repeat(64), []);
  await session.call("api_search", { query: "spreadsheets get" });
  await assert.rejects(session.call("api_fetch", { method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/ss_csat", params: "{}", body: null }), /official internal TypeError/);
  assert.throws(() => session.assertHealthy(), /official internal TypeError/);
  assert.equal(session.trace.at(-1)?.type, "environment-error");
});

test("the observed Sheets path/query duplication is rejected and corrected in the same official world", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const session = await bridge.start("simple.csat_sheets_slack_alert");
    try {
      const args = { method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/ss_csat", params: '{"spreadsheetId":"ss_csat"}', body: "null" };
      const before = await session.snapshot();
      const initialScore = (await session.grade(before)).score;
      // Reproduce the frozen official route failure directly, without the adapter
      // marking its session failed; verify this pre-binding error has no effects.
      await assert.rejects(bridge.request({ op: "call", session: session.id, name: "api_fetch", arguments: args }), /multiple values for argument 'spreadsheetId'/);
      assert.deepEqual(await session.snapshot(), before);
      const discovery = JSON.parse((await session.call("api_search", { query: "sheets spreadsheets get metadata", top_k: 10 })).content) as { results: { id: string }[] };
      assert.ok(discovery.results.some((endpoint) => endpoint.id === "sheets.spreadsheets.get"));
      assert.match((await session.call("api_fetch", args)).content, /INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();
      assert.deepEqual(await session.snapshot(), before, "rejected duplicate arguments do not mutate the world");
      const corrected = JSON.parse((await session.call("api_fetch", { ...args, params: "{}" })).content) as { spreadsheetId: string };
      assert.equal(corrected.spreadsheetId, "ss_csat");
      session.assertHealthy();
      assert.deepEqual(await session.snapshot(), before, "the corrected official GET is read-only");
      assert.equal((await session.grade(await session.snapshot())).score, initialScore, "the same uncompleted world keeps its unchanged official grade");
      assert.equal(initialScore, 0);
    } finally { await session.close(); }
  } finally { await bridge.close(); }
});

test("the observed Trello duplicate field mistake can be corrected in the same official world", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const session = await bridge.start("simple.trello_urgent_support_card");
    try {
      const created = JSON.parse((await session.call("api_fetch", { method: "POST", url: "https://api.trello.com/1/cards", params: null,
        body: JSON.stringify({ idList: "lst_support_todo", idBoard: "brd_support", name: "Offline parameter regression fixture" }) })).content) as { id: string };
      assert.equal(typeof created.id, "string");
      const args = { method: "POST", url: `https://api.trello.com/1/cards/${created.id}/idLabels`, params: '{"value":"label_urgent"}', body: '{"value":"label_urgent"}' };
      const before = await session.snapshot();
      assert.match((await session.call("api_fetch", args)).content, /INVALID_TOOL_ARGUMENTS/);
      session.assertHealthy();
      assert.deepEqual((await session.snapshot()).world, before.world, "invalid arguments perform no state mutation");
      const corrected = JSON.parse((await session.call("api_fetch", { ...args, body: null })).content) as unknown[];
      assert.ok(Array.isArray(corrected) && corrected.length > 0);
      session.assertHealthy();
      assert.notDeepEqual((await session.snapshot()).world, before.world, "the corrected official call records the label mutation");
    } finally { await session.close(); }
  } finally { await bridge.close(); }
});

test("official task worlds isolate mutations and replay saved contract snapshots", { skip: !native }, async () => {
  const bridge = await AutomationBridge.open();
  try {
    const [changed, untouched] = await Promise.all([bridge.start("simple.email_sf_contact_phone_update"), bridge.start("simple.email_sf_contact_phone_update")]);
    try {
      assert.deepEqual(changed.tools.map((tool) => tool.name).sort(), ["api_fetch", "api_search", "base64_encode"]);
      const search = await changed.call("api_search", { query: "salesforce contacts update", top_k: 1 });
      assert.match(search.content, /salesforce/);
      await changed.call("api_fetch", { method: "PATCH", url: "https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001", params: null, body: JSON.stringify({ Phone: "+1-555-0101" }) });
      const [changedWorld, untouchedWorld] = await Promise.all([changed.snapshot(), untouched.snapshot()]);
      assert.notDeepEqual(changedWorld.world, untouchedWorld.world);
      assert.equal((await changed.grade(changedWorld)).score, 1);
      assert.equal((await untouched.grade(untouchedWorld)).score, 0);
      const regrade = await bridge.start("simple.email_sf_contact_phone_update");
      try {
        const grade = await regrade.grade(JSON.parse(JSON.stringify(changedWorld)) as typeof changedWorld);
        assert.equal(grade.score, 1);
        assert.equal(grade.partialCredit, 1);
        await assert.rejects(regrade.grade({ ...changedWorld, contract: "0".repeat(64) }), /matching task contract/);
      } finally { await regrade.close(); }
    } finally { await changed.close(); await untouched.close(); }
  } finally { await bridge.close(); }
});

