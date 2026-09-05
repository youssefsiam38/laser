# @lasercode/ui

The one web app: Electron renderer, browser tab, and PWA. It speaks
`@lasercode/protocol` over a WebSocket to `@lasercode/host` and renders Pi sessions
through [assistant-ui](https://assistant-ui.com) 0.15.

The visual and interaction contract is **[DESIGN.md](./DESIGN.md)** — colors,
type, layout, status vocabulary, motion. Any deviation needs a `D-<n>` decision
in `../../STATUS_DETAILED.md`.

## Structure

```
src/
  main.tsx            entry; imports globals.css
  App.tsx             <LaserProvider><Shell/></LaserProvider>
  globals.css         Tailwind v4 entry: DESIGN.md tokens, @theme inline, base layer, utilities
  client.ts           HostClient — JSON-RPC over WebSocket, reconnect
  store.ts            AppState + reducer: sessions, open views, blocks, dialogs, toasts
  format.ts           relative time, byte/token/duration/percent formatting, shortcut labels
  lib/utils.ts        cn()
  hooks/              use-theme, use-mobile, use-keyboard-inset, use-copy
  runtime/            the assistant-ui seam (see below)
  components/
    ui/               Radix-flavored primitives (button, dialog, sheet, popover, menu, …)
    status/           StatusDot, StatusRing, the shared status vocabulary
    shell/            Rail · Sessions · TopBar · Telemetry · History · toasts · layout + keys
    thread/           Thread · messages · MarkdownText · ToolRow · Composer · dialogs · queue
test/                 vitest; pure modules only (no DOM tests yet)
```

`@/*` is aliased to `src/*` (vite, tsconfig, vitest). Relative imports of
`.ts`/`.tsx` files use `.js` specifiers, per the repo convention.

## The runtime layer (`src/runtime/`)

Everything assistant-ui touches lives here; import it from the barrel
`@/runtime`. Four modules, three of them pure and unit-tested:

| Module | Role |
| --- | --- |
| `projection.ts` | `SessionView` → `ThreadMessageLike[]`. Splits extension dialogs into tool-attached (`approval` / `interrupt`) and free-standing; notices become a `data` part named `laser-notice`. |
| `threadList.ts` | Session catalog → `RemoteThreadListAdapter`. Attention-first ordering, local-only archive, rename; `delete` throws by design (laser never deletes Pi sessions). |
| `adapter.ts` | Per-session `ExternalStoreAdapter`: send routing, queue lanes, composer key plan, approval/interrupt answers, image attachments. |
| `LaserProvider.tsx` | The one stateful shell: `HostClient` + reducer + `useRemoteThreadListRuntime`. Exposes `useLaser`, `useSessionMeta`, `useHostUiRequests`, `useExtensionUi`, `useToasts`. |

Send routing (`resolveSendBehavior`) — assistant-ui routes every composer send
through the queue adapter, so both lanes funnel into one place:

| lane | idle | running |
| --- | --- | --- |
| queue (Enter idle, Cmd/Ctrl+Enter) | `session/prompt` | `pi/session/follow_up` |
| steer (Enter while running) | `session/prompt` | `pi/session/steer` |

Thread selection is two-way and loop-guarded: sidebar → assistant-ui through the
controlled `threadId` prop, assistant-ui → laser through `onThreadIdChange`
plus a `threads.selectionChanged` listener, both no-ops when the id already
matches `state.current`.

## Running it

Build everything once (`@lasercode/host` serves `packages/ui/dist`):

```bash
pnpm -r build
```

**Sandbox** — a temp Pi agent dir with a fake streaming provider, serving the
built UI. Nothing touches `~/.pi/agent`.

```bash
node scripts/sandbox.mjs            # http://127.0.0.1:41441
PORT=41442 node scripts/sandbox.mjs
```

**Dev server** — Vite with HMR, proxying `/ws` to a host on `127.0.0.1:41441`.
Start the sandbox (or a real host) on that port first, then:

```bash
pnpm -F @lasercode/ui dev             # http://127.0.0.1:5173
```

**Checks**

```bash
pnpm -F @lasercode/ui typecheck
pnpm -F @lasercode/ui test
pnpm -F @lasercode/ui build
```

## Invariants

- Transcript text is never rendered as HTML: no `rehype-raw`, no
  `dangerouslySetInnerHTML`. Agent output is untrusted data (AGENTS.md §4.9).
- No color outside the DESIGN.md tokens. Components use the Tailwind names
  mapped in `globals.css` (`bg-surface`, `text-ink-2`, `border-line`, `live`,
  `attention`, `danger`, `ok`), never raw hex.
- Both themes are defined on the tokens; `.dark` on `<html>` is set pre-paint by
  a script in `index.html` from `localStorage["laser-theme"]`.
- Nothing here imports Pi. The UI speaks only `@lasercode/protocol`.
