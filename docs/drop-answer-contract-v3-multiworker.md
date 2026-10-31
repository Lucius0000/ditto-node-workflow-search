# DROP user answer contract v3 and protected Worker exploration

System prompts, pinned data/splits, the main F1 scorer and model settings remain
unchanged. This revision changes user instructions, evidence presentation and
search allocation.

## Answer targets and evidence

Numeric answers include direct lookups, comparison/ranking results and arithmetic.
The presence of arithmetic is not an answer-type classifier. A question supplying
its numeric unit in “How many <unit>” requests a numeric value; an original unit-bearing
expression such as “From what distance” requests the shortest sufficient measurement
span, without its event/object name. Entity and age-group labels remain labels.

Each inference evidence item includes the actual source node ID, Graph, operation,
native reference/view and a short declared purpose, followed by the unmodified
value. Native node outputs and bindings are not rewritten. Provenance identifies
where a candidate came from; it does not assert that candidate is correct.
Native REFLECT and DELIBERATE receive target/candidate source identities in user data.

## Search directions

The default unified search rotates protected design opportunities through:

1. Interaction ACT.TOOL/OBSERVE.
2. Context SELECT/UPDATE/COMPRESS or task-public Retrieval.
3. Native TRAJECTORY/REFLECT/DELIBERATE.
4. Task-local Memory/Cache, with optional custom Graph/Loop control.

A candidate must change a connected native operation from its assigned direction
and contain at most one SAMPLE. Renaming SAMPLE to compute/select/classify does
not satisfy the requirement. Existing SAMPLE instructions can still be optimized.
All preceding schema/mutation and actual-consumption checks remain enabled.
The program still chooses Top-4 parents with 30% uniform/70% softmax weighting.

Provider-call and token reservations are split into baseline plus four direction
buckets. Optimizer proposals, repairs and all internal native inference consume
their bucket. A direction budget stop retains partial checkpoints, never turns
unmeasured cases into quality zeroes, and allows the next direction to proceed.
Only completely measured candidates can become parents/winners. Actual executed
operation coverage is audited; declared nodes alone are insufficient. If an
explicit model-format failure blocks a downstream operation, its quality zero is
retained and the missing coverage is reported instead of relabeled as an executor bug.

The `exploration:false` library option is used by isolated checkpoint/prompt tests
and legacy diagnostics. The main CLI and live multi-worker validation use the policy.

## Small validation

```powershell
npm run check
npm run audit:prompts
npm run validate:drop:contract -- --data-dir DATA --output NEW_DIRECTORY --previous-run PREVIOUS_RUN
```

The small run reserves up to 100 model calls / 140,000 tokens for each search
bucket, up to three proposal attempts per direction (two repairs), 24 Search questions per
candidate once, and a separate 12-question panel twice for baseline and frozen
winner. There are four direction designs and at most five complete candidates
including baseline. The old winning definition is separately rerun on seven
known regression questions after selection; it is not admitted as a new oversized
SAMPLE candidate and cannot influence optimizer feedback.

This reuses a known diagnostic panel, not a fresh blind holdout or formal Test.
The unchanged metric can still distinguish `.5` from `0.5`. Worker coverage and
F1/cost are reported separately; using more worker types does not guarantee a higher score.
