import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {AutomationBudgetPersistence,AutomationBudgetProgress} from '../workflow/automation-budget.js';

/** Small write-ahead records are independent of the potentially large case result. */
export class AutomationBudgetRecovery implements AutomationBudgetPersistence {
  readonly directory:string;
  constructor(root:string,readonly identity:string){
    if(!/^[a-f0-9]{64}$/.test(identity))throw Error('Invalid Automation budget recovery identity');
    this.directory=join(root,identity);mkdirSync(this.directory,{recursive:true});
  }
  #path(caseId:string):string{return join(this.directory,createHash('sha256').update(caseId).digest('hex')+'.json');}
  load(caseId:string):AutomationBudgetProgress|undefined{
    let value:any;
    try{value=JSON.parse(readFileSync(this.#path(caseId),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    if(value?.schemaVersion!==1||value.identity!==this.identity||value.caseId!==caseId)throw Error('Automation budget checkpoint binding differs');
    if(!value.progress||typeof value.progress!=='object')throw Error('Automation budget checkpoint progress is missing');
    return value.progress;
  }
  save(caseId:string,progress:AutomationBudgetProgress):void{
    const target=this.#path(caseId),temporary=target+'.'+randomUUID()+'.tmp';
    let descriptor:number|undefined;
    try{
      descriptor=openSync(temporary,'wx',0o600);
      writeFileSync(descriptor,JSON.stringify({schemaVersion:1,identity:this.identity,caseId,progress})+'\n','utf8');
      fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
      renameSync(temporary,target);
    }finally{
      if(descriptor!==undefined)closeSync(descriptor);
      try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
  }
}
