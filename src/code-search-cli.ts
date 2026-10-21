import { runCodeSearch, type CodeSearchOptions } from './code-search.js';

const [mode, dataset, directory, dataDir, dockerImage, source = 'official', selectedRun, newCandidates = '10', repeats] = process.argv.slice(2);
if (!['smoke', 'search', 'official'].includes(mode ?? '') || !['humaneval', 'mbpp','automationbench'].includes(dataset ?? '') || !directory || !dataDir || !dockerImage
  || !['official', 'ark-plan'].includes(source)||process.argv.slice(2).length>9) throw Error('Usage: code-search-cli.js smoke|search|official humaneval|mbpp|automationbench run-directory data-directory pinned-image [official|ark-plan] [selected-search-directory] [new-candidate-budget=10] [repeats: search=5, smoke/official=1]');
await runCodeSearch({ mode, dataset, directory, dataDir, dockerImage, source, newCandidates: Number(newCandidates), ...(repeats===undefined?{}:{repeats:Number(repeats)}),...(selectedRun ? { selectedRun } : {}) } as CodeSearchOptions);
