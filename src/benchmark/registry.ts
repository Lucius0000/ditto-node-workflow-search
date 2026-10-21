import { DATASETS, type DatasetName } from "../domain.js";
import { humanevalAdapter, mbppAdapter } from "./code-adapters.js";
import { dropAdapter } from "./drop.js";
import { gsm8kAdapter } from "./gsm8k.js";
import { mathAdapter } from "./math.js";
import { automationAdapter } from './automation.js';
import type { BenchmarkAdapter, BenchmarkLoadOptions, LoadedBenchmark } from "./types.js";

const adapters: Readonly<Record<DatasetName, BenchmarkAdapter>> = Object.freeze({
  drop: dropAdapter,
  humaneval: humanevalAdapter,
  mbpp: mbppAdapter,
  gsm8k: gsm8kAdapter,
  math: mathAdapter,
  automationbench:automationAdapter,
});

export function getBenchmarkAdapter(dataset: DatasetName): BenchmarkAdapter {
  return adapters[dataset];
}

export function listBenchmarkAdapters(): readonly BenchmarkAdapter[] {
  return Object.freeze(DATASETS.map((dataset) => adapters[dataset]));
}

export function loadBenchmark(dataset: DatasetName, options: BenchmarkLoadOptions): Promise<LoadedBenchmark> {
  return getBenchmarkAdapter(dataset).load(options);
}
