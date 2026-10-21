# AutomationBench full workflow search

[中文](automation-workflow-search.zh-CN.md) · [Shared staged search protocol](code-workflow-search.md)

This entry uses the pinned official AutomationBench world, three tools (`api_search`, `api_fetch`, `base64_encode`) and strict final-state assertions. It depends on published Ditto0.1.1; MFlow's fixed comparison copy uses Ditto0.1.2. Their dependency and organization differences remain part of the comparison record. No Core or official tool implementation is changed.

The predefined workflow contains real nodes: CONTEXT.LOAD → actor SAMPLE → ACT.TOOL → OBSERVE → CONTEXT.UPDATE → actor, then OUTPUT on final text. Graph transitions drain all pending actions before the next actor turn. Each ACT executes one unconsumed call; OBSERVE retains callId. Two sequential ACT operations must commit in separate Graphs. Reused IDs in later actor turns are distinct occurrences. Incomplete assistant/tool groups are rejected before another model request. Reasoning text is never tool-effect evidence.

The same staged parent/draft/submission mechanism searches node configuration within current contracts, node membership/bindings, Graph grouping, feedback, next/switch/repeat, stopping and output source. The actual searched Graph/Loop drives tools; there is no fixed tool loop appended after a planning workflow. Generation, provider, public schemas, tool implementations, world goals and grading remain fixed. Code-task entries do not gain tools.

Set `DITTO_AUTOMATION_ROOT` to the clean pinned official checkout (`4a8e1061254004d9dac807054eed33fad7d1ff14`), `DITTO_AUTOMATION_PYTHON` to its isolated official environment, and `DITTO_PROVIDER_PYTHON` to the provider SDK environment. The entry checks source revision, uv.lock SHA, imported module location and package versions. Derived API index caches stay outside the source checkout. The full Search file contains200 original ordered tasks and is byte-verified; do not supply a sampled formal limit.

```powershell
npm ci
npm run check
$env:CODE_SEARCH_SOURCE='ark-plan'
$env:CODE_SOUL_CONCURRENCY='3'
node dist/cli.js search --dataset automationbench --data-dir '<locked-Automation-data>' --output-root '<new-run-root>' --rounds 10 --repeats 1
node dist/cli.js search --dataset automationbench --data-dir '<locked-Automation-data>' --resume-dir '<same-search-run>' --rounds 10 --repeats 1
node dist/code-search-cli.js smoke automationbench '<smoke-run>' '<locked-Automation-data>' unused ark-plan '' 10 1
node dist/code-search-cli.js official automationbench '<official-run>' '<locked-Automation-data>' unused official '<completed-Ark-search-run>' 10 1
```

The shared entry retains a positional image argument for compatibility; Automation uses `unused` because it grades official simulated worlds rather than generated Python in Docker. Code tasks still require their preloaded digest and Docker preflight. New task execution still requires its applicable audit gate; command examples are not authorization to run model batches.

Search defaults to five independent full-workflow repetitions. The current experiment explicitly passes one in every search/resume command; smoke, matched diagnosis and official evaluation independently use one. The five-repeat path has offline integration coverage, not a completed five-repeat real model search. Each task, repetition and workflow retry starts a fresh world. Completed valid cases, including zero scores, retain their repeat index on recovery. A private saved snapshot can be regraded after scorer infrastructure failure without repeating successful effects.

Official strict success (`0` or `1`) alone enters ranking. Partial credit is diagnostic. Normal argument errors returned to the actor are task observations, and normal early-final/budget exits are scored from the actual world. Bridge, required-schema, scorer and supervision failures invalidate the evaluation. No textual completion claim replaces scoring. Saved `finalWorld`, `taskContract`, `assertions`, toolTrace, per-node outputs and Graph transitions stay on the private evidence side; optimizer payloads contain only permitted public plans, scores and predictions.

Offline checks include fixed actions through MFlow native ReAct and the frozen pre-repair/integrated Ditto Graph/Loop, same-world writes/reads, multiple actions, argument-error correction, separate tasks, fresh retry, snapshot grading/contract rejection and process interruption. Volatile construction/write timestamps are normalized only for comparisons; raw snapshots remain intact. Fake Provider tests establish execution behavior, not model capability or an explanation of reported40%/90% results. The ten-task matched real model diagnosis and all full searches remain separately authorized stages.

## Uniform execution budget

Search and official entries save a small, identity-bound write-ahead checkpoint at case start and before every actor is admitted. A failed checkpoint blocks dispatch. The clock and count survive a process exit before the large case result is written. If workflow-attempt evidence is missing, staged recovery refuses a fresh runner until reviewed; arbitrary hard crashes do not transparently resume. An expired interrupted case remains an infrastructure failure rather than opening a fresh world and becoming a normal zero. Older runs without these checkpoints cannot claim exact hard-crash budget recovery.

Each case and independent repeat shares at most60 actor calls across all nodes and workflow retries, or600000ms wall time. Recovery preserves the start time and call count. Whole Graph actor groups are admitted only if they fit the remaining allowance; the blocked group size is recorded. Pending tool groups can drain through declared non-inference Graphs, without adding a hidden tool loop; unchanged drain cycles cannot bypass the deadline. Budget output is an explicit supervisor record, never a fabricated model final or claim of effects. The saved actual world still receives strict grading, including valid zeros. In-flight cancellation retains unknown-usage bookkeeping. Real service, bridge and scorer faults stay invalid even at the budget boundary. The protocol identity includes the same policy for Search and official verification.

Only a verified read-only Salesforce query-parser depth error is returned as a correctable MALFORMED_QUERY observation. The bridge checks the official parser traceback code objects; unrelated recursion and write/bridge failures remain errors. Official sources and assertions are unchanged.
