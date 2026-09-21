/**
 * The machine-readable half of an export (M21-T21).
 *
 * The manifest is what makes an export more than a folder of Markdown: stable
 * ids, the exact revision each document was rendered from with its digest, the
 * relations between them, the repository links (including every `published_as`
 * already recorded), and a reference to every attachment.
 *
 * It carries **no timestamps at all**. An export of unchanged work must be
 * byte-identical to the one before it — otherwise a re-export is a diff nobody
 * can read and a round trip cannot be proved — and a clock is the one thing
 * that would make every export differ. What time something happened is in the
 * store, which stays the authority; the manifest says what it *is*.
 *
 * Attachment **bytes** are not copied out either. A sketch or a capture can be
 * megabytes; the manifest records the blob's id, media type, size and digest,
 * so an export stays a readable document set and the content-addressed bytes
 * stay where they are addressed from.
 */
import {
  PRODUCT_NAME,
  WORK_MANIFEST_FORMAT,
  WORK_MANIFEST_VERSION,
  type ProjectWorkBody,
  type ProjectWorkEdge,
  type ProjectWorkEntity,
  type ProjectWorkManifest,
  type ProjectWorkRevision,
  type RepositoryLink,
  type WorkManifestAttachment,
  type WorkManifestEntity,
  type WorkManifestRelation,
  type WorkManifestRepositoryLink,
} from "@lasercode/protocol";

import { canonicalJson } from "../ids.js";

export interface ManifestEntityInput {
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  body: ProjectWorkBody;
  edges: ProjectWorkEdge[];
  repositoryLinks: RepositoryLink[];
  document: string;
  bodyPath: string;
}

/** Where a blob is referenced from, so an attachment row can name the field. */
export interface AttachmentRef {
  blobId: string;
  key: string;
  field: string;
}

/**
 * Every blob one body points at.
 *
 * Bodies are closed schemas, so this is an enumeration rather than a walk: a
 * new field that carries a blob is a change here too, which is the point —
 * an attachment nobody listed is an attachment an export silently dropped.
 */
export function attachmentsOf(key: string, body: ProjectWorkBody): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  if (body.kind !== "design") return refs;
  const design = body.design;
  for (const sketch of design.sketches) refs.push({ blobId: sketch.blobId, key, field: `sketch:${sketch.id}` });
  if (design.foundation?.tokensBlobId) refs.push({ blobId: design.foundation.tokensBlobId, key, field: "foundation.tokens" });
  for (const fixture of design.fixtures) {
    if (fixture.blobId) refs.push({ blobId: fixture.blobId, key, field: `fixture:${fixture.id}` });
  }
  const host = design.hostPage;
  if (host) {
    if (host.referenceBlobId) refs.push({ blobId: host.referenceBlobId, key, field: "hostPage.reference" });
    for (const [index, reference] of (host.references ?? []).entries()) {
      if (reference.blobId) refs.push({ blobId: reference.blobId, key, field: `hostPage.reference.${String(index)}` });
    }
  }
  return refs;
}

/**
 * Build the manifest from the entities an export covers.
 *
 * Ordering is by key number inside kind, exactly as the documents are written,
 * and every list is sorted by something stable — never by the order rows came
 * back from a query.
 */
export function buildManifest(input: {
  projectId: string;
  entities: ManifestEntityInput[];
  attachments: WorkManifestAttachment[];
}): ProjectWorkManifest {
  const exported = new Set(input.entities.map((item) => item.entity.entityId));
  const relations: WorkManifestRelation[] = [];
  const seenEdges = new Set<string>();
  const repositoryLinks: WorkManifestRepositoryLink[] = [];
  const seenLinks = new Set<string>();

  for (const item of input.entities) {
    for (const edge of item.edges) {
      // An edge is one fact, and both ends carry it. Only edges wholly inside
      // the export are written: half of a relation is worse than none.
      if (!exported.has(edge.subject.entityId) || !exported.has(edge.object.entityId)) continue;
      if (seenEdges.has(edge.linkId)) continue;
      seenEdges.add(edge.linkId);
      relations.push({
        relation: edge.relation,
        subject: { entityId: edge.subject.entityId, key: edge.subject.key, revisionId: edge.subject.revisionId },
        object: { entityId: edge.object.entityId, key: edge.object.key, revisionId: edge.object.revisionId },
        ...(edge.note !== undefined ? { note: edge.note } : {}),
      });
    }
    for (const link of item.repositoryLinks) {
      if (seenLinks.has(link.linkId)) continue;
      seenLinks.add(link.linkId);
      repositoryLinks.push({
        linkId: link.linkId,
        relation: link.relation,
        repositoryId: link.repositoryId,
        subject: { entityId: link.subject.entityId, key: link.subject.key, revisionId: link.subject.revisionId },
        target: link.target,
        ...(link.publishedPath !== undefined ? { publishedPath: link.publishedPath } : {}),
      });
    }
  }

  const entities: WorkManifestEntity[] = input.entities.map((item) => ({
    entityId: item.entity.entityId,
    key: item.entity.key,
    kind: item.entity.kind,
    title: item.entity.title,
    state: item.entity.state,
    archived: item.entity.archivedAt !== undefined,
    revisionId: item.revision.revisionId,
    revisionIndex: item.revision.index,
    digest: item.revision.digest,
    bodyBytes: item.revision.bodyBytes,
    document: item.document,
    body: item.bodyPath,
  }));

  return {
    format: WORK_MANIFEST_FORMAT,
    version: WORK_MANIFEST_VERSION,
    product: PRODUCT_NAME,
    project: { projectId: input.projectId },
    entities,
    relations: relations.sort(byRelation),
    repositoryLinks: repositoryLinks.sort((a, b) => compare(`${a.subject.key}\u0000${a.relation}\u0000${a.linkId}`, `${b.subject.key}\u0000${b.relation}\u0000${b.linkId}`)),
    attachments: [...input.attachments].sort((a, b) => compare(`${a.key}\u0000${a.field}\u0000${a.blobId}`, `${b.key}\u0000${b.field}\u0000${b.blobId}`)),
  };
}

function byRelation(a: WorkManifestRelation, b: WorkManifestRelation): number {
  return compare(`${a.subject.key}\u0000${a.relation}\u0000${a.object.key}`, `${b.subject.key}\u0000${b.relation}\u0000${b.object.key}`);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The manifest's bytes: canonical JSON, indented for a diff, one trailing
 * newline. `canonicalJson` sorts object keys, so the same manifest is always
 * the same bytes whatever order this file happened to build it in.
 */
export function manifestBytes(manifest: ProjectWorkManifest): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2)}\n`;
}
