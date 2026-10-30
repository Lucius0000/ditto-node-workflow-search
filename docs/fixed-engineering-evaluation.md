# Fixed engineering evaluation

[中文](fixed-engineering-evaluation.zh-CN.md)

`dist/unified/fixed-engineering.js` evaluates the four frozen Search splits without invoking an optimizer or Test. It keeps the unified Search defaults unchanged. HumanEval, MBPP and DROP use the main baseline; AutomationBench uses a declared decision → ACT.TOOL → OBSERVE loop over a fresh official world.

Build first, then supply an approved, non-secret JSON protocol matching `FixedEngineeringProtocol` in `src/unified/fixed-engineering.ts`:

```powershell
npm run build
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <new-output-directory> probe --offline-only
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <output-directory> probe --resume
node --experimental-vm-modules dist/unified/fixed-engineering.js <protocol.json> <another-new-directory> full
```

The protocol requires the approved Ark Agent Plan endpoint/model, three distinct account aliases, explicit authorization and confirmation that overage is disabled. Keys are read only from `ARK_PLAN_KEY_<ALIAS>`. Read-only quota queries use `ARK_AUDIT_ACCESS_KEY_ID_<ALIAS>` and `ARK_AUDIT_SECRET_ACCESS_KEY_<ALIAS>`. It never switches to the ordinary Ark or DeepSeek API.

The supported protocol is eight independent probes, then one complete 519-task pass: HumanEval 33, MBPP 86, DROP 200 and AutomationBench 200. Requests have 180 seconds; ordinary workflows have 300 seconds; Automation has 600 seconds and at most 60 admitted logical model calls, including internal reasoning and format repair. Its retries share the same call/wall-clock budget. The SDK permits at most three HTTP attempts per logical call. Each task/repeat has at most five workflow attempts. Write-ahead records survive interruption; missing result evidence cannot silently authorize a new attempt.

Datasets run concurrently through one pool capped at 18 model calls, six per account. Code tasks each use six task slots to bound Docker load. Service `AccountQuotaExceeded` excludes an exhausted account and suppresses SDK retries; `AccountRateLimitExceeded` retains transient backoff. Quota values and structured service rejections are both retained. No account settings are changed. A `STOP` file prevents new dispatch while accepted work drains.

Automation tools execute only inside the declared Graph/Loop. Public schemas and observations reach the next inference; worlds, contracts and strict grading stay private. Grading uses the actual final world. Partial credit is diagnostic. Model format loss and declared execution-budget exhaustion are valid zeroes; provider, bridge and judge failures remain invalid. Judge-only recovery requires the original world/prediction and does not regenerate an answer. Cancelling an active official bridge call discards the bridge and records an unknown world outcome; this provides no rollback guarantee.

Concurrent quota refreshes share each in-flight account/action query. Settled queries are not cached. Explicit control-plane throttling has at most three read-only attempts with one- and two-second backoff; permission failures do not retry. These waits remain inside the requesting workflow deadline and do not regenerate an answer.

Missing required Automation decision fields become model-format loss only under the exact host-owned response instruction and public tool schema. Generic JSON path errors remain binding failures; `coalesce` can still supply an optional default, including `api_search.top_k = 5`.

For multi-fence Python responses, extraction keeps the first entry-point implementation and supporting declaration blocks. A bare signature with no body is an explanatory header and is skipped when an implementation follows; a malformed implementation is still retained rather than replaced by a later alternative. A syntax-only Python AST check excludes separate REPL transcripts, prose, tests and usage fragments; it never executes model code or chooses blocks by private-test results. This check uses `DITTO_PROVIDER_PYTHON` (default `python`) and preserves imports, constants and helper definitions.

Code judging requires a successful `docker-ready` check and a pre-pulled immutable image. The generated program has a 12-second in-container deadline; the 60-second host watchdog is an infrastructure boundary. Fixed marker printing and early exit cannot satisfy the randomized completion marker. This check is not a proof against arbitrary malicious test-harness introspection.

Every run freezes source, compiled artifacts, prompts, definitions, data membership/order, provider and official-environment identity. It archives HTTP payloads without authentication headers, raw responses, actual node inputs/outputs, graded programs/worlds and known/unknown usage. Results containing private tests/worlds remain outside the public repository. A changed identity cannot resume an old run.

`repair --repair-from <original-full-run>` implements the separately authorized, single-attempt repair of the 27 engineering-invalid positions from this campaign. It verifies unchanged semantic identities and records the parent source/runtime; the 492 original valid results retain their provenance. It uses only the first authorized, still-funded account. This is a new bounded repair validation, not an extension of the original exhausted budget. Do not use it as a general rerun or optimizer entry point.

Useful checks:

```powershell
npm run check
npm run audit:prompts
python scripts/provider_bridge_test.py
# Real environments, with the pinned interpreters/source/data configured:
node --experimental-vm-modules --test dist/benchmark/automation.test.js
node scripts/verify_automation_worlds.mjs <automation-search-data> <new-output-directory>
# Run docker-ready successfully first and select CODE_JUDGE_IMAGE:
node scripts/verify_code_judge.mjs
node scripts/verify_code_judge_active.mjs
```
