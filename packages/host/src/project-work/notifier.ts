/**
 * Project-work notifications (M21-T3).
 *
 * The store raises one event per committed mutation, carrying the project's
 * sequence number. This turns each into the two notifications the leap
 * defines, and it is the only place that decides when the second one is worth
 * sending:
 *
 * - `project/work/updated` — one per event, always. It carries identity and a
 *   summary, never a body, so it costs the same whether the revision was a
 *   sentence or four megabytes.
 * - `project/work/attention` — only when the "needs you" queue actually
 *   changed. A person's badge is driven by it, and a badge that repaints on
 *   every comment of a busy session is noise; a diff of the exact count and
 *   the exact item set is cheap and says something every time it is sent.
 *
 * Both are `state` in the transport-pressure table: a client that misses one
 * reconciles with `project/work/list { sinceSeq }`. Nothing here retries, and
 * nothing here queues — the sequence number in each notification is what makes
 * a missed one recoverable rather than a lost write.
 */
import type { ProjectWorkAttentionNotification, ProjectWorkChange, ProjectWorkUpdatedNotification } from "@lasercode/protocol";

export interface ProjectWorkEvent {
  projectId: string;
  seq: number;
  change: ProjectWorkChange;
}

export interface ProjectWorkNotifierOptions {
  /** What is waiting on a person in a project right now. */
  attention: (projectId: string) => ProjectWorkAttentionNotification;
  notifyUpdated: (notification: ProjectWorkUpdatedNotification) => void;
  notifyAttention: (notification: ProjectWorkAttentionNotification) => void;
  /** Reported rather than thrown: one client's failure is not a store failure. */
  log?: ((message: string) => void) | undefined;
}

export class ProjectWorkNotifier {
  private readonly options: ProjectWorkNotifierOptions;
  /** The last attention shape announced per project, as a comparable string. */
  private readonly announced = new Map<string, string>();

  constructor(options: ProjectWorkNotifierOptions) {
    this.options = options;
  }

  /** One committed store event. */
  handle(event: ProjectWorkEvent): void {
    this.send(() => this.options.notifyUpdated({ projectId: event.projectId, seq: event.seq, change: event.change }));
    const attention = this.send(() => this.options.attention(event.projectId));
    if (!attention) return;
    const shape = fingerprint(attention);
    // A project nothing has been announced for is treated as an empty queue:
    // "nothing is waiting on you" is not news, and the first change that does
    // put something in the queue is.
    if ((this.announced.get(event.projectId) ?? EMPTY_QUEUE) === shape) return;
    this.announced.set(event.projectId, shape);
    this.send(() => this.options.notifyAttention(attention));
  }

  /** A project's work was deleted or removed: start its diff again. */
  forget(projectId: string): void {
    this.announced.delete(projectId);
  }

  private send<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch (error) {
      this.options.log?.(`project work: could not announce a change: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

/**
 * What makes one attention snapshot different from another: the exact count
 * and the exact reasons, in order. Two snapshots with the same items in the
 * same states are the same thing said twice.
 */
function fingerprint(notification: ProjectWorkAttentionNotification): string {
  return `${notification.needsYou}|${notification.items.map((item) => `${item.entityId}:${item.reason}`).join(",")}`;
}

/** Nothing is waiting on anybody. */
const EMPTY_QUEUE = "0|";
