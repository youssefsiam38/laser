# Provenance, verification and limits

## Source identity

The study uses the actual installed `pi-subagents@0.65.1`, not a moving main branch. The [npm tarball](https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.65.1.tgz) was verified against its published SHA-512 integrity:

```text
sha512-t5Ik4pHNp/E87a36cuHpTrWaXPEQZzb2mOyZzKRuRtBXm5Z9Ht91nu9mZHrjKj83XYL3SL1kXJdmwBWqm/9fmg==
```

All 306 published files match the installed dependency byte for byte. The package registry identifies source commit [83be9c3de2cde1553c0269f383efc1eb1194dc8b](https://github.com/nicobailon/pi-subagents/tree/83be9c3de2cde1553c0269f383efc1eb1194dc8b). All 262 published TypeScript files also match that checkout. The checkout supplied 441 test/support files, including 241 `.test.ts` files, preserved separately because npm excludes them. Both collections have per-file byte counts and SHA-256 manifests. The MIT license is retained unchanged.

## Checks performed

| Check | Result |
| --- | --- |
| Published source integrity and installed comparison | 306/306 matching files |
| Published TypeScript versus exact Git checkout | 262/262 matching modules |
| AST inventory | 262 modules, 95,315 lines; symbols, imports and literal event calls indexed |
| Upstream test inventory | 241 test files; literal test/suite names indexed; support/fixture files preserved |
| Core workflow/control/reference tests | 189 passed, 1 platform-specific skip, 0 failures across 7 files |
| Workspace/evidence/retention tests | 304 passed, 0 skips, 0 failures across 9 files |
| Documentation examples | All 6 workflow JavaScript bodies parse |
| Repository identity / whitespace | `pnpm identity:check` and `git diff --check` pass |

Total: **493 passed, 1 skipped, 0 failed**. The skipped session-lease case tests operation on platforms without a native process-start probe; Linux has one. Tests exercised fake child callbacks, local file channels, isolated Git fixtures and local process/lease behavior. No provider-backed coding-agent session was launched.

Test groups:

```text
scripted-workflow, workflow-receipt, public-execution, capability-ceiling,
session-lease, control-channel, workflow-resources

worktree, worktree-cleanup-plan, workflow-detach-reconcile, pruned-fork,
child-tool-plan, acceptance, native-supervisor-channel, model-fallback,
async-retention
```

Initial test setup and the first reproduction-runner attempt selected incorrect temporary dependency locations and failed with missing dependencies. Correcting pnpm sibling dependency resolution produced the results above; no upstream source patch was applied. [check-results.json](check-results.json) records the subsequent reproducible runner's output.

## Reproduce without modifying the application

From the repository root, verify reference bytes and documentation links:

```sh
node docs/agents-leap/implementation-study/verify-source.mjs
```

Regenerate the structural source map using the repository's installed TypeScript:

```sh
node docs/agents-leap/implementation-study/build-source-map.mjs
```

Run the selected tests against an isolated copy of the preserved source using already installed dependencies:

```sh
node docs/agents-leap/implementation-study/run-source-checks.mjs
```

The runner uses Node 24, creates temporary source/config/runtime directories, copies the upstream tests into their expected layout, and removes its scratch directory afterward. It does not install packages or change the user's home configuration. After the production dependency is removed, pass an independently installed `pi-subagents@0.65.1` package directory as the runner's first argument; that installation is reference tooling only and must not be added back to production.

## Coverage is explicit

This is a source-grounded implementation study with complete structural inventories and focused semantic tracing of execution, workflows, contracts, control, persistence, worktrees and integration boundaries. Secondary UI/integration/profile modules are classified and indexed; not every line of all 95,315 lines was reviewed as a security or correctness audit. The machine map does not parse JavaScript embedded in string literals; the central workflow worker was inspected directly.

The full upstream test suite, live provider execution, external CLI/provider adapters, every operating system, packaged child startup and the new Laser runtime were **not** tested in this study. Passing reference tests proves their pinned behavior, including behavior we deliberately replace. It does not prove the proposed LEAP is already implemented or satisfy its production acceptance gates.

Active specifications were updated to D-134. Production application code/dependencies and prototype behavior were not changed by this study. Historical reference prose and upstream snapshots remain preserved as evidence, with active requirements taking precedence.
