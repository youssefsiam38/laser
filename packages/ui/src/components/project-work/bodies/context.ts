/**
 * What a body needs to know beyond its own fields (M21-T7).
 *
 * A body is rendered from the revision the detail read, so everything that
 * writes needs the fence that read carries — the entity, the exact revision
 * and the store that mints the idempotency key. `editable` is decided once,
 * in the detail: an older revision is read as it was written, and a window
 * without the capability says so rather than offering a control that fails.
 */
import type { ClientRequests, ProjectWorkListItem } from "@lasercode/protocol";

export type WorkDetailResult = ClientRequests["project/work/get"]["result"];

import type { ProjectWorkStore } from "@/project-work";

export interface WorkBodyContext {
  store: ProjectWorkStore | undefined;
  detail: WorkDetailResult;
  /** Explicit revision from navigation; absent means the moving current-view. */
  selectionRevisionId?: string | undefined;
  /** False on an older revision, on an archived item, or without the capability. */
  editable: boolean;
  /** Why editing is off, in one sentence, when it is off. */
  readOnlyReason?: string | undefined;
  /** Re-read the entity after a write. The host's answer is the truth. */
  onChanged: () => void;
  /**
   * True on the narrow, one-column path (a phone, a narrow window), where the
   * detail is a full screen reached forward from the list. The acts ride in a
   * sticky footer there instead of a toolbar the thumb cannot reach.
   */
  compact?: boolean | undefined;
  /** The rows this window already holds, for naming a key without a read. */
  items: readonly ProjectWorkListItem[];
}
