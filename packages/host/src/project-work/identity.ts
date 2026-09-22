/**
 * Which project a folder is (M21-T20, leap "Relationship graph").
 *
 * The store partitions work by a stable `projectId` and remembers the paths a
 * project has lived at. That is enough until the folder moves: a path nothing
 * has seen before mints a new, empty project, and the person's Specs, Plans and
 * Tasks appear to have vanished with the move.
 *
 * So the folder carries its own identity: one small marker in the project's
 * configuration directory (`<project>/.laser/project.json`, AGENTS.md
 * invariant 6 — never `.pi`), written the first time this app mints an id for
 * the folder, holding the opaque id and nothing else.
 *
 * What this resolver does with it, in one place for both doors (a client's
 * first `project/work/list { cwd }` and the worker bridge's own project):
 *
 * - a folder the store already knows answers with its id, and gains a marker
 *   if it has none and the folder can be written;
 * - an unknown folder whose marker names a project this store knows, whose own
 *   folder is gone, **reconnects**: that is a relocation, and it needs no
 *   question;
 * - an unknown folder whose marker names a project whose folder is *still
 *   there* is a **conflict**: two live folders claiming one history is exactly
 *   the copied-folder case the contract forbids merging silently, so this one
 *   gets its own empty project and the person is offered the choice;
 * - an unknown folder whose marker names an id this store has never heard of
 *   **adopts** that id, so the same folder keeps one identity across installs
 *   and the marker is never rewritten behind someone's back;
 * - anything else mints, exactly as before.
 *
 * Nothing here decides a merge. `relink` performs the choice a person made,
 * against the digest of the preview they made it from, and refuses to pull a
 * folder that already holds work into another project's history.
 */
import {
  ErrorCodes,
  PROJECT_DIR_NAME,
  PROJECT_MARKER_FILE,
  ProtocolError,
  parseProjectMarker,
  projectMarkerJson,
  type ProjectIdentityResult,
  type ProjectIdentitySide,
  type ProjectIdentityState,
  type ProjectRelinkChoice,
  type ProjectRelinkResult,
} from "@lasercode/protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ProjectWorkNotFoundError, ProjectWorkRefusedError } from "./errors.js";
import { canonicalJson, sha256 } from "./ids.js";
import type { ProjectWorkStore } from "./store.js";

/** Reading and writing the marker. Replaced in tests that fake a filesystem. */
export interface ProjectMarkerIo {
  read(projectRoot: string): string | undefined;
  /** True when the marker is on disk afterwards. Never throws. */
  write(projectRoot: string, projectId: string): boolean;
}

export const fileMarkerIo: ProjectMarkerIo = {
  read(projectRoot) {
    try {
      return readFileSync(join(projectRoot, PROJECT_DIR_NAME, PROJECT_MARKER_FILE), "utf8");
    } catch {
      return undefined;
    }
  },
  write(projectRoot, projectId) {
    try {
      // Never create the project folder itself: a marker is a note inside a
      // folder a person chose, not a reason to make one.
      if (!statSync(projectRoot).isDirectory()) return false;
      const dir = join(projectRoot, PROJECT_DIR_NAME);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, PROJECT_MARKER_FILE);
      const tmp = join(dir, `.${String(process.pid)}.${PROJECT_MARKER_FILE}.tmp`);
      writeFileSync(tmp, projectMarkerJson(projectId));
      renameSync(tmp, file);
      return true;
    } catch {
      // A read-only checkout, a folder on a locked volume, a sandbox: the
      // project works exactly as before, and its relocation will need the
      // person's confirmation instead of reconnecting by itself.
      return false;
    }
  },
};

export interface ProjectIdentityOptions {
  store: ProjectWorkStore;
  marker?: ProjectMarkerIo;
  /** Whether a folder is still on this machine. Injected for tests. */
  exists?: (path: string) => boolean;
}

/** What `resolve` decided, for the doors that want to know. */
export interface ResolvedProject {
  projectId: string;
  state: ProjectIdentityState;
  /** The project the marker named, when it is not this folder's own. */
  markedProjectId?: string;
  marker: boolean;
}

export class ProjectIdentity {
  private readonly store: ProjectWorkStore;
  private readonly marker: ProjectMarkerIo;
  private readonly exists: (path: string) => boolean;
  /** Projects whose folder this process has already given a marker. */
  private readonly checked = new Set<string>();

  constructor(options: ProjectIdentityOptions) {
    this.store = options.store;
    this.marker = options.marker ?? fileMarkerIo;
    this.exists = options.exists ?? ((path: string) => existsSync(path));
  }

  /** The id of the project this folder belongs to, minting only if it must. */
  projectIdFor(projectRoot: string): string {
    return this.resolve(projectRoot).projectId;
  }

  /** The same, with what was decided on the way. */
  resolve(projectRoot: string): ResolvedProject {
    const row = this.store.projectPathRow(projectRoot);
    const marked = this.markerOf(projectRoot);

    if (row?.current === true) {
      // The project's own folder. It keeps its id whatever a marker says:
      // only an explicit relink moves a folder between histories.
      if (marked !== undefined && marked !== row.projectId && this.store.hasProject(marked)) {
        // ...but a folder carrying another known project's marker is a
        // question that does not go away by being asked twice: the copy that
        // was given its own project on the first open still says where it
        // came from, and the person's answer is what settles it.
        return { projectId: row.projectId, state: "conflict", markedProjectId: marked, marker: true };
      }
      return { projectId: row.projectId, state: "linked", marker: marked !== undefined };
    }

    if (row !== undefined && marked === row.projectId) {
      // A folder the project used to be at, carrying that project's marker:
      // it was moved back. Make it current again.
      this.store.relinkProject(row.projectId, projectRoot);
      return { projectId: row.projectId, state: "linked", marker: true };
    }

    // A row that is only history decides nothing: the project has moved on,
    // and whatever is at that path now is not it unless it says so.
    if (row !== undefined) this.store.forgetProjectPath(row.projectId, projectRoot);

    if (marked !== undefined && this.store.hasProject(marked)) {
      const at = this.store.projectPaths(marked)[0];
      if (at === undefined || !this.exists(at)) {
        // The folder it used to be at is gone. This is a move, and a move
        // keeps the id: nothing is merged, because there is only one folder.
        this.store.relinkProject(marked, projectRoot);
        return { projectId: marked, state: "linked", marker: true };
      }
      // Two live folders, one marker. This one gets its own empty project so
      // the app keeps working, and the person is offered the choice.
      const fresh = this.store.projectIdFor(projectRoot)!;
      return { projectId: fresh, state: "conflict", markedProjectId: marked, marker: true };
    }

    // An unknown marker is adopted rather than overwritten; no marker mints.
    const projectId = this.store.projectIdFor(projectRoot, marked !== undefined ? { adopt: marked } : {})!;
    return { projectId, state: "linked", marker: marked !== undefined };
  }

  /**
   * This project now holds work, so the folder should say which project it
   * is (M21-T20).
   *
   * Called after a mutation rather than on every read, for one reason: until
   * a person has saved something, there is nothing a relocation could lose,
   * and Laser does not put a file in somebody's repository to prepare for a
   * move that may never happen. Once there is work, the marker is what makes
   * moving the folder keep it.
   *
   * Best effort throughout: a folder that cannot be written is not an error,
   * it is a project whose relocation will need one confirmation.
   */
  noteWork(projectId: string): void {
    if (this.checked.has(projectId)) return;
    const root = this.store.projectPaths(projectId)[0];
    if (root === undefined) return;
    const marked = this.markerOf(root);
    if (marked === projectId) {
      this.checked.add(projectId);
      return;
    }
    // A marker naming another project is never overwritten by a write: that
    // is a conflict a person resolves, not something a save repairs.
    if (marked !== undefined) return;
    if (this.marker.write(root, projectId)) this.checked.add(projectId);
  }

  /**
   * What this folder is, what it holds, and the choice it offers.
   *
   * Resolving first is deliberate: the answer describes the state the person
   * is actually in, including the empty project a conflicting folder was just
   * given, rather than a hypothetical one.
   */
  identity(projectRoot: string): ProjectIdentityResult {
    const resolved = this.resolve(projectRoot);
    const here = this.sideOf(resolved.projectId, projectRoot);
    const marked = resolved.markedProjectId !== undefined ? this.sideOf(resolved.markedProjectId) : undefined;
    const hidden = this.store.isRemoved(resolved.projectId);
    const blocked = marked !== undefined && here.entities > 0;
    // A project with work and no marker is one a move would lose. Try once to
    // give it one; a folder that cannot be written says so instead.
    if (marked === undefined && !resolved.marker && here.entities > 0) this.noteWork(resolved.projectId);
    const marker = resolved.marker || this.markerOf(projectRoot) === resolved.projectId;
    const state: ProjectIdentityState =
      marked !== undefined ? (blocked ? "blocked" : "conflict") : marker || here.entities === 0 ? "linked" : "unmarked";
    const choices: ProjectRelinkChoice[] = state === "conflict" ? ["reconnect", "fresh"] : state === "blocked" ? ["fresh"] : [];
    const facts = {
      cwd: projectRoot,
      projectId: resolved.projectId,
      state,
      here,
      ...(marked ? { marked } : {}),
      marker,
      hidden,
      choices,
    };
    return { ...facts, detail: detailFor(facts), previewDigest: sha256(canonicalJson(facts)) };
  }

  /**
   * Take one of those choices.
   *
   * `reconnect` points this folder at the project its marker names and lets go
   * of the empty one it was given; `fresh` keeps this folder's own project and
   * rewrites the marker so the question is not asked again. Both need the
   * digest of the preview they were decided from, so a folder that changed
   * underneath is refused rather than relinked to something unseen.
   */
  relink(input: { projectRoot: string; choice: ProjectRelinkChoice; projectId: string; previewDigest: string }): ProjectRelinkResult {
    const preview = this.identity(input.projectRoot);
    if (preview.previewDigest !== input.previewDigest) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "This folder changed since you were shown those two projects, so nothing was reconnected. Open it again and choose from what it says now.",
      );
    }
    if (!preview.choices.includes(input.choice)) {
      throw new ProjectWorkRefusedError(
        input.choice === "reconnect" && preview.state === "blocked"
          ? "This folder already has its own saved work, so it cannot be reconnected to the other project — that would merge two histories. Keep this folder's work, or delete it first and reconnect then."
          : "There is nothing to reconnect here: this folder is already part of the project it says it is.",
      );
    }

    if (input.choice === "fresh") {
      if (input.projectId !== preview.projectId) {
        throw new ProjectWorkRefusedError("Starting fresh keeps this folder's own project. Choose it, or reconnect to the other one.");
      }
      const marker = this.marker.write(input.projectRoot, preview.projectId);
      return {
        cwd: input.projectRoot,
        projectId: preview.projectId,
        choice: "fresh",
        marker,
        detail: marker
          ? "This folder now keeps its own project work. The other project is untouched and still open where it is."
          : "This folder keeps its own project work, but its folder could not be written, so you may be asked again next time it is opened.",
      };
    }

    const marked = preview.marked;
    if (!marked || input.projectId !== marked.projectId) {
      throw new ProjectWorkRefusedError("Reconnecting uses the project this folder came from. Choose it, or start fresh here.");
    }
    const previousProjectId = preview.projectId;
    const before = this.store.projectPaths(marked.projectId);
    // The empty project this folder was given while it was unrecognised holds
    // the folder's row, and it holds nothing else: `blocked` above is what
    // keeps a project with any work of its own from ever reaching here. It
    // goes first, so the folder is free for the project it is rejoining.
    const discardedEmpty = previousProjectId !== marked.projectId && this.store.entityCount(previousProjectId) === 0;
    if (discardedEmpty) this.store.deleteProjectWork(previousProjectId);
    this.store.relinkProject(marked.projectId, input.projectRoot);
    // The folder this one was copied from is still on disk. Leaving its row
    // would map two live folders to one history — exactly the merge the
    // contract refuses — so it stops being this project, as the choice said.
    for (const path of before) {
      if (path !== input.projectRoot && this.exists(path)) this.store.forgetProjectPath(marked.projectId, path);
    }
    this.checked.delete(previousProjectId);
    this.checked.delete(marked.projectId);
    // The folder is this project's now, and it holds its work: say so on disk
    // straight away rather than waiting for the next save.
    this.noteWork(marked.projectId);
    return {
      cwd: input.projectRoot,
      projectId: marked.projectId,
      choice: "reconnect",
      ...(previousProjectId !== marked.projectId ? { previousProjectId } : {}),
      ...(discardedEmpty ? { discardedEmpty: true } : {}),
      marker: true,
      detail: `This folder is now ${marked.name ?? "that project"}'s, with all ${String(marked.entities)} of its saved items. The folder it was open at before keeps nothing of its own.`,
    };
  }

  // ------------------------------------------------------------- internals

  private markerOf(projectRoot: string): string | undefined {
    const text = this.marker.read(projectRoot);
    return text === undefined ? undefined : parseProjectMarker(text)?.projectId;
  }


  private sideOf(projectId: string, fallbackPath?: string): ProjectIdentitySide {
    const path = this.store.projectPaths(projectId)[0] ?? fallbackPath;
    return {
      projectId,
      ...(path ? { path, name: basename(path) || path } : {}),
      pathExists: path !== undefined && this.exists(path),
      entities: this.store.hasProject(projectId) ? this.store.entityCount(projectId) : 0,
    };
  }
}

/** The sentence a person reads for each state. No jargon, no engine words. */
function detailFor(facts: {
  state: ProjectIdentityState;
  here: ProjectIdentitySide;
  marked?: ProjectIdentitySide;
  hidden: boolean;
}): string {
  const marked = facts.marked;
  const markedName = marked?.name ?? "another project";
  const markedItems = marked ? `${String(marked.entities)} saved item${marked.entities === 1 ? "" : "s"}` : "its saved work";
  switch (facts.state) {
    case "conflict":
      return `This folder was copied from ${markedName}, and that folder is still here too. Reconnect this one to continue ${markedName}'s ${markedItems} — the other folder then stops being it — or start fresh and keep the two apart.`;
    case "blocked":
      return `This folder already has its own saved work, and it was copied from ${markedName}, which still exists. The two are kept apart: reconnecting would merge two histories, so it is not offered.`;
    case "unmarked":
      return facts.hidden
        ? "This project was removed from your list. Its work is kept and hidden until you delete it. This folder could not be written to, so moving it will need your confirmation."
        : "This folder could not be written to, so if you move it you will be asked which project it is.";
    case "linked":
    default:
      return facts.hidden
        ? "This project was removed from your list. Its work is kept and hidden until you delete it; adding the project back shows it again."
        : "This folder is part of this project, and it will keep its saved work if you move it.";
  }
}

/** The refusal a folder nobody has opened yet gets, for reads that need one. */
export function unknownFolder(): ProjectWorkNotFoundError {
  return new ProjectWorkNotFoundError("That folder is not a project this app keeps work for.");
}
