# Ditto Node Workflow Search

Search reusable single-agent workflows built with the public Ditto Node → Graph → Loop hierarchy. The default is **scheme B**: an optimizer produces declarative definitions, and a fixed execution Agent validates, binds and runs native Workers. Ditto package sources are not modified.

## Unified search

- Program-selected Top-4: 30% uniform exploration and 70% softmax (`exp(20 × score)`), using only complete valid evaluations.
- One coherent main change may include necessary predecessor/successor nodes. Dependencies can be rewired within the declared budget; Graphs remain local DAGs.
- Native output paths, JSON transformations, state, branches and loops are declarative. The host owns interface callbacks, unwrapping, SDK calls and resources.
- System templates are frozen across datasets/candidates. Task-specific instructions are user data. Generated JavaScript is limited to isolated pure tools/data helpers.
- Context, task-attempt Memory/Cache, reasoning, tools/observations and real `RETRIEVAL.SEARCH` are available. Retrieval defaults to the current task's public materials.
- Quality pruning, model loss and engineering failure have separate records. Partial scores never become full candidate scores.

See [the unified rules](docs/unified-search.zh-CN.md) and [prompt ownership](prompts/README.md).

## Install and verify

Node 24+, npm 11+ and Python 3.11+ are required. Code benchmarks require Docker; MATH scoring also needs the pinned reference/dependencies described in the benchmark documentation.

```powershell
npm.cmd ci
python -m venv .provider-venv
.provider-venv/Scripts/python.exe -m pip install -r requirements-provider.txt
$env:DITTO_PROVIDER_PYTHON = (Resolve-Path .provider-venv/Scripts/python.exe).Path
npm.cmd run check
npm.cmd run audit:prompts
```

Configure an ignored local `.env` from `.env.example`, and prepare [the pinned raw data](data/README.md). Model calls use official DeepSeek `deepseek-flash`, temperature 0 and thinking disabled. The alias alone does not prove an immutable model version; provider-reported identity is retained when available.

Credentials, datasets, environments, runs and private scoring records are not published.

## Run

These commands make paid calls unless `--offline-only true` is supplied.

```powershell
# Check configuration, data and identity without creating a provider.
npm.cmd run search:drop -- --offline-only true --output-dir runs/drop-preflight

# Search the complete fixed validation split.
npm.cmd run search:drop -- --output-dir runs/drop-unified

# Evaluate the frozen winner on the separate Test split.
npm.cmd run test:frozen -- --dataset drop --run-dir runs/drop-unified
```

The same entry supports `search:gsm8k`, `search:math`, `search:humaneval` and `search:mbpp`. Search uses five repetitions and a budget of 20 complete valid candidates including baseline, subject to the existing convergence rule. Frozen Test uses three repetitions without feedback into optimization.

DROP retains the fixed 200/800 validation/Test split and original scoring. A new search allocation uses paired regression pruning at nested 16/32/64/128/200 stages, completing all five repetitions at each visited prefix. Only complete results enter final ranking. This is a new search protocol retaining main's data/metric/repetition baseline.

Manifests freeze protocol, prompts, source/compiled/environment identity and selection. Proposals, repairs, actual requests, raw node evidence, stage decisions and costs are saved. Resume rejects changed identities; changed artifacts cannot reuse older successful cases.

## Historical controllers

`search:drop:legacy` keeps the original snapshot CLI. `experiment:legacy:a` and `experiment:legacy:small` keep historical diagnostic controllers. Their protocols and old scores are separate from the unified defaults.

## Checks

`npm run check` runs type checks and offline Node tests. `python scripts/provider_bridge_test.py` checks transport behavior. Prompt audits use mock providers. These checks do not constitute a new DROP accuracy experiment.
