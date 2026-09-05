/**
 * Native notifications for sessions that want you (M5-T4).
 *
 * The rule: a notification is an interruption, so it has to be worth one. Three
 * gates, in this order:
 *
 *   1. Only an *edge* into a state that needs a person — `shouldNotify` in
 *      fleet.ts. A reconnect re-lists every session; that is not news.
 *   2. Not while you are already looking. If the app window is focused, the UI
 *      is already showing the same thing better than a system banner can.
 *   3. Not twice for the same session inside a short window, and never more
 *      than a handful at once — an agent that fails in a loop must not be able
 *      to bury the desktop.
 *
 * Clicking one deep-links to the session, which is the whole point: the
 * notification is a door, not an announcement.
 */
import { Notification } from "electron";
import type { SessionAttention } from "@lasercode/protocol";
import type { DeepLink } from "./api.js";
import type { AttentionChange } from "./fleet.js";
import { shouldNotify } from "./fleet.js";
import type { DesktopLog } from "./log.js";
import { baseName, plainText } from "./text.js";

/** The same session cannot notify twice inside this window. */
const REPEAT_WINDOW_MS = 30_000;
/** A burst bigger than this is a runaway, not news. */
const BURST_LIMIT = 4;
const BURST_WINDOW_MS = 10_000;

interface Copy {
  title: string;
  body: string;
}

/**
 * What a person actually needs to read, per state. No stack traces, no method
 * names, and the project first because that is how people hold several agents
 * in their head.
 */
function copyFor(change: AttentionChange): Copy | undefined {
  const project = plainText(baseName(change.session.cwd), 40);
  const session = plainText(change.session.name ?? "Untitled session", 60);
  switch (change.to) {
    case "waiting_for_input":
      return { title: `${project} needs you`, body: `${session} is waiting for an answer.` };
    case "finished_unread":
      return { title: `${project} finished`, body: `${session} is done. Nothing is running there now.` };
    case "error":
      return { title: `${project} hit an error`, body: `${session} stopped. Open it to see what happened.` };
    default:
      return undefined;
  }
}

export interface NotifierOptions {
  log: DesktopLog;
  /** True when a piorbit window has focus, in which case we stay quiet. */
  isForeground: () => boolean;
  onActivate: (link: DeepLink) => void;
}

export class Notifier {
  private readonly lastAt = new Map<string, number>();
  private recent: number[] = [];

  constructor(private readonly options: NotifierOptions) {}

  /** Fire, or explain to the log why it did not. Never throws. */
  handle(change: AttentionChange, now = Date.now()): boolean {
    if (!Notification.isSupported()) return false;
    if (!shouldNotify(change)) return false;
    if (this.options.isForeground()) return false;

    const previous = this.lastAt.get(change.session.path);
    if (previous !== undefined && now - previous < REPEAT_WINDOW_MS) return false;

    this.recent = this.recent.filter((at) => now - at < BURST_WINDOW_MS);
    if (this.recent.length >= BURST_LIMIT) {
      this.options.log.line(`suppressed a notification for ${change.session.path}: too many at once`);
      return false;
    }

    const copy = copyFor(change);
    if (!copy) return false;

    this.lastAt.set(change.session.path, now);
    this.recent.push(now);

    try {
      const notification = new Notification({
        title: copy.title,
        body: copy.body,
        // A session that is blocked on a person should not disappear after
        // four seconds; one that merely finished should.
        urgency: urgencyFor(change.to),
        silent: change.to === "finished_unread",
      });
      notification.on("click", () => this.options.onActivate({ kind: "session", path: change.session.path }));
      notification.show();
      return true;
    } catch (error) {
      this.options.log.error("could not show a notification", error);
      return false;
    }
  }

  /** Forget a session, so closing and reopening it can notify again. */
  clear(path: string): void {
    this.lastAt.delete(path);
  }
}

function urgencyFor(attention: SessionAttention): "normal" | "critical" | "low" {
  if (attention === "waiting_for_input") return "critical";
  if (attention === "error") return "normal";
  return "low";
}
