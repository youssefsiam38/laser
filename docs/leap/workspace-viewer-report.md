# Workspace shape in the viewer

The overlay and the telemetry Files section now ask what shape the workspace is, so they can tell "nothing changed" from "this folder is not a repository".

## Shared reader

Home: `packages/ui/src/source-control/workspace-shape.ts`.

One cache, keyed by `cwd`. Both surfaces go through it:

| Surface | How it reads |
| --- | --- |
| Overlay | `ChangesDataAdapter.getWorkspace()` (host adapter binds `pi/project/workspace` into the reader) |
| Telemetry Files | `useWorkspaceShape` in `packages/ui/src/components/telemetry/queries.ts` |

There are not two caches. A Files refresh and an overlay open of the same project share the first result.

## How often the method is called

Once per project directory. Again only on an explicit rescan (`rescan: true`): the Files refresh control. Not on a scope change, not on a re-render, not per record, not per keystroke. The host still has its own cache; the viewer does not ask it to drop that unless the person refreshed.

## Copy

| Shape | Overlay | Files |
| --- | --- | --- |
| `repo`, nothing changed | **Nothing changed.** Nothing changed in this scope. These are the changes inside this workspace. | No changes in this workspace. |
| `workspace-of-repos` or `nested-repo`, session touched none | **Nothing touched.** This workspace holds repositories, but this session has not changed any of them. | This workspace holds repositories, but this session has not changed any of them. |
| `no-git` | **No repository here.** There is no repository here, so there is nothing to compare. | There is no repository here, so this session has no files to list. |
| `bare-or-submodule` | **Not in this release.** This is a bare repository or a submodule, which this release cannot show. | This is a bare repository or a submodule, which this release cannot show. |

A repository the session never touched is still not listed. The shape only changes the empty framing and, when there is more than one resolved repository, the overlay's repository filter. One repository: no filter.

## What a person should look at first

1. Open a folder that is **not a git repository**. Overlay and Files must say there is no repository here — not "no changes".
2. Open a **workspace of repositories** this session has not touched. Same surfaces must say the session has not changed them — not "no changes". The overlay filter is present.
3. Open an ordinary **one-repo** project with a clean tree. "Nothing changed" / "No changes in this workspace." No filter.
4. Refresh Files once: `pi/project/workspace` runs again with `rescan: true`. Changing overlay scope does not.

No browser matrix. The person does visual acceptance for this leap.
