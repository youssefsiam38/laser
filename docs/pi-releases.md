# Pi release notes that affect piorbit

One entry per Pi release we evaluate (MX-T1). Pin is in `packages/worker/package.json`.

| Pi version | Date seen | Breaking for us | Action |
| --- | --- | --- | --- |
| 0.85.0 | 2026-09-05 | baseline pin. Undeclared `@earendil-works/pi-server` import (see docs/upstream.md); `entry_appended` is extension-custom-entries only | `packageExtensions` patch in `pnpm-workspace.yaml` |
| 0.84.0 | 2026-09-05 (historical) | serialized `message_update` deltas-only; `getApiKeyAndHeaders` returns `string \| null`; pi-agent-core v4 session store; `RemoteSession` added | absorbed in baseline |
