# Workflow capabilities and time budgets

For the declarative four-dataset evaluation entry point, see [selected workflow delivery](recommended-search-and-test.md).

[中文说明](workflow-capabilities.zh-CN.md)

The regular `src/cli.ts` entry keeps optimizer-directed **complete workflow snapshots**. The optimizer can insert, replace, delete and rewire legal nodes; this is not the append-only historical experiment driver.

## Available operations

| Worker | Searchable leaves |
| --- | --- |
| Context | LOAD, SELECT, UPDATE, COMPRESS |
| Memory | WRITE, GET, SEARCH |
| Interaction | ACT.TOOL, OBSERVE |
| Infer | REASONING.SAMPLE, TRAJECTORY, REFLECT, DELIBERATE |

Keep one leading task LOAD (`config: {includeTaskMetadata: true}`). Additional LOAD nodes use `{sourcesSource: {from: "node", nodeId: "earlier-id", view: "observation"}}`; they load actual upstream content, not another implicit copy of the task. Typed sources also support context, memory records/IDs, external results and answer text. Same-Graph sources must be explicit dependencies. Evidence must reach a later answer consumer; the final output is an Infer node.

The optimizer receives the exact schema in `CAPABILITY_SCHEMA_GUIDE` (`src/workflow/capability-schema.ts`). For example, a SELECT placed before the existing solver uses:

```json
{"id":"selected-context","type":"CONTEXT.SELECT","graphId":"prepare","dependencies":["context-load"],"config":{"contextSource":{"from":"node","nodeId":"context-load","view":"context"},"limit":1}}
```

Context transformations contribute working evidence while retaining the original problem. Memory is fresh for each task/repeat/attempt; GET and SEARCH require actual earlier writes. The application provides only `bounded_arithmetic` and `literal_text_find`, executed in a bounded tool worker. No model-written code, shell, network tools or private reference material is available. OBSERVE requires an actual tool result. Tools and memory evidence do not become answer candidates for REFLECT or DELIBERATE.

Historical Infer-only plans keep their existing message construction. Extended plans use typed bindings and the registered task-local resources. Source references participate in duplicate detection, including after node ID renaming. Graphs remain in prepare/solve/refine order and use the existing sequential Loop.

## Choose time budgets before a run

Every formal CLI run must specify both budgets. Values are positive integer milliseconds, or `unlimited` with `--time-budget-reason`. The numbers below illustrate syntax, not recommended limits for every benchmark:

```bash
npm run search:math -- --request-timeout-ms 600000 --workflow-timeout-ms 1200000
```

For an explicitly approved unlimited comparison:

```bash
npm run search:math -- --request-timeout-ms unlimited --workflow-timeout-ms unlimited --time-budget-reason "Preserve the approved historical timing protocol"
```

- Request time starts after admission to the shared provider gate and includes service wait and the entire response. Continuous chunks do not reset it. Optimizer requests use this same request policy; an optimizer timeout is not a benchmark zero.
- Workflow time starts when a task/repeat evaluation begins. It includes provider queue time, all calls, tools, retries and format repair; grading is outside this budget. A retry does not reset it.
- Exceeding either declared execution budget aborts the request/workflow. Evaluation records a **valid zero** with `timeBudgetOutcome`, retains the denominator and does not retry or repair that result. It does not silently fall back to an earlier answer.
- Transport errors, explicit provider errors and scorer failures remain invalid engineering outcomes. Partial/unknown token usage stays explicitly unknown; cancellation is not assumed free.

The policy is stored in the manifest, frozen checkpoints and case-recovery identity. Search, frozen Test and independent round tests must match that policy. A policy change needs a new run; do not regrade old evidence retroactively. Library callers supplying custom evaluators must pass `timeBudget` to `evaluateTasks` and use the managed runtime/runner to propagate cancellation.

Before a new benchmark, agree on limits, queue/wait accounting, timeout scoring and recovery. Existing approved values can be reused under identical conditions. Do not use an enormous default as a reminder to choose later.

## Verification

Install the Python 3.13 HTTP-bridge dependencies with `python -m pip install -r requirements-provider.txt`, then run `npm ci` and `npm run check`. CI installs both Python and Node dependencies; the HTTP integration tests use the real Python bridge against local fixture servers. Tests cover the regular snapshot parser/runner, repeated Context LOAD, Context consumption, real memory/tool operations, task isolation, continuous-stream deadlines, shared retry budgets, cancellation, zero scoring and infrastructure failures. These checks do not require new paid benchmark calls.
