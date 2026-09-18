# Settings scope audit

Audited revision: `8183fd04b380f7dee7e11006669e92b9c24d5b0c`

## Decision summary

Settings needs one explicit, shared scope:

```ts
type SettingsScopeState =
  | { view: "global"; projectCwd?: undefined }
  | { view: "project" | "effective"; projectCwd: string };
```

It is a Settings navigation choice, not a derivative of the open conversation, the Code destination, a session, the first project, a worker, or a setup workspace.

- Persist it per device and per environment through `runtime/device-storage.ts`.
- Default to `{ view: "global" }` when no valid persisted value exists.
- A project is required only for `project` and `effective`; never pick one implicitly.
- `effective` is always read-only.
- Session-oriented surfaces, including Logs and Start chat, remain project-aware and outside this setting-scope contract.

### Audit totals

- **15 ambient-project read sites** under the counting rule below.
- **7 ambient-derived WRITE-target families** today.
- **Most dangerous read:** `AgentsScreen.tsx:110`, where the ambient Workbench `cwd` becomes `projectCwd`. That value filters which definition is edited and is copied into a new agent's immutable `AgentDefinitionInput.projectCwd`; `AgentStore` then derives the file path from it. A change of the open project can therefore change an agent draft's eventual disk target without a Settings scope decision.

“Read site” here means one user-visible load or projection whose project identity comes from the Workbench ambient `cwd`. Repeated uses of that value inside one flow, such as MCP inspect after MCP list, are one site. This avoids inflating the count with dependency arrays and prop forwarding while retaining every distinct behavior.

“WRITE-target family” means one family of mutations that receives, embeds, or is selected through that ambient identity. It is not a count of buttons or RPC calls.

## How scope works today

### Ambient source and fallback chain

`components/workbench/Workbench.tsx:39-45` reads `currentProject` from `useLaserStable()`, reads the current session's `cwd`, and computes:

```ts
const cwd = currentProject ?? sessionCwd;
```

It passes the result to Settings, Agents, and Logs at lines 90-94. This makes one value mean three different things:

1. **Code destination** — `currentProject` is `mainCodeProject(state.destination)` (`runtime/LaserProvider.tsx:611`).
2. **Conversation location** — if no Code destination exists, the selected session supplies `cwd`.
3. **Settings target or worker route** — Settings and Agents receive the same value despite having independent scope semantics.

There is another implicit fallback before this chain: `LaserProvider.tsx:1880-1885` defaults Code memory to `projects[0]`. Consequently, merely having a first known project can become the Settings target.

`SettingsScreen.tsx:151` adds a fourth meaning. For several globally usable tabs, ambient project wins; otherwise it falls back to `pi/setup/state.cwd`:

```ts
project ?? (GLOBAL_THROUGH_SETUP.includes(shownTab) ? setupCwd : undefined)
```

That setup directory is useful as a worker execution route, but it is not a Settings project selection.

### Local scope controls are not shared

- General and Advanced configuration instantiate `SettingsForm`, which owns `view` locally and defaults it to `global` (`SettingsForm.tsx:50`). Its project picker calls `setCurrentProject` (`SettingsForm.tsx:106-114`), changing the app's Code destination rather than Settings-owned state.
- Features owns a second local scope, also defaulting to `global` (`FeaturesScreen.tsx:23`). It has no Effective view.
- Agents has no top-level Global/Project/Effective selector. It derives an effective project catalog from ambient `cwd`.
- MCP scope is primarily an item/filter concern inside a catalog already loaded for an ambient project.
- Models chooses some write scopes from where a value currently happens to exist (`settings/model.ts:294-297`), not from a visible Settings scope.

The result is exactly the product-owner complaint: a project chosen inside General mutates the application project, other tabs receive that mutation indirectly, and some tabs continue to use their own unrelated scope state.

## Ambient-project read inventory (15)

| # | Surface and evidence | Meaning and fallback today | Required disposition |
|---:|---|---|---|
| 1 | General + Advanced engine snapshot — `SettingsScreen.tsx:151-167` | Ambient project, else setup workspace on eligible tabs; reads global, project, and effective values for that directory. | Use shared scope. Global may use a neutral route but must not display a project's overlay; Project/Effective use only `scope.projectCwd`. |
| 2 | General + Advanced model/provider pickers — `SettingsForm.tsx:63-68` | Uses the same ambient `cwd` to obtain connected models/providers even while the form's local view is Global. | Route independently. Project-sensitive offering must use selected scope; account/provider state must be labelled global. |
| 3 | Features — `FeaturesScreen.tsx:26,31` | `feature/list(cwd)` returns effective feature state for ambient project; no cwd returns global/default. Worker recovery notice also follows ambient cwd. | Global sends no project; Project/Effective send selected project. Recovery is operational and must name its project rather than borrow scope silently. |
| 4 | MCP catalog and inspector chain — `McpServersTab.tsx:55`, then its dialogs/inspector | `mcp/list` means “both scopes for this project”; inspect, ping, auth, run, and disconnect inherit the same ambient route. | Global lists global definitions only; Project lists selected-project definitions with explicit inherited context; Effective resolves selected project read-only. Separate route from target in the protocol. |
| 5 | MCP import discovery — `McpServersTab.tsx:74` | Detects import sources through the ambient worker, even in a nominally global workflow. | Discovery route must be explicit and target-neutral; applying an import uses the shared scope and selected project only when Project is selected. |
| 6 | Providers and models — `ModelsTab.tsx:130-133` | Provider credentials, model catalog, and dictation status are read through ambient cwd; model effective values come from that project's settings snapshot. | Label credentials/dictation global. Model settings obey shared Global/Project/Effective. Do not infer a write target from effective provenance. |
| 7 | Web Search — `WebSearchTab.tsx:40` | Reads connection status, providers, and effective feature state through ambient cwd. | Connections are global/account state; feature state obeys shared scope. Any connection test route must be explicit and must not select a project. |
| 8 | Help and shortcuts — `KeyboardTab.tsx:229-253` | Keybindings are global, but a project worker is required solely as a transport route; without cwd the UI refuses to load them. | Scope-independent global surface. Remove cwd from the public contract or use a named neutral route internally. |
| 9 | Projects — `ProjectsTab.tsx:23-28,99` | Ambient project is only sorted first and expanded by default. Every actual status read names each row's own cwd. | Remove ambient preference. This is an all-project collection; row identity is already explicit. |
| 10 | Agents effective list/warnings — `AgentsScreen.tsx:110-119,168` | Ambient cwd selects project shadowing, warnings, counts, and the definition behind a name. Beam/Chat workspace cwd is rejected as a project. | Adopt shared Global/Project/Effective semantics; never use current/session cwd. |
| 11 | Agent editor model and feature availability — `AgentEditor.tsx:244-246`, `use-page-data.ts:71-103` | `routeCwd = cwd ?? snapshot.workspaces.beam`; model/providers and Web Search feature state therefore use ambient project or Beam. | Existing definition/draft scope supplies project context; Global uses an explicit neutral route. Effective is read-only. |
| 12 | Agent skills — `AgentEditor.tsx:520-523`, `use-page-data.ts:107-110` | Skills listing follows `routeCwd`, not the definition's fixed location or an explicit Settings project. | Global edit shows global skills; Project edit shows the selected project's effective skill catalog and writes the fixed selected project into the definition. |
| 13 | Agent engine instructions — `AgentEditor.tsx:393`, `use-page-data.ts:112-116` | Default instructions are fetched through ambient/Beam route. | Route explicitly; never let a project switch change text under a dirty draft. |
| 14 | Built-in agent model and Namer checks — `BuiltinPanel.tsx:228,256,313-319` | Uses ambient route, then Beam/Chat workspace fallback. Built-in configuration itself is global. | Keep configuration global and label it so; use a neutral execution route. Qualification can name an explicitly chosen project as an operation, not inherit one. |
| 15 | Logs project filter — `LogsScreen.tsx:85-92` | The optional “this project” filter follows Workbench ambient cwd. | **Keep project-aware, but decouple from Settings scope.** Logs is session/operation data; its filter should name the current conversation/project and remain a separate control. |

Not counted as ambient reads:

- Appearance has no cwd and uses the theme store.
- Usage is account-wide read-only telemetry.
- Trust iterates all project records; every decision names its row cwd.
- Device settings and Advanced resource diagnostics are device/host-wide.
- Projects status reads use each row's own cwd.

## Ambient-derived WRITE targets (7)

| # | Family | Current target selection | Risk / required rule |
|---:|---|---|---|
| 1 | Engine settings (`pi/settings/set`) | `SettingsScreen.cwd` plus the local `SettingsForm` view selects global settings or `<cwd>/.laser/settings.json`. | Use shared view; Effective disables writes. Global route must not imply a project target. |
| 2 | Features (`feature/set`) | Local Features scope plus ambient cwd. `router.ts:877` additionally falls back to `this.pool.cwds()[0]` to test Web Search. | Shared view only. Delete the first-worker fallback; testing must have an explicit route or host-owned implementation. |
| 3 | Web Search connection configuration (`web-search/configure`) | Ambient worker cwd, although connection data and the feature's global toggle are not the selected project's settings. | Split operational route from feature scope; never treat an arbitrary worker as a selected project. |
| 4 | MCP definitions, imports, auth, and policy (`mcp/save`, `remove`, `import/apply`, `auth/*`) | Item scope is explicit, but all operations inherit ambient cwd and `mcp/list` is already project-effective. | Mutations carry explicit `{scope, projectCwd?}` and a separate execution route if still required. Effective is read-only. |
| 5 | Provider credentials (`pi/providers/login/*`, `logout`) | Global credential work is routed through ambient cwd (`ProviderStep.tsx:68,95,139`). | Make it scope-independent. A route is implementation detail, not Settings target. |
| 6 | Keybindings (`pi/keybindings/set`) | Global file, ambient worker route (`KeyboardTab.tsx:253`; worker comment confirms workers share the file). | Public API should be global and cwd-free, or use a stable neutral route hidden from the UI. |
| 7 | Agent definitions (`agents/save` and name-based delete) | New Project scope copies ambient `projectCwd` (`AgentEditor.tsx:150`); host path is derived from input (`host/src/agents/store.ts:627-632`). Selection before edit is also ambient-effective. | Save and delete must carry immutable definition identity. No draft is ever retargeted by a scope/project change. |

The two model-list writes in `ModelsTab` belong to family 1 but deserve specific correction: `settingsListScope()` writes to Project when an effective value currently exists there and otherwise to Global. That is provenance-based write targeting. Replace it with the shared explicit view; Effective cannot invoke it.

### Agent deletion needs a protocol fix

`agents/delete` accepts only `{name}`. `AgentStore.delete()` checks the global definition first, then accepts a project definition only if exactly one project matches (`host/src/agents/store.ts:268-277`). In a selected project's effective list, a project definition can shadow a global definition with the same name, yet deleting by name can select the global definition. Scope UI alone cannot make that safe.

Change delete to identify the stored definition, for example:

```ts
{ name: string, scope: "global" | "project", projectCwd?: string }
```

The same location identity should accompany `originalName` during validate/save rename. This prevents ambiguity when the same name exists globally or in several projects.

## Shared persisted state

### Home

Add one environment-scoped key to `DEVICE_KEYS` in `runtime/device-storage.ts`, for example `settingsScope: "settings-scope"`. Store only validated versioned data:

```ts
interface StoredSettingsScopeV1 {
  v: 1;
  view: "global" | "project" | "effective";
  projectCwd?: string;
}
```

The runtime already provides the required properties:

- device-local persistence;
- environment namespace isolation;
- no read before the environment descriptor is active;
- purge/invalidation behavior on environment changes;
- one typed vocabulary instead of ad hoc `localStorage` keys.

Create one small Settings-scope store/provider beside the Workbench runtime and expose `{scope, requestScopeChange}` to both `SettingsScreen` and `AgentsScreen`. `SettingsForm` and `FeaturesScreen` must stop owning local scope. Do not reuse `DEVICE_KEYS.project`: that key remembers the Code destination and would preserve the coupling this change is meant to remove.

### Validation and missing projects

- Invalid/corrupt/missing persisted data => Global.
- Persisted Project/Effective without `projectCwd` => Global.
- Persisted project no longer in the known project catalog => retain the value long enough to show “Project is no longer available”; offer an explicit project choice or Global. Do not substitute `projects[0]`, current project, session cwd, setup cwd, or Beam workspace.
- Changing the app's current project while Settings is open must not change this state or trigger scoped reloads.
- The setup workspace may remain an internal worker route, never `scope.projectCwd` and never visible as the selected project.

## Deep links

Today Workbench persists only ephemeral page targets:

- Settings: a tab string (`workbench-context.tsx:20,39,68-74`).
- Agents: `{agent, field}` (`workbench-context.tsx:28-31`).

Neither target carries scope. Lifting the existing local state without changing these contracts leaves warning links and credential-fix links ambiguous.

Use structured targets:

```ts
interface SettingsTarget {
  tab?: SettingsTab;
  scope?: SettingsScopeState;
}

interface AgentsTarget {
  agent: string;
  field?: string;
  scope?: SettingsScopeState;
  definition?: { scope: "global" | "project"; projectCwd?: string };
}
```

Rules:

1. Explicit deep-link scope wins, after dirty-draft confirmation.
2. A target without scope uses the persisted Settings scope; it never infers current/session/first project.
3. An agent warning/refusal should include the definition's location when known. A name-only target resolves only within the current explicit view; ambiguity produces a choice/error, not fallback.
4. Repeating the same target still creates a fresh target object so focus/scroll behavior remains intact.
5. Closing and reopening Workbench preserves persisted scope; changing environments rehydrates that environment's scope.

## Agent editor behavior

### Global

- List built-ins and global custom definitions only. Project definitions do not appear as editable Global entries.
- New agent writes Global; no project is copied into the draft.
- Existing global definitions remain fixed Global.
- Default-agent, harness policy, and built-in controls remain global and are labelled as such.

### Project

- Requires the explicitly selected `projectCwd`.
- Show project definitions as editable. Show inherited global definitions as context, visually distinct and read-only, with an explicit **Override for this project** action that creates a new project draft anchored to this project.
- A new agent writes only to the selected project.
- If a project definition shadows a global one, show both provenance and ensure edit/delete acts on the project identity.
- Global-only actions such as Make default are unavailable for project definitions.

### Effective

- Requires the explicitly selected `projectCwd`.
- Show exactly the resolved catalog the selected project would use: project shadows global, built-ins remain visible.
- Entire surface is read-only, including delete, default, built-in, and harness controls.
- An **Edit source** action may explicitly switch to Global or Project and select the concrete definition. It is a scope change, not an in-place write from Effective.

### Dirty drafts

A draft must carry a stable target established when opened:

```ts
{
  kind: "new" | "existing";
  location: { scope: "global" } | { scope: "project"; projectCwd: string };
  originalName?: string;
  baseRevision?: number;
}
```

While dirty, any scope/project/deep-link change opens one blocking decision:

- **Save and switch** — save to the draft's anchored location, then change scope only after success.
- **Discard and switch** — discard, then change.
- **Keep editing** — cancel the scope change.

Never mutate the draft's `projectCwd` because the shared selector changed. A newly created unsaved draft follows the same rule. Environment changes should discard only through the existing environment-transition safety path; they must not re-home a draft.

## Tab-by-tab target behavior

| Tab / screen | Shared scope behavior |
|---|---|
| General | Full Global / Project / Effective. This becomes the reference implementation. |
| Advanced · Configuration | Same shared state and semantics as General; no second selector. |
| Advanced · Resources | Host-wide diagnostics. Selector remains visible for continuity but is marked not applicable/disabled for this subview; it must not filter resources. |
| Appearance | Device/installation preference. Scope-independent; never reads project. |
| Features | Full Global / Project / Effective. Replace its private two-way selector. Effective is read-only. |
| MCP servers | Full Global / Project / Effective with explicit provenance. Effective is read-only. Requires protocol separation of route and target. |
| Providers and models | Provider auth/dictation are global; model configuration follows shared scope. Effective is read-only. Do not choose scope from current value provenance. |
| Usage | Account-wide, read-only, scope-independent. |
| Help and shortcuts | Global file, scope-independent. Remove the visible/project requirement caused by worker routing. |
| Projects | All-project collection. Each row is its own explicit target; shared scope does not reorder or auto-expand it. |
| Trust | All-project collection. Each row is its own explicit target. |
| This device | Device or host-wide controls, scope-independent. |
| Agents | Full Global / Project / Effective as specified above; shares the persisted state with Settings. |
| Logs | Not Settings scope. Preserve its separate current-project filter because entries describe sessions and runs. |

A single selector may remain in the Settings/Agents shell while scope-independent tabs are open, but it must clearly say “Not used on this tab” rather than imply that appearance, usage, trust, or device controls were retargeted.

## Protocol implications

1. **Separate target from route.** Several worker APIs require `cwd` to choose a process even when storage is global. Public request shapes should distinguish `projectCwd` (semantic target) from an internal `routeCwd`, or move global reads/writes to the host. A field named only `cwd` must not continue to mean both.
2. **Remove arbitrary fallbacks.** `feature/set` Web Search testing must not use `this.pool.cwds()[0]` (`host/src/router.ts:877`). Likewise, UI code must not use setup/Beam/current/session cwd as a target. Named neutral workspaces may be routes only.
3. **Make agent identity location-aware.** Extend delete and rename/original identity with scope/project location. `agents/save` already carries target location inside `AgentDefinitionInput`; preserve that explicitness and validate it against the selected source.
4. **Add explicit view where list semantics differ.** MCP currently defines `mcp/list` as “both scopes for this project” (`protocol/src/mcp.ts:519`). It needs Global-only, Project-source, and Effective projections, either via a view parameter or separate host projection. Features can already express Global by omitting cwd, but its response contract should make requested view unambiguous.
5. **Keep schema/router evidence complete.** Any changed method needs protocol schema round-trip samples, method inventory coverage, host router tests, and worker/host integration proving the exact target path.

## Staged migration and tests

### Stage 1 — state authority, no behavior migration

- Add the validated `deviceStore` key and one shared scope store/provider.
- Default Global; test persistence, corrupt data, environment switch, unavailable project, and no `projects[0]`/current/session fallback.
- Extend Workbench deep-link targets with optional explicit scope while preserving fresh-object focus behavior.

### Stage 2 — engine settings and Features

- Move General, Advanced Configuration, and Features onto shared state; remove local selectors and `setCurrentProject` coupling.
- Test every Global/Project/Effective read, Effective write refusal, project switching, stale replies, trust refusal, and model-list writes using explicit scope.
- Host test Web Search enablement with no worker, one worker, and several workers; prove no first-worker selection.

### Stage 3 — MCP, models, keyboard, and global routed services

- Introduce route/target protocol separation, then migrate MCP, provider auth, Web Search connections, model catalog, dictation, and keybindings.
- Assert exact request payloads and exact backing files for Global and Project; assert scope-independent tabs do not change requests when shared scope changes.
- Keep Projects/Trust row-target tests and remove ambient sort/expansion assumptions.

### Stage 4 — Agents and acceptance

- Add location-aware agent delete/rename contracts; migrate list projections and editor anchoring.
- Regression tests: global/project name collision, project shadowing, same name in multiple projects, new draft, existing dirty draft, failed save before switch, explicit deep link, legacy name-only deep link, removed selected project, and current-session/project changes while editing.
- Browser acceptance at desktop and phone widths, dark and light themes, pointer and keyboard: scope selector, project picker, Effective read-only state, dirty-draft dialog, deep-link focus, and no layout/scroll loss.

## Acceptance criteria

- Opening Settings for the first time shows Global regardless of open project/session and regardless of project ordering.
- Changing current conversation or Code project never changes Settings scope.
- One selector controls every scope-capable Settings/Agents surface; no tab owns a second scope state.
- Every mutation's target is visible before activation and is present explicitly in its request/domain input.
- Effective never writes.
- Dirty agent drafts cannot be silently discarded or retargeted.
- Global agents cannot be deleted/renamed through a project-shadow row, and project agents cannot be deleted/renamed by ambiguous name-only identity.
- Scope-independent and session-oriented surfaces retain their correct domain semantics instead of being forced into project scope.
