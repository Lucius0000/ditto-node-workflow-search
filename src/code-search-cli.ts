import { runCodeSearch, type CodeSearchOptions } from './code-search.js';

const [mode, dataset, directory, dataDir, dockerImage, source = 'official', selectedRun, newCandidates = '2'] = process.argv.slice(2);
if (!['smoke', 'search', 'official'].includes(mode ?? '') || !['humaneval', 'mbpp'].includes(dataset ?? '') || !directory || !dataDir || !dockerImage
  || !['official', 'ark-plan'].includes(source)) throw Error('Usage: code-search-cli.js smoke|search|official humaneval|mbpp run-directory data-directory pinned-image [official|ark-plan] [selected-search-directory] [new-candidate-budget=2]');
await runCodeSearch({ mode, dataset, directory, dataDir, dockerImage, source, newCandidates: Number(newCandidates), ...(selectedRun ? { selectedRun } : {}) } as CodeSearchOptions);
