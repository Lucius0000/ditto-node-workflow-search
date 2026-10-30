# DROP public answer contract v2

The Ditto optimizer and node system templates remain frozen. This revision changes
public **user** instructions and error feedback. The pinned DROP files, split,
question text, main token-F1 scorer, model, and candidate-selection rules remain unchanged.

The contract distinguishes numeric results (ordinary decimals without redundant
trailing zeros or added unit prose), complete entity/category sets (one answer
joined with commas/and), and requested passage spans (preserve units and
hyphenation). A numeric intermediate is not necessarily the requested entity or
age-group label. Candidate instructions must not replace the public answer contract.
Intermediate nodes explicitly declaring JSON keep their JSON artifact format.

The former instruction allowing `|` between required answer spans is removed.
The existing scorer treats `|` as alternatives, not as the members of one required
set. This revision does not silently normalize predictions or inspect hidden
labels to choose an answer format. `.5` and `0.5` can therefore still receive
different scores under the unchanged main metric.

The user contract has its own version and SHA-256, recorded in optimizer requests,
baseline prompt provenance, and search configuration identity. A previous prompt
version cannot silently resume as a new search. Original task input remains intact.

Declaration failures expose `code`, `path`, `message`, and `repairHint`. For example,
an omitted generated-tool schema reports `tools[0].inputSchema`, identifies the
missing object, and explains that actual argument names and types must be declared.
These issues are retained in the rejected attempt and the next same-round repair
request. Node/binding errors identify the affected node, field or native reference.
Private scorer diagnostics and reference answers do not enter optimizer feedback.

Quality feedback uses `parentOutcome` for a previous candidate's prediction;
it does not call it a reference answer. A low F1 is an observation, not proof of
an arithmetic error. Observable public-format warnings are labeled separately.

Validation:

```powershell
npm run check
npm run audit:prompts
npm run validate:drop:contract -- --data-dir PATH_TO_PINNED_DATA --output NEW_RUN_DIRECTORY
```

The bounded live diagnostic uses 24 Search questions once, selects a workflow,
then compares it and the baseline on 12 other Search questions twice. It includes
a separate real-LLM tool-schema repair check. An optional `--previous-run DIR`
replays the old winning definition on six known diagnostic questions under the
new user contract. Those targeted results do not select candidates. Reusing this
known panel is a regression check, not a new blind holdout or formal Test result.

Supply credentials via the ignored `.env` or process environment. On Windows,
local HTTP transport tests may require `NO_PROXY=127.0.0.1,localhost` if a system
proxy intercepts loopback traffic; this is test environment setup, not a model call.
