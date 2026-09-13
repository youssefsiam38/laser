# The package carries only what runs

M16-T33. What the installed application contains, why every excluded file is
unreachable, and what the exclusions cost in bytes.

The rules live in `packages/desktop/electron-builder.yml.tpl` (the generated
`electron-builder.yml` is written from it by `pnpm identity:generate`), each
with the reason beside it. The gate for all of them is one command:

```bash
pnpm -F @lasercode/desktop run pack
node packages/desktop/scripts/clean-machine.mjs
```

`clean-machine.mjs` runs the packaged build the way a stranger's laptop would —
`PATH` pointing at an empty directory, a throwaway `HOME` — and requires a real
session with every bundled feature, a non-empty model list, MCP stdio tools
reaching both the model and the inspector, the agent harness modules active,
and the legal files present. "The file exists" is never the test;
AGENTS.md §5a says why.

## Two rules that bound everything below

1. **Never by file type.** A dependency's `.ts` is not a development file: the
   engine loads extensions that export TypeScript and transpiles it at runtime.
   `pi-web-access/index.ts` is that package's entry point. The packaged tree
   still carries 471 `.ts` files, and it must.
2. **Read the loader, not the name.** Every rule below names the file that would
   have to reach the excluded bytes — an `exports` map, a `require`, a resolver
   fallback — and says why it cannot.

Explicitly kept, having been looked at: `@esbuild` (11 MB, the engine's TS
loader), `es-abstract` (11 MB, reached from the es-shims graph),
`highlight.js/lib` (the engine requires one file per language), every `.node`
prebuild for this platform, and every LICENSE file.

## Before and after

Both builds are `electron-builder --dir` for linux-x64 from the same
`node_modules`, minutes apart; "before" is the configuration at `402c515`
(`packages/desktop/out-before`, built with `--config` so the two survive side by
side).

| | before | after | delta |
| --- | --- | --- | --- |
| whole unpacked directory (`du -sh -L`) | 698M | 634M | −64M |
| dependency tree (bytes) | 218,063,036 (208.0 MiB) | 158,729,028 (151.4 MiB) | −59,334,008 (−56.6 MiB, −27.2 %) |
| dependency tree (files) | 19,901 | 17,184 | −2,717 |

### Every removed byte, attributed to the rule that removed it

Computed by diffing the two trees file by file and matching each file that is in
`before` and not in `after` against the exclusion patterns.

| rule | files | MiB |
| --- | ---: | ---: |
| `recheck-jar` (JVM archive) | 3 | 22.28 |
| `pi-web-access` artwork (video + banner) | 2 | 6.11 |
| `@lasercode/*/{src,public}` | 592 | 5.14 |
| `zod/src` | 565 | 4.38 |
| `openai/src` + `@anthropic-ai/sdk/src` | 473 | 3.83 |
| `recheck/lib/browser.js` | 1 | 2.76 |
| `web-streams-polyfill` unused builds | 14 | 2.40 |
| `@google/genai` browser + condition-neutral bundles | 3 | 2.39 |
| `highlight.js/{styles,scss}` | 976 | 2.18 |
| `handlebars` AMD/browser builds | 41 | 1.80 |
| `uglify-js` | 19 | 1.19 |
| `@lasercode/*` tsconfig/tsbuildinfo/vite configs/index.html | 26 | 1.09 |
| `@mixmark-io/domino/.yarn` | 2 | 1.02 |
| **total attributed** | **2,717** | **56.59** |

A further 1,375 files (5.89 MiB) are in `before` and not in `after`, and exactly
1,375 files (5.69 MiB) are in `after` and not in `before`: the same packages at
different depths. electron-builder's tree walker nests a transitive dependency
under whichever dependant it reaches first, and that choice is not stable
between runs — `highlight.js` sits under `@narumitw/pi-tui-kit` in one build and
under `@earendil-works/pi-coding-agent` in the other. It nets to +0.2 MiB and it
is not something the exclusions did; per-package rows in the tables below carry
the same caveat, the totals above do not.

### Top 40 packages, `du -sh -L`

| before | | after | |
| ---: | --- | ---: | --- |
| 41M | `@lasercode` | 31M | `@lasercode` |
| 29M | `recheck-linux-x64` | 29M | `recheck-linux-x64` |
| 23M | `recheck-jar` | 19M | `@earendil-works` |
| 17M | `pi-web-access` | 11M | `@esbuild` |
| 17M | `@earendil-works` | 11M | `es-abstract` |
| 11M | `@narumitw` | 8.8M | `pi-web-access` |
| 11M | `@esbuild` | 7.0M | `pi-mcp-adapter` |
| 11M | `es-abstract` | 6.1M | `typebox` |
| 8.5M | `openai` | 5.7M | `defuddle` |
| 7.1M | `zod` | 5.5M | `openai` |
| 7.1M | `@anthropic-ai` | 5.4M | `highlight.js` |
| 7.0M | `pi-mcp-adapter` | 4.7M | `@modelcontextprotocol` |
| 6.1M | `typebox` | 4.7M | `@anthropic-ai` |
| 5.6M | `recheck` | 3.7M | `@smithy` |
| 4.8M | `@google` | 3.5M | `zod` |
| 4.7M | `@modelcontextprotocol` | 3.3M | `@aws-sdk` |
| 3.7M | `@smithy` | 3.1M | `@napi-rs` |
| 3.3M | `@aws-sdk` | 2.8M | `recheck` |
| 3.1M | `@napi-rs` | 2.5M | `@noble` |
| 3.0M | `handlebars` | 2.4M | `temml` |
| 2.7M | `web-streams-polyfill` | 2.4M | `@google` |
| 2.6M | `highlight.js` | 2.1M | `@silvia-odwyer` |
| 2.5M | `@noble` | 1.7M | `unpdf` |
| 2.4M | `temml` | 1.7M | `linkedom` |
| 2.1M | `@silvia-odwyer` | 1.7M | `jiti` |
| 2.1M | `defuddle` | 1.6M | `undici` |
| 1.8M | `@mixmark-io` | 1.6M | `@mariozechner` |
| 1.7M | `unpdf` | 1.6M | `fs-native-extensions` |
| 1.7M | `jiti` | 1.5M | `ajv` |
| 1.6M | `undici` | 1.4M | `protobufjs` |
| 1.6M | `@mariozechner` | 1.1M | `yaml` |
| 1.6M | `linkedom` | 1.1M | `handlebars` |
| 1.6M | `fs-native-extensions` | 1.1M | `@babel` |
| 1.5M | `ajv` | 812K | `@narumitw` |
| 1.4M | `protobufjs` | 740K | `neo-async` |
| 1.3M | `uglify-js` | 704K | `@mixmark-io` |
| 1.1M | `yaml` | 628K | `json-schema-to-ts` |
| 1.1M | `@babel` | 600K | `@radix-ui` |
| 740K | `neo-async` | 596K | `lru-cache` |
| 644K | `htmlparser2` | 548K | `source-map` |

### `@lasercode/*`, `du -sh -L`

| package | before | after |
| --- | ---: | ---: |
| `ui` | 21M | 17M |
| `pi-extension` | 6.9M | 6.3M |
| `worker` | 6.1M | 4.7M |
| `protocol` | 5.3M | 2.6M |
| `host` | 1.1M | 520K |
| `cli` | 800K | 368K |
| `crypto` | 300K | 124K |
| `pi-goal` | 80K | 28K |

Our own packages are linked, not published, so each one carries its TypeScript
beside its build output. Everything resolves through `exports`/`main`/`bin` into
`dist/`: the host serves `@lasercode/ui/dist` (`defaultUiDir` in
`packages/host/src/server.ts` requires `dist/index.html` to exist), and the
worker imports `@lasercode/pi-extension` as a module, so the engine loads that
package's `dist` and never its source. `public/` is vite's input, copied into
`dist/` at build time. `*.map` was already excluded, so the sources cannot even
serve a debugger. `@lasercode/protocol` halves largely because its own bundled
copy of `zod` loses `src/` along with the top-level one (1.63 MiB of the
2.7 MiB it drops).

## The proofs

**`recheck-jar`, 22.28 MiB.** The MCP adapter refuses a regex search over tool
names unless it can prove the pattern safe, with `checkSync` (`proxy-modes.ts`
:741, parameters at :32 — `attackTimeout` 50, `incubationTimeout` 50, `timeout`
250). `recheck/lib/main.js` runs that call in a synckit worker by default, which
takes the `auto` path: the native `recheck-<os>-<arch>` binary, then `java -jar`
this archive, then the pure-JS engine compiled into `main.js` itself. The jar's
path comes from `require.resolve("recheck-jar/package.json")` inside a
try/catch that returns `null` on `MODULE_NOT_FOUND`, so removing the package is
a fallthrough. recheck 4.5.0's `optionalDependencies` publish binaries for
linux-x64, macos-x64, macos-arm64 and windows-x64 only — on our two arm64
targets the pure engine is already the answer for anyone without a JVM.

Measured in the packaged build, empty `PATH`, the adapter's own parameters, on
the three cases `^(a|a)*$`, `get_.*_tool` and `^[a-z]+(foo|bar)?$`:

| backend | verdicts | ms |
| --- | --- | --- |
| default (native binding present) | vulnerable, vulnerable, safe | 90, 27, 6 |
| `RECHECK_SYNC_BACKEND=pure` | vulnerable, vulnerable, safe | 67, 111, 17 |
| default with `recheck-linux-x64` renamed away | vulnerable, vulnerable, safe | 211, 135, 14 |

The third row is the arm64 situation reproduced on this machine: no native
binding, no archive, no `java` on `PATH`. Same verdicts, still inside the
250 ms analysis budget, and the whole clean-machine gate passed in that state.
`clean-machine.mjs` now runs the first two rows on every packaged build and
requires them to agree, so a change that leaves the guard unable to answer —
which would reject every regex search a person makes — fails here instead of on
their machine. The native binary is the first choice and stays.

**`recheck/lib/browser.js`, 2.76 MiB.** A second copy of the same engine,
reached only through the package's `browser` field, which Node's resolver does
not implement and no bundler runs here.

**`pi-web-access` artwork, 6.11 MiB.** `banner.png` and
`pi-web-fetch-demo.mp4`. They appear nowhere but that package's `files` list and
a `pi.video` field that is a github.com URL, not this copy. Its engine entry is
`pi.extensions: ["./index.ts"]`, which stays. Named file by file: an extension
may legitimately ship an image it serves.

`pi-mcp-adapter`'s own 1.1 MB banner is deliberately **not** excluded.
`scripts/check-mcp-artifact.mjs` requires every non-Markdown entry of that
package's published `files` to exist, because that list is how its lazily loaded
OAuth and script-mode assets are protected. Excluding the banner failed the
gate, and a megabyte is not worth teaching a gate to make exceptions.

**`zod/src`, `openai/src`, `@anthropic-ai/sdk/src`, 8.21 MiB.** Published
sources beside built output whose `exports` do not map them:
`require.resolve("zod/src/index.ts")` inside the packaged tree throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`. zod lists `./src/*.ts` only under its opt-in
`@zod/source` condition, which nothing sets; the two SDKs publish
`files: ["**/*"]` and build to sibling directories, and none of their shipped
JavaScript references `../src/`. These are sources beside output, not the
executable source packages §5a is about — those export their `.ts` entry point.

**`highlight.js/{styles,scss}`, 2.18 MiB.** Stylesheets for a browser. The only
importer of highlight.js here is the engine, and it requires
`highlight.js/lib/…`; no file in the tree names `highlight.js/styles`, and no
Node process can execute a stylesheet.

**`handlebars` AMD and browser builds, 1.80 MiB.** `require("handlebars")`
resolves to `lib/index.js`, which requires `../dist/cjs/handlebars` — that
directory stays. `dist/amd/**` and the concatenated `dist/handlebars*.js` are
the script-tag and RequireJS builds of the same code.

**`uglify-js`, 1.19 MiB.** An *optional* dependency of handlebars, required from
one file: `lib/precompiler.js` (and its `dist/cjs` twin), the implementation
behind `bin/handlebars --min`. That file calls `require.resolve('uglify-js')`
first and, on `MODULE_NOT_FOUND`, prints "Code minimization is disabled due to
missing uglify-js dependency" and carries on. The only importer of handlebars
in the tree is `@lasercode/protocol`'s instruction templates, which call
`Handlebars.compile` through `lib/index.js`. Nothing here runs the CLI.

**`@google/genai` browser and neutral bundles, 2.39 MiB.** The `exports` for
`"."` lists `browser` first, then `node`, then a bare default; Node never sets
`browser`, so the specifier always lands in `dist/node/`. Proved in the packaged
tree with the bundled Node and an empty `PATH`, from the file that imports it
(`@earendil-works/pi-ai/dist/api/google-generative-ai.js`):

```
require.resolve('@google/genai')     → …/@google/genai/dist/node/index.cjs
import.meta.resolve('@google/genai') → …/@google/genai/dist/node/index.mjs
import.meta.resolve('@google/genai/node') → …/@google/genai/dist/node/index.mjs
```

`@google/genai` and `@google/genai/node` are the only two specifiers any file in
the tree uses. `dist/node`, `dist/tokenizer` and `dist/vertex_internal` stay.

**`web-streams-polyfill` unused builds, 2.40 MiB.** Fourteen of its fifteen
`dist` files. The package has no `exports`, so the proof is its importers: one
file in the whole packaged tree names it — `fetch-blob/streams.cjs` requires
`web-streams-polyfill/dist/ponyfill.es2018.js`, and only inside
`if (!globalThis.ReadableStream)`, false on every Node we ship. Nothing imports
the package root, so `main` is unreachable too. That one required file stays.

**`@mixmark-io/domino/.yarn`, 1.02 MiB.** A Yarn plugin release published inside
the package by accident; domino's `main` is `./lib`.

## Looked at and refused

| candidate | MiB | why it stays |
| --- | ---: | --- |
| `.d.mts` / `.d.cts` declarations across the tree (2,813 files, 7.08 MiB) | 7.08 | electron-builder's default list already drops `*.d.ts`, and declarations cannot execute — but this would be an exclusion *by extension* over ~2,800 files in packages nobody has read, which is exactly the shape of failure §5a is about. It needs a per-package reading, not a glob. |
| `pi-mcp-adapter/banner.png` | 1.1 | `check-mcp-artifact.mjs` enforces that package's published `files` list; see above. |
| three copies of `@napi-rs/keyring-linux-x64-gnu` | 5.8 | Nested because three packages depend on different versions. Deduplicating is a dependency-graph change, not a packaging one, and the adapter's gate asserts it resolves *its own* copy. |
| `recheck-linux-x64` | 28.5 | The checker's first choice, and the reason the default path is fast. |
| `temml/src`, `defuddle/dist/index.full.js`, `linkedom/{cjs,esm,worker.js}` | ~2.5 | All reachable: temml exports `"./*"`, defuddle exports `./full` and `./node` (and `defuddle/node` is imported here), linkedom's conditions cover both module systems. |
| `@esbuild`, `es-abstract`, `highlight.js/lib`, every `.ts` in a dependency, LICENSE files | — | Named as keep-outs by the task, and each is on a live path. |

## What was measured, and how to repeat it

`out-before/` is not in `.gitignore`, and `scripts/identity/check.mjs` reads
untracked non-ignored files: leaving a baseline build inside the checkout fails
the identity gate on `linux-unpacked/laser`. Move it out (this one now lives in
`/tmp/perf-packaging/out-before`) or delete it before running `pnpm verify`.

```bash
# before, at 402c515's configuration, into out-before/
git show 402c515:packages/desktop/electron-builder.yml > /tmp/eb-before.yml   # then set directories.output: out-before
cd packages/desktop && npx electron-builder --dir --config /tmp/eb-before.yml

# after
pnpm -F @lasercode/desktop run pack

# the gate, and the sizes
node packages/desktop/scripts/clean-machine.mjs
du -sh -L packages/desktop/out{,-before}/linux-unpacked
cd packages/desktop/out/linux-unpacked/resources/app.asar.unpacked/node_modules && du -sh -L */ @*/*/ | sort -rh | head -40
```

The rename experiment behind the third row of the recheck table:

```bash
cd packages/desktop/out/linux-unpacked/resources/app.asar.unpacked/node_modules
mv recheck-linux-x64 recheck-linux-x64.disabled
node ../../../../../scripts/clean-machine.mjs   # every claim still held
mv recheck-linux-x64.disabled recheck-linux-x64
```
