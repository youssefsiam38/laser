# @lasercode/pi-extension

The one companion Pi extension, loaded into every session the worker starts.
Allowed to import Pi.

- One module per supported capability under `src/modules/*`. Adding support
  for a package means adding a module, never adding a package.
- Modules never import each other, detect what they need at `session_start`,
  and fail individually — reported to the UI, never fatal to the session.
- It translates engine capabilities into engine-neutral protocol data. It
  ships no presentation and declares no surface.
