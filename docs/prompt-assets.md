# Reusable prompt assets

[简体中文](prompt-assets.zh-CN.md)

The four profiles and common construction template live in prompts/initialization. loadPromptAssets() reconstructs the selected full workflow, verifies its hash and keeps runtime guidance separate from research metadata. HumanEval/DROP retain first-task repetition; MBPP/Automation do not. This presentation setter is idempotent and does not append repeated tasks to history. Recommendations are design hypotheses, not measured benefits on every backend.

Text proposals contain parentHash, rationale and edits:[{path,value}]. The host validates exact text paths, the complete schema, immutable fields, duplicate strategies and task-ID rules, then serializes the rebuilt definition. Arbitrary patches and malformed JSON are rejected. textEditInput accepts a caller-supplied model configuration; only an explicitly created optimizer runtime can preserve structured response-format options. Execution profiles retain their fixed wire policy. Support for any chosen format must be validated on the configured service.

[Default Search, new Test and frozen export commands](recommended-search-and-test.md) describe actual reuse. Exact incremental tokens from first-task repetition are unknown without a matching tokenizer or controlled measurement; offline appearances and UTF-8 bytes are observable, not billing units.
