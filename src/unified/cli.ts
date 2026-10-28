import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {DATASETS,type DatasetName} from '../domain.js';
import {runUnifiedExperiment,type UnifiedCLIOptions} from './runner.js';

export function parseUnifiedArguments(argv:readonly string[],cwd=process.cwd()):UnifiedCLIOptions{
 const [command,...rest]=argv;if(command!=='search'&&command!=='test')throw Error('Usage: unified/cli.js search|test --dataset <drop|humaneval|mbpp|gsm8k|math> [options]');
 const flags=new Map<string,string>();
 const allowed=new Set(['dataset','data-dir','output-dir','run-dir','user-prompt-file','resume','offline-only','max-valid-evaluations','rounds','max-design-rounds','max-proposal-attempts','seed','concurrency','max-calls','max-tokens','request-timeout-ms','workflow-timeout-ms','docker-image']);
 for(let i=0;i<rest.length;i+=2){const key=rest[i],value=rest[i+1];if(!key?.startsWith('--')||value===undefined||value.startsWith('--')||!allowed.has(key.slice(2))||flags.has(key.slice(2)))throw Error('Invalid or duplicate option: '+key);flags.set(key.slice(2),value);}
 const integer=(name:string,fallback:number,min=1,max=Number.MAX_SAFE_INTEGER)=>{const value=Number(flags.get(name)??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid '+name);return value;};
 const bool=(name:string)=>{const value=flags.get(name)??'false';if(!['true','false'].includes(value))throw Error('Invalid '+name);return value==='true';};
 const time=(name:string,fallback:number|null)=>flags.get(name)==='unlimited'?null:integer(name,fallback??Number.MAX_SAFE_INTEGER,1,2147483647);
 const dataset=flags.get('dataset')??'drop';if(!DATASETS.includes(dataset as DatasetName))throw Error('Unknown dataset '+dataset);
 if(flags.has('rounds')&&flags.has('max-valid-evaluations'))throw Error('Use --rounds or --max-valid-evaluations, not both');
 const resume=bool('resume'),runDir=flags.get('run-dir'),outputDir=flags.get('output-dir');
 if((command==='test'||resume)&&!runDir)throw Error('Test/resume requires --run-dir');
 if(command==='test'&&outputDir)throw Error('Test writes below its frozen Search run; do not supply --output-dir');
 if(command==='test'&&flags.has('user-prompt-file'))throw Error('Test cannot replace frozen candidate instructions');
 if(runDir&&command==='search'&&!resume)throw Error('--run-dir requires --resume true for Search');
 if(resume&&outputDir)throw Error('Resume uses its existing --run-dir');
 return {command,dataset:dataset as DatasetName,projectRoot:resolve(cwd),dataDir:resolve(cwd,flags.get('data-dir')??'data/datasets'),
  ...(outputDir?{outputDir:resolve(cwd,outputDir)}:{}),...(runDir?{runDir:resolve(cwd,runDir)}:{}),resume,offlineOnly:bool('offline-only'),
  ...(flags.has('user-prompt-file')?{userPromptFile:resolve(cwd,flags.get('user-prompt-file')!)}:{}),
  maxValidEvaluations:flags.has('rounds')?integer('rounds',20):integer('max-valid-evaluations',20),maxDesignRounds:integer('max-design-rounds',100),maxProposalAttempts:integer('max-proposal-attempts',3,1,8),
  seed:integer('seed',42,0,0xffffffff),concurrency:integer('concurrency',command==='test'?200:3,1,4096),maxCalls:integer('max-calls',50000),maxTokens:integer('max-tokens',50000000),
  requestMs:time('request-timeout-ms',600000),workflowMs:flags.has('workflow-timeout-ms')?time('workflow-timeout-ms',null):null,
  dockerImage:flags.get('docker-image')??process.env.CODE_JUDGE_IMAGE??'python:3.13-slim'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runUnifiedExperiment(parseUnifiedArguments(process.argv.slice(2))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
