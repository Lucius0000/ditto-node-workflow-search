# HumanEval and MBPP node workflow search

[中文](code-workflow-search.zh-CN.md)

The code benchmark entry uses the existing single-node construction search and explicit Graph/Loop assembly. Other dataset entries keep their existing behavior. It depends on the pinned `@codesoul-co/ditto@0.1.1` package and never modifies Core.

## Prerequisites and data

Use Node 24+, npm 11+, Python 3.13 with `python -m pip install -r requirements.txt`, and a working Docker daemon. On the maintained Windows host, run `docker-ready` first. Set `DITTO_PROVIDER_PYTHON` to the selected Python executable. Run `npm ci` and `npm run check`; set `DITTO_DOCKER_TEST=1` and a preloaded `CODE_JUDGE_IMAGE` to include real Docker tests. On a memory-constrained host, set `GOMAXPROCS=2`; the test script limits process concurrency to two.

Supply the original locked `humaneval_validate.jsonl` (33), `humaneval_test.jsonl` (131), `mbpp_validate.jsonl` (86), and `mbpp_test.jsonl` (341). Formal loading verifies full raw SHA-256, count, membership and order. Search reads only validate. Engineering checks select the first five public IDs after full-file verification. Test is a separate permission and is not used by this validation protocol.

Use a reviewed, preloaded image digest. The validated image was `sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4` (`python:3.12-alpine`). No implicit pull occurs during grading. The judge has no host mount or network, a read-only root, uid 65534, constrained memory/CPU/PIDs and a private tmpfs. Candidate execution is limited to 10 seconds; Docker supervision is 60 seconds. Random start/end markers distinguish execution failures and reject the reproduced fixed-marker early-exit pseudo-success.

## Sources and commands

Delivery defaults to the official DeepSeek endpoint/model using `DS_API_KEY`. An explicitly selected `CODE_SEARCH_SOURCE=ark-plan` uses the separate `ARK_PLAN_KEY_LIU`, fixed Plan endpoint and `deepseek-v4.1-flash`. Sources have separate identities and scores. Keys stay in process environment; do not commit `.env`.

```powershell
npm run build
$env:DITTO_PROVIDER_PYTHON='<selected-python>'
$env:CODE_SOUL_CONCURRENCY='3'
$env:CODE_SEARCH_SOURCE='official'
node dist/cli.js search --dataset humaneval --data-dir '<locked-data-directory>' --output-root '<run-root>' --rounds 2 --repeats 1 --docker-image '<preloaded-image-digest>'
```

`--rounds` counts valid new workflows after the initial baseline. Increase it only within the authorized experiment scope. The engineering entry exposes fixed five-case smoke/official checks:

```powershell
node dist/code-search-cli.js smoke mbpp '<smoke-run>' '<locked-data>' '<image-digest>' official
node dist/code-search-cli.js official mbpp '<official-run>' '<locked-data>' '<image-digest>' official '<completed-Ark-search-run>'
```

Official verification uses the already selected frozen plan, never searches or changes selection from its score. Reusing a run directory restores matching unfinished cases and pending construction. Completed evaluations are not independent repeats. A changed source, data, model, protocol or prompt identity requires a new run and an explicit evidence-impact assessment. The separate engineering entry accepts an optional final new-candidate budget after the selected-run argument; its default is two.

## Search and execution boundaries

The optimizer chooses a recorded construction branch, then adds, replaces, rewires or removes one node, or performs pure assembly. Allowed types are CONTEXT.LOAD, SAMPLE, TRAJECTORY, REFLECT and DELIBERATE. Existing instructions, criteria, modes, strategy parameters and declared connections are searchable; generation parameters, providers, tools, judge and private tests are fixed. The implementation does not enable CONTEXT.UPDATE or external tools for these tasks.

Partial constructions persist without a score. Complete assembly must validate every node/graph, target, dependency, transition and terminating output. Cosmetic renames are duplicates; effective configuration and routing affect identity. Construction ancestry never implies execution dependencies. Only declared current dependencies and optional previous committed feedback enter a node.

Verify/critique assess only. Revise uses the existing actionable-error policy and exact target-matched feedback. Missing substantive fields remain engineering-invalid; the application never invents a verdict or replacement code. A required format reminder can be added explicitly to a node's criteria as a separately identified candidate. Valid wrong answers, syntax failures and candidate timeouts count as zero. Service, format and scoring infrastructure faults remain invalid and cannot enter optimizer experience.

## Evidence and recovery

Each run retains `manifest.json`, `resume-state.json`, raw `provider.jsonl` requests/responses/attempts, construction events, per-evaluation plan/results/attempts and a frozen `best/plan.json`. Results preserve extracted Python, private judge evidence, checker target/adoption audits, actual Graph paths and per-Graph output snapshots. Only public projections of valid scores, workflow definitions and predictions enter optimizer requests.

Provider calls, internal strategy calls and format repairs share one semaphore. Defaults are three transport attempts, five classified workflow attempts, a 600-second request deadline and a 30-minute workflow supervisor. Unresolved supervision faults invalidate evaluation. Proposal rejection batches and partial construction have separate finite stagnation guards. Stop after persistent failures and inspect saved state; do not rotate accounts or retry normal wrong answers for a better score.

The source/settings identity covers prompts, full selected ID order, data SHA, package/code, model/source, judge image and evaluation plan. HTTP usage that is unavailable remains unknown rather than zero. Keep the full local archive separate from a shareable submission package. Local check success does not establish hosted CI success or independent Test performance.

## Node-local input and official recovery (v2)

`humaneval-mbpp-node-search-v2` / `code-node-configuration-v2` keeps the fixed generation profile and candidate counting rules. SAMPLE messages depend on resolved configuration and explicitly bound outputs. A redundant CONTEXT.LOAD public task is omitted because the root message already carries it; other context and prerequisite answers are retained. Graph-wide identity, cosmetic Node IDs and explicit equivalent defaults do not switch message formats. Evidence labels use dependency positions rather than Node IDs. The legacy non-code path is unchanged.

TRAJECTORY passes its configured positive safe-integer `maxSteps` to Runtime, within the existing `Number.MAX_SAFE_INTEGER` ceiling. A completed partial result with `stopReason=max_steps` remains a normal budget outcome, not a service failure. Token/request/concurrency/time limits and scoring rules are unchanged.

Before any official completed-run shortcut, the entry reads and validates the completed matching v2 Ark Search, selected evaluation and frozen best plan. Official identity includes the selected Search identity hash and SHA-256 of the original `best/plan.json` bytes. Changed selections, changed bytes, missing/invalid selections and old unbound official directories are rejected. Historical v1 evidence remains readable but cannot resume as v2. Same-selection offline recovery tests validate this gate; they do not claim a new official API run.

## Required code revise message (v3)

The current identities are `humaneval-mbpp-node-search-v3` and `code-node-configuration-v3`. Only organization-backed code-task revise requests add the explicit existing requirement: return the complete `revisedResult` assistant message even when the original code is unchanged. Verify/critique requests and all adoption/schema rules remain unchanged. An omitted required field still invalidates evaluation; the application does not fabricate a replacement. Old v1/v2 runs stay under their recorded identities.
