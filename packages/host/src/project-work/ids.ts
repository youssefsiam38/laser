/**
 * Opaque identity and canonical bytes for the project-work store (M21-T2).
 *
 * Three small, pure things the rest of the store rests on:
 *
 * - **Ids are minted, never derived from anything a person can read.** A
 *   project id says nothing about a path; an entity id says nothing about a
 *   key; a blob id says nothing about its content. They are random, bounded
 *   and match the protocol's `OPAQUE_ID_PATTERN`.
 * - **A revision's digest covers its canonical bytes.** Canonical JSON sorts
 *   object keys, so the same body always digests to the same value whatever
 *   order it arrived in, and an approval can fence exactly what it approved.
 * - **A repository's identity survives its checkout.** The key is the
 *   repository's root commit when git can supply one, and the resolved common
 *   directory when it cannot — so a worktree shares its owner's identity and a
 *   relocated project keeps the id it already had.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

/** 16 URL-safe characters of randomness: 96 bits, and no separator to parse. */
function mintSuffix(): string {
  return randomBytes(12).toString("base64url");
}

export function mintProjectId(): string {
  return `prj_${mintSuffix()}`;
}

export function mintEntityId(): string {
  return `wk_${mintSuffix()}`;
}

export function mintRevisionId(): string {
  return `rev_${mintSuffix()}`;
}

export function mintLinkId(): string {
  return `lnk_${mintSuffix()}`;
}

export function mintCommentId(): string {
  return `cm_${mintSuffix()}`;
}

export function mintApprovalId(): string {
  return `apv_${mintSuffix()}`;
}

export function mintEvidenceId(): string {
  return `ev_${mintSuffix()}`;
}

export function mintDecisionId(): string {
  return `dec_${mintSuffix()}`;
}

export function mintBlobId(): string {
  return `blb_${mintSuffix()}`;
}

/** One immutable link-to-capture association (D-363). */
export function mintCaptureRevisionId(): string {
  return `rlc_${mintSuffix()}`;
}

/** One immutable decision-to-capture binding (D-363). */
export function mintProofBindingId(): string {
  return `dcb_${mintSuffix()}`;
}

export function mintRepositoryId(): string {
  return `repo_${mintSuffix()}`;
}

/**
 * JSON with every object's keys in sorted order.
 *
 * Deliberately not `JSON.stringify` with a replacer: arrays keep their order
 * (it is data), objects do not (it is not), and `undefined` members are
 * dropped exactly as `JSON.stringify` drops them, so a body that omits an
 * optional field and one that sets it to `undefined` are the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) continue;
    out[key] = canonicalise(member);
  }
  return out;
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The digest a revision is addressed by: sha256 of its canonical body bytes. */
export function bodyDigest(body: unknown): { digest: string; bytes: number; canonical: string } {
  const canonical = canonicalJson(body);
  return { digest: sha256(canonical), bytes: Buffer.byteLength(canonical, "utf8"), canonical };
}

export interface RepositoryIdentityInput {
  /**
   * The repository's git common directory, already resolved. A linked worktree
   * resolves to its owner's, which is what makes a worktree share the owner's
   * repository identity (`docs/source-control-leap.md`, "Workspace shapes").
   */
  gitCommonDir: string;
  /**
   * The repository's root commit object id, when git could supply one. It is
   * the only identity that survives moving the checkout to another path.
   */
  rootCommitId?: string | undefined;
}

/**
 * The stable key a repository is recognised by.
 *
 * With a root commit, the key is that commit: the same repository cloned,
 * moved or opened through a worktree answers with the same key. Without one (a
 * repository with no commits yet), the key is the resolved common directory —
 * stable for as long as the directory is, and replaced by the commit-derived
 * key as soon as the repository has a commit and something re-registers it.
 */
export function repositoryIdentityKey(input: RepositoryIdentityInput): string {
  if (input.rootCommitId && /^[0-9a-f]{7,64}$/.test(input.rootCommitId)) {
    return `commit:${sha256(input.rootCommitId)}`;
  }
  return `dir:${sha256(resolve(input.gitCommonDir))}`;
}
