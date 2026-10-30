import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {automationIdentity,automationAdapter,AutomationBridge} from '../dist/benchmark/automation.js';

const [dataDirectory,outputDirectory]=process.argv.slice(2);
if(!dataDirectory||!outputDirectory)throw Error('Usage: verify_automation_worlds.mjs <Search data directory> <new output directory>');
const output=resolve(outputDirectory);await mkdir(output,{recursive:false});
const benchmark=await automationAdapter.load({dataDir:resolve(dataDirectory),split:'validate'});
const identity=await automationIdentity();
await writeFile(join(output,'manifest.json'),JSON.stringify({at:new Date().toISOString(),data:benchmark.identity,ids:benchmark.tasks.map(task=>task.id),identity,modelCalls:0,testCalls:0},null,2)+'\n');
const bridge=await AutomationBridge.open(),rows=[];
try {
 for(const task of benchmark.tasks){
  const session=await bridge.start(task.id.slice('automationbench:'.length));
  try{const snapshot=await session.snapshot(),grade=await session.grade(snapshot);assert.ok([0,1].includes(grade.score));rows.push({taskId:task.id,contract:snapshot.contract,strictInitialWorldScore:grade.score,partialCredit:grade.partialCredit,valid:true});}
  catch(error){rows.push({taskId:task.id,valid:false,error:String(error)});}
  finally{await session.close();}
  await writeFile(join(output,'results.json'),JSON.stringify(rows,null,2)+'\n');
  if(rows.length%20===0)console.log(JSON.stringify({completed:rows.length,total:benchmark.tasks.length,invalid:rows.filter(row=>!row.valid).length}));
 }
 assert.equal(rows.length,200);assert.ok(rows.every(row=>row.valid));
 await writeFile(join(output,'completion.json'),JSON.stringify({at:new Date().toISOString(),valid:200,modelCalls:0,testCalls:0,claim:'Official initial-world/contract/scorer checks only; no solving performance.'},null,2)+'\n');
} finally {await bridge.close();}
