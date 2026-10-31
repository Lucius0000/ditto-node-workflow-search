# Prompt ownership and maintenance

`optimizer-system.en.md` is the canonical cross-dataset optimizer system. Its version and expected SHA-256 are pinned in `src/unified/prompts.ts`; line endings are normalized before verification. Edits require an explicit protocol/version/hash update. Candidates cannot replace it.

Native reasoning operations have their own fixed system templates and the execution Agent's fixed contract. Different operations need not have identical text. Native parameter interpolation is audited; task instructions are not inserted into system messages. Ditto package files remain unchanged.

Candidate `instruction` fields, public tasks and output requirements are user data. The optimizer may change reusable task instructions, evidence organization, declared paths, queries and permitted criteria. It cannot rewrite the original task, scorer, system roles or permissions.

Retrieval's purpose, native schema and failure/permission semantics are fixed. A read-only host catalogue lists actual targets. User strategy can choose when to retrieve, query, `limit` and evidence consumption, but cannot expand the corpus. Retrieval need not invoke an LLM or have its own system prompt.

Each run freezes prompt versions/hashes and actual requests. Prompt, definition or helper changes create a new candidate identity requiring new evaluation. Source edits cannot alter a prior frozen run. Gold answers, private assertions and Test feedback are excluded from optimizer messages.

`npm run audit:prompts` checks these boundaries offline and makes no provider network calls.

The separate [prompt-only Search](../docs/prompt-only-search.md) uses approved `prompt-only-s0.en.md` and `prompt-only-s1.en.md` systems with an explicit editable-text manifest. These systems do not replace the legacy Graph optimizer system above. The host-owned first-visit material slot and Automation decision contract are outside that manifest.
