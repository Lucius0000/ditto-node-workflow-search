# Selected workflows in Search and Test

[简体中文](recommended-search-and-test.zh-CN.md)

New HumanEval, MBPP, DROP and AutomationBench runs use the selected complete workflow, its instructions and first-task presentation by default. Search also supplies the dataset guidance to the optimizer as user data. Other datasets retain the original initialization. Model configuration remains the team's existing CODE_SOUL_* configuration; strategies do not select a backend. Historical Search observations do not establish performance on a different backend.

Use Node 24+, npm 11+, the Python environment pinned by requirements-provider.txt, and Docker for code grading. Set DITTO_PROVIDER_PYTHON to that environment and build with npm.cmd ci followed by npm.cmd run build.

## New Search

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js search --dataset drop --data-dir data/datasets --output-dir runs/drop-search --request-timeout-ms 180000 --workflow-timeout-ms 300000 --offline-only true
~~~

Remove --offline-only true only after the actual evaluation scope and budget are agreed. Search keeps the current main branch's protected worker directions, isolated direction budgets, full-definition/Graph mutation protocol, five-repeat allocation and selection. Manifest identity and optimizer requests retain both the exploration policy and dataset initialization. This initialization is not a new Graph comparison or the separate text-replacement protocol. For an explicit historical baseline comparison, use --initialization baseline on a new Search. --user-prompt-file cannot silently replace the selected seed; use the historical baseline option with an intentional override.

## New Test without running Search first

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js test --dataset drop --data-dir data/datasets --output-dir runs/drop-test --request-timeout-ms 180000 --workflow-timeout-ms 300000 --offline-only true
~~~

Without --run-dir, Test first writes the selected full definition to a fresh frozen run, then reads Test data. No optimizer or Search is run. The preflight checks data and identities without creating a provider. Remove --offline-only true only when holdout evaluation is authorized; Test uses three repeats. The output directory must be new. With no --output-dir, a timestamped directory is created under runs/selected-test/<dataset>.

## Existing frozen workflows and generic exports

~~~powershell
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js test --dataset drop --run-dir runs/existing-search --data-dir data/datasets
node --experimental-vm-modules --env-file-if-exists=.env dist/unified/cli.js freeze --dataset drop --workflow-file selected-workflow.json --output-dir runs/exported --request-timeout-ms 180000 --workflow-timeout-ms 300000
~~~

An existing --run-dir always uses its frozen definition. Search --resume true --run-dir reads the saved initialization and keeps its recorded identity; a new default cannot replace it. Older schema-v1 artifacts retain their original strict runtime checks and may require their recorded checkout. Exporting a selected workflow does not fabricate a new Search result.

The portable workflow file contains exactly dataset, id, definition and source. Source contains protocol, candidateId, revision, recordHash and definitionHash; the selected ID and complete graph hash must match. It contains selection provenance, not local account information. The new frozen artifact records the actual configured execution model/endpoint/generation separately from strategy provenance.

New frozen selections retain full-source and execution-compatibility hashes. The named frozen-initialization-assets-v1 policy excludes only the four dataset JSON files and strategy-template.json already represented by the frozen definition and asset hashes. All execution source, compiled code, other prompts, native templates, environment, model, data/scoring and resource contracts remain checked. Test never reloads current initialization JSON. Missing/extra fields, unknown policies or incompatible identities fail before dispatch.

Formal Automation additionally freezes the official source revision/lock/clean state, scoring Python package/module fingerprint, bridge and scorer contract; Test checks it before data/provider creation. Configure DITTO_AUTOMATION_ROOT and DITTO_AUTOMATION_PYTHON for the verified official installation. Freeze does not start a world or read holdout.

Engineering checks use --engineering-fixture with at most eight explicitly synthetic tasks and a dummy HTTP server on 127.0.0.1. They use actual CLI and SDK paths without official data or real model calls; synthetic outcomes are not Test conclusions. The fixture scoring identity cannot satisfy a formal contract.
