/**
 * The project-work database: opening it, and moving it between versions (M21-T2).
 *
 * The same engine the log store uses — `node:sqlite` through `createRequire`,
 * WAL, owner-only file modes — with three rules this store adds because it
 * holds canonical work rather than diagnostics:
 *
 * - **Migrations are atomic and versioned.** Each step and the `user_version`
 *   bump that records it happen inside one transaction, so a process that dies
 *   between statements leaves the database at the version it was.
 * - **A migration takes a backup first.** Canonical revisions and approvals are
 *   not reproducible; a failed migration must leave the person something to go
 *   back to, next to the database and named after the version it came from.
 * - **A newer database is refused, not reshaped.** If a later release wrote it,
 *   this one says so in a sentence a person can act on and touches nothing.
 *
 * Partitioning is by `projectId` on every row, not by file. One database keeps
 * cross-project mention search, one global quota and one migration story; a
 * file per project would make the search the leap requires a fan-out over
 * every project a person has ever opened.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { ProjectWorkUnavailableError } from "./errors.js";

/** The shape of the tables this file owns. Bump with a migration step. */
export const PROJECT_WORK_SCHEMA_VERSION = 5;

export interface ProjectWorkDatabase {
  exec(sql: string): void;
  prepare(sql: string): ProjectWorkStatement;
  close(): void;
}

export interface ProjectWorkStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export function openProjectWorkDatabase(file: string, log: (message: string) => void): ProjectWorkDatabase {
  let DatabaseSync: new (path: string) => ProjectWorkDatabase;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => ProjectWorkDatabase;
    });
  } catch (error) {
    throw new ProjectWorkUnavailableError(
      `This Node (${process.version}) cannot open a database, so ${PRODUCT_DISPLAY_NAME} cannot keep project work. ` +
        `Run it on Node 22.5 or newer. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") {
    // A Spec is a person's own work, and a Research body may quote a private
    // source. Owner-only, like the log store's file.
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* not created yet, or a filesystem without modes */
      }
    }
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // A bounded page cache: a large design body is megabytes, and the store must
  // not grow this process with the rate of writes.
  db.exec("PRAGMA cache_size = -4000;");
  db.exec("PRAGMA journal_size_limit = 8388608;");
  migrate(db, file, log);
  return db;
}

function hasTables(db: ProjectWorkDatabase): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number } | undefined;
  return Number(row?.n ?? 0) > 0;
}

function userVersion(db: ProjectWorkDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === "number" ? value : 0;
}

/**
 * Bring the database to {@link PROJECT_WORK_SCHEMA_VERSION}, one atomic step
 * at a time, having copied the file first.
 */
export function migrate(db: ProjectWorkDatabase, file: string, log: (message: string) => void): { from: number; to: number } {
  const from = userVersion(db);
  if (from > PROJECT_WORK_SCHEMA_VERSION) {
    throw new ProjectWorkUnavailableError(
      `This project work database was written by a newer version of ${PRODUCT_DISPLAY_NAME} (format ${from}; this one understands ${PROJECT_WORK_SCHEMA_VERSION}). ` +
        `Update ${PRODUCT_DISPLAY_NAME} to open it. Nothing has been changed.`,
    );
  }
  if (from === PROJECT_WORK_SCHEMA_VERSION) return { from, to: from };
  // A database that already holds tables holds somebody's work, whatever its
  // version says. Canonical revisions and approvals are not reproducible, so
  // the copy is taken before the first statement of the first step.
  if (hasTables(db) && file !== ":memory:" && existsSync(file)) {
    const backup = `${file}.v${from}.backup`;
    try {
      // Checkpoint first: the backup must include what the WAL is holding.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(file, backup);
      log(`project work: copied the database to ${backup} before upgrading it from format ${from}.`);
    } catch (error) {
      throw new ProjectWorkUnavailableError(
        `${PRODUCT_DISPLAY_NAME} could not copy your project work database before upgrading it ` +
          `(${error instanceof Error ? error.message : String(error)}). Free some disk space and start again; nothing has been changed.`,
      );
    }
  }
  for (let version = from; version < PROJECT_WORK_SCHEMA_VERSION; version++) {
    transaction(db, () => {
      step(db, version);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return { from, to: userVersion(db) };
}

function step(db: ProjectWorkDatabase, from: number): void {
  if (from === 4) {
    // D-363. Which capture a decision actually consumed. The association
    // history says which proof was current when; this says which of those a
    // person's approval or a Task's completion was taken on — written inside
    // the decision's own transaction, from the associations the gate really
    // read, so a later correction of the link's pointer cannot retroactively
    // become what somebody decided on.
    //
    // Two tables, because "this decision rested on nothing" and "this store
    // does not know what this decision rested on" are different facts and
    // only one of them may ever be inferred: a set row records that a decision
    // was bound at all, including when it bound nothing, and a decision older
    // than this history has no set row and stays honestly unknown. Nothing is
    // backfilled: there is no record of what an older decision consumed, and
    // inventing one would be exactly the fabricated history D-363 forbids.
    db.exec(`
      CREATE TABLE decision_capture_binding_sets (
        project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        decision_kind TEXT NOT NULL,
        decision_id   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        bindings      INTEGER NOT NULL,
        bound_at      TEXT NOT NULL,
        PRIMARY KEY (project_id, decision_kind, decision_id)
      );

      CREATE TABLE decision_capture_bindings (
        binding_id              TEXT PRIMARY KEY,
        project_id              TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        decision_kind           TEXT NOT NULL,
        decision_id             TEXT NOT NULL,
        entity_id               TEXT NOT NULL,
        link_id                 TEXT NOT NULL,
        blob_id                 TEXT NOT NULL,
        association_revision_id TEXT NOT NULL,
        association_seq         INTEGER NOT NULL,
        bound_at                TEXT NOT NULL,
        UNIQUE (project_id, decision_kind, decision_id, link_id)
      );
      CREATE INDEX decision_capture_bindings_entity ON decision_capture_bindings(project_id, entity_id, decision_kind, decision_id);
      CREATE INDEX decision_capture_bindings_link ON decision_capture_bindings(project_id, link_id);
    `);
    return;
  }
  if (from === 3) {
    // D-363. Which capture proved a repository link, and when. The link's
    // `capture_blob_id` stays exactly what it was — the current pointer every
    // reader already uses — and this table is the append-only history behind
    // it: one row per association, never updated, never deleted, so that a
    // decision can be read against the proof it actually rested on rather than
    // against whatever the pointer says today.
    //
    // The backfill is a **baseline**, and says so: for a link that already has
    // a capture, the one association this database can honestly attest is the
    // one it currently holds. No earlier association is invented, and a link
    // with no capture gets no row at all.
    db.exec(`
      CREATE TABLE repository_link_captures (
        revision_id            TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        link_id                TEXT NOT NULL,
        blob_id                TEXT NOT NULL,
        supersedes_blob_id     TEXT,
        supersedes_revision_id TEXT,
        attached_at            TEXT NOT NULL,
        seq                    INTEGER NOT NULL,
        reason                 TEXT NOT NULL,
        gate                   TEXT,
        actor_json             TEXT NOT NULL,
        UNIQUE (project_id, link_id, seq)
      );
      CREATE INDEX repository_link_captures_link ON repository_link_captures(project_id, link_id, seq);

      INSERT INTO repository_link_captures
        (revision_id, project_id, link_id, blob_id, supersedes_blob_id, supersedes_revision_id, attached_at, seq, reason, gate, actor_json)
      SELECT
        'rlc_legacy_' || link_id,
        project_id,
        link_id,
        capture_blob_id,
        NULL,
        NULL,
        created_at,
        1,
        'legacy_baseline',
        NULL,
        created_by_json
      FROM repository_links
      WHERE capture_blob_id IS NOT NULL;
    `);
    return;
  }
  if (from === 2) {
    // M21-T19 / D-361. What the host proved when a person accepted a state as
    // native visual evidence: the ref it really found, the commit that ref
    // really pointed at, and the revision digest the acceptance was about. A
    // column on the link it belongs to, because it is one row's fact and it is
    // read every time that link is.
    db.exec(`
      ALTER TABLE repository_links ADD COLUMN acceptance_json TEXT;
    `);
    return;
  }
  if (from === 1) {
    // M21-T18. What an attempt did in each repository, read from git at record
    // time, and the session whose checkpoint refs it was read from; plus the
    // display context (branch, remote, pull request) a repository link is read
    // *by* and never identified by. Columns rather than tables: every one of
    // them belongs to exactly one row of the link it hangs off, and a JSON
    // column keeps the bounded record together with the link it describes.
    db.exec(`
      ALTER TABLE execution_links ADD COLUMN repositories_json TEXT;
      ALTER TABLE execution_links ADD COLUMN checkpoint_key TEXT;
      ALTER TABLE repository_links ADD COLUMN display_json TEXT;
      ALTER TABLE repository_links ADD COLUMN execution_link_id TEXT;
    `);
    return;
  }
  if (from === 0) {
    db.exec(`
      -- Identity. A project is an id; the paths it has lived at are rows that
      -- point at it, so relocation reconnects and never merges two histories.
      CREATE TABLE projects (
        project_id   TEXT PRIMARY KEY,
        created_at   TEXT NOT NULL,
        seq          INTEGER NOT NULL DEFAULT 0,
        removed_at   TEXT,
        bytes        INTEGER NOT NULL DEFAULT 0,
        entity_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE project_paths (
        path       TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        current    INTEGER NOT NULL DEFAULT 1,
        seen_at    TEXT NOT NULL
      );
      CREATE INDEX project_paths_project ON project_paths(project_id);

      CREATE TABLE repositories (
        repository_id TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        identity_key  TEXT NOT NULL,
        name          TEXT NOT NULL,
        last_dir      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE (project_id, identity_key)
      );

      -- Per-project, per-kind monotonic key allocation (D-355). The number is
      -- taken inside the same transaction as the entity that gets it, and it
      -- is never decremented, so a key is never reused or renumbered.
      CREATE TABLE key_sequences (
        project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        next_number INTEGER NOT NULL,
        PRIMARY KEY (project_id, kind)
      );

      CREATE TABLE entities (
        entity_id            TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        kind                 TEXT NOT NULL,
        key                  TEXT NOT NULL,
        key_number           INTEGER NOT NULL,
        title                TEXT NOT NULL,
        state                TEXT NOT NULL,
        state_before_archive TEXT,
        current_revision_id  TEXT NOT NULL,
        current_digest       TEXT NOT NULL,
        revision_count       INTEGER NOT NULL,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        -- The project event sequence of the change that last touched this row.
        -- It is the store's own monotonic clock, so "newest first" is exact
        -- even for two items written inside the same millisecond.
        updated_seq          INTEGER NOT NULL DEFAULT 0,
        archived_at          TEXT,
        stale_json           TEXT,
        blocking_comments    INTEGER NOT NULL DEFAULT 0,
        needs_attention      INTEGER NOT NULL DEFAULT 0,
        UNIQUE (project_id, key)
      );
      CREATE INDEX entities_project_updated ON entities(project_id, updated_seq DESC);
      CREATE INDEX entities_project_kind ON entities(project_id, kind);

      -- Revisions are immutable: nothing ever updates a row in this table.
      CREATE TABLE revisions (
        revision_id        TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id          TEXT NOT NULL,
        kind               TEXT NOT NULL,
        idx                INTEGER NOT NULL,
        parent_revision_id TEXT,
        title              TEXT NOT NULL,
        digest             TEXT NOT NULL,
        body_bytes         INTEGER NOT NULL,
        body               TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        origin_json        TEXT NOT NULL,
        state              TEXT NOT NULL,
        note               TEXT,
        UNIQUE (entity_id, idx)
      );
      CREATE INDEX revisions_entity ON revisions(entity_id, idx DESC);

      CREATE TABLE edges (
        link_id         TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        relation        TEXT NOT NULL,
        subject_entity  TEXT NOT NULL,
        subject_revision TEXT NOT NULL,
        object_entity   TEXT NOT NULL,
        object_revision TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        origin_json     TEXT NOT NULL,
        note            TEXT
      );
      CREATE INDEX edges_subject ON edges(project_id, subject_entity);
      CREATE INDEX edges_object ON edges(project_id, object_entity);

      CREATE TABLE repository_links (
        link_id            TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id          TEXT NOT NULL,
        revision_id        TEXT NOT NULL,
        relation           TEXT NOT NULL,
        repository_id      TEXT NOT NULL,
        subject_json       TEXT NOT NULL,
        target_json        TEXT NOT NULL,
        published_path     TEXT,
        created_by_json    TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        supersedes_link_id TEXT,
        source_unavailable INTEGER NOT NULL DEFAULT 0,
        capture_blob_id    TEXT
      );
      CREATE INDEX repository_links_entity ON repository_links(project_id, entity_id);

      CREATE TABLE execution_links (
        link_id              TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id            TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        target_id            TEXT NOT NULL,
        attempt              INTEGER NOT NULL,
        profile_id           TEXT,
        branch               TEXT,
        repository_id        TEXT,
        base_commit          TEXT,
        started_at           TEXT NOT NULL,
        ended_at             TEXT,
        outcome              TEXT,
        target_unavailable   INTEGER NOT NULL DEFAULT 0,
        created_by_json      TEXT NOT NULL
      );
      CREATE INDEX execution_links_entity ON execution_links(project_id, entity_id);

      CREATE TABLE comments (
        comment_id        TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id         TEXT NOT NULL,
        revision_id       TEXT NOT NULL,
        anchor_json       TEXT NOT NULL,
        text              TEXT NOT NULL,
        state             TEXT NOT NULL,
        blocking          INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        origin_json       TEXT NOT NULL,
        addressed_at      TEXT,
        resolved_at       TEXT,
        orphaned          INTEGER NOT NULL DEFAULT 0,
        parent_comment_id TEXT
      );
      CREATE INDEX comments_entity ON comments(project_id, entity_id);

      CREATE TABLE approvals (
        approval_id    TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id      TEXT NOT NULL,
        gate           TEXT NOT NULL,
        decision       TEXT NOT NULL,
        covers_json    TEXT NOT NULL,
        mode           TEXT,
        skip_reason    TEXT,
        note           TEXT,
        at             TEXT NOT NULL,
        origin_json    TEXT NOT NULL,
        invalidated_at TEXT
      );
      CREATE INDEX approvals_entity ON approvals(project_id, entity_id);

      CREATE TABLE decisions (
        decision_id            TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id              TEXT NOT NULL,
        revision_id            TEXT NOT NULL,
        title                  TEXT NOT NULL,
        rationale              TEXT NOT NULL,
        consequences_json      TEXT NOT NULL,
        at                     TEXT NOT NULL,
        origin_json            TEXT NOT NULL,
        supersedes_decision_id TEXT
      );
      CREATE INDEX decisions_entity ON decisions(project_id, entity_id);

      CREATE TABLE evidence (
        evidence_id        TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id          TEXT NOT NULL,
        revision_id        TEXT NOT NULL,
        kind               TEXT NOT NULL,
        role               TEXT NOT NULL,
        summary            TEXT NOT NULL,
        detail             TEXT,
        blob_id            TEXT,
        outcome            TEXT NOT NULL,
        at                 TEXT NOT NULL,
        origin_json        TEXT NOT NULL,
        repository_link_id TEXT
      );
      CREATE INDEX evidence_entity ON evidence(project_id, entity_id);

      -- Content-addressed blobs: length, media type and sha256, deduplicated
      -- per project, chunked above a megabyte so a ranged read never has to
      -- materialise the whole thing.
      CREATE TABLE blobs (
        blob_id    TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        entity_id  TEXT,
        digest     TEXT NOT NULL,
        media_type TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        chunked    INTEGER NOT NULL DEFAULT 0,
        data       BLOB,
        created_at TEXT NOT NULL,
        released   TEXT,
        UNIQUE (project_id, digest)
      );
      CREATE TABLE blob_chunks (
        blob_id TEXT NOT NULL,
        idx     INTEGER NOT NULL,
        bytes   INTEGER NOT NULL,
        sha256  TEXT NOT NULL,
        data    BLOB NOT NULL,
        PRIMARY KEY (blob_id, idx)
      );

      -- The project's event stream. project_seq is monotonic per project and
      -- is what a client reconciles with.
      CREATE TABLE events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        project_seq INTEGER NOT NULL,
        at          TEXT NOT NULL,
        change_json TEXT NOT NULL,
        UNIQUE (project_id, project_seq)
      );

      -- The same idempotency key answers with the first result, for ever.
      CREATE TABLE idempotency (
        project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        method       TEXT NOT NULL,
        key          TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        at           TEXT NOT NULL,
        PRIMARY KEY (project_id, method, key)
      );

      -- The value-only search projection: titles, keys and the text a person
      -- typed. Never binary, never a digest, never a path.
      CREATE TABLE search_projection (
        entity_id   TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        key         TEXT NOT NULL,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        values_text TEXT NOT NULL
      );
      CREATE INDEX search_projection_project ON search_projection(project_id);
    `);
    return;
  }
}

/** One statement group, or none of it. */
export function transaction<T>(db: ProjectWorkDatabase, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already gone; the original failure is the one that matters */
    }
    throw error;
  }
}
