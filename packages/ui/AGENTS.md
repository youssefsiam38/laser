# @lasercode/ui

The one web app: Electron renderer, browser tab and PWA. React, Vite,
assistant-ui and Tailwind, speaking `@lasercode/protocol` over a WebSocket.

- The built bundle in `dist/` is the artifact; nothing imports this package's
  source at runtime, which is why every browser dependency is a devDependency.
- `DESIGN.md` here is binding for anything visual, together with the UX
  documents under `docs/`.
