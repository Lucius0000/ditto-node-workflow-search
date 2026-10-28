import type {BenchmarkTask} from '../domain.js';
import type {BenchmarkSplit} from './types.js';

/** Only public IDs cross this boundary; the scorer stays in its adapter closure. */
export function searchSubset(split:BenchmarkSplit,tasks:readonly BenchmarkTask[],taskIds:readonly string[]):readonly BenchmarkTask[]{
 if(split!=='validate')throw Error('Search subsets are restricted to the validation split');
 if(!taskIds.length||new Set(taskIds).size!==taskIds.length)throw Error('Search subset requires distinct nonempty task IDs');
 const byId=new Map(tasks.map(task=>[task.id,task]));
 return taskIds.map(id=>{const task=byId.get(id);if(!task)throw Error(`Unknown search task ID: ${id}`);return task;});
}
