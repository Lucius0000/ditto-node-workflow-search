import {readFile} from 'node:fs/promises';
import type {DatasetName} from '../domain.js';
import {artifactHash} from '../unified/store.js';
import {validateDefinition,type GraphDefinition} from '../graph-agent/schema.js';
import {promptBaseline,editablePaths} from './contract.js';
export type Presentation='no-repeat'|'repeat-task-on-first-sample';
export const ASSET_DATASETS=['humaneval','mbpp','drop','automationbench'] as const;
export type AssetDataset=typeof ASSET_DATASETS[number];
export function setFirstPresentation(parent:GraphDefinition,presentation:Presentation):GraphDefinition{
 if(!['no-repeat','repeat-task-on-first-sample'].includes(presentation))throw Error('Unknown first-task presentation');
 const definition=structuredClone(parent),first=definition.graphs.flatMap(g=>g.nodes).find(n=>n.type==='INFER.REASONING.SAMPLE');
 if(!first)throw Error('Presentation requires a reachable SAMPLE seed');
 first.config.firstUser=presentation==='no-repeat'?{literal:''}:{ref:['task','prompt']};return validateDefinition(definition);
}
export async function loadPromptAssets(dataset:DatasetName,options:{presentation?:Presentation;guidance?:boolean}={}){
 if(!ASSET_DATASETS.includes(dataset as AssetDataset))throw Error('No reviewed initialization profile for dataset');
 const base=new URL('../../prompts/initialization/',import.meta.url);
 const template=JSON.parse(await readFile(new URL('strategy-template.json',base),'utf8'));
 const profile=JSON.parse(await readFile(new URL(dataset+'.json',base),'utf8'));
 if(profile.dataset!==dataset||profile.version!=='dataset-initialization-v1'||template.version!=='strategy-construction-v1')throw Error('Prompt asset identity mismatch');
 const selected=profile.selectedSeed,presentation=options.presentation??selected.presentation;
 let seed=setFirstPresentation(promptBaseline(dataset),presentation);
 const path=editablePaths(dataset)[0]!.slice(1).split('/');let target:any=seed;for(const key of path.slice(0,-1))target=target[key];target[path.at(-1)!]=selected.strategy;seed=validateDefinition(seed);
 // The exact accepted seed is reconstructed only under its accepted presentation.
 if(presentation===selected.presentation&&artifactHash(seed)!==selected.sourceDefinitionHash)throw Error('Selected strategy seed differs from accepted source');
 return{definition:seed,source:{protocol:selected.sourceProtocol,candidateId:selected.sourceCandidate,revision:'reusable-strategy-v1',recordHash:artifactHash(selected),definitionHash:selected.sourceDefinitionHash},initialization:options.guidance===false?null:{template,profile:profile.optimizerProfile},manifest:{version:'reusable-prompt-assets-v1',dataset,templateHash:artifactHash(template),profileHash:artifactHash(profile),optimizerProfileHash:artifactHash(profile.optimizerProfile),researchMetadataHash:artifactHash(profile.researchMetadata),sourceDefinitionHash:selected.sourceDefinitionHash,definitionHash:artifactHash(seed),presentation,guidance:options.guidance!==false,sourceCandidate:selected.sourceCandidate}};
}
