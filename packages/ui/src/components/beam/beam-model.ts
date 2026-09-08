/**
 * Pure helpers and copy for Beam's surfaces. No React, no DOM.
 *
 * Beam is the app's own assistant (docs/agents.md "Beam"): one entry point,
 * the spark beside Settings; a bubble that holds the ordinary chat for a
 * session in Beam's workspace; a model chosen once, when the first provider
 * connects.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import type { AgentsSnapshot, SessionAgentInfo } from "@lasercode/protocol";

export const BEAM_NAME = "Beam";
export const BEAM_AGENT_NAME = "beam";

/** The one sentence under the mark, before the first message. */
export const BEAM_TAGLINE = `Your assistant for ${PRODUCT_DISPLAY_NAME}. Ask about your sessions, logs, agents or settings.`;

/** What Beam is for, in the model choice dialog. */
export const BEAM_PURPOSE =
  `Beam is the helper in the corner of ${PRODUCT_DISPLAY_NAME}. It reads your sessions, logs, agents and settings and answers questions about them. ` +
  "It runs often, so a fast, capable, inexpensive model is the best fit.";

/** Shown in the empty state while Beam has no model of its own. */
export const BEAM_DEFAULT_MODEL_NOTE = "Beam uses the default model until you choose one.";

/** Chips under the tagline. They fill the composer; the person decides to send. */
export const BEAM_SUGGESTIONS: readonly string[] = [
  "Which sessions need me right now?",
  "What went wrong in the logs today?",
  "How do I add a new agent?",
];

/** The row above the composer once a Beam turn settles. About the app, not about a repository. */
export const BEAM_FOLLOW_UPS: ReadonlyArray<{ title: string; label: string; prompt: string }> = [
  { title: "Tell me more", label: "more detail", prompt: "Tell me more about that." },
  { title: "Where is that?", label: "point me there", prompt: "Where do I find that in the app?" },
  { title: "What else needs me?", label: "attention", prompt: "What else needs my attention right now?" },
];

/** A session Beam owns: attributed to it, or living in its workspace. */
export function isBeamSession(
  session: { cwd: string; agent?: SessionAgentInfo | undefined },
  snapshot: AgentsSnapshot | null | undefined,
): boolean {
  if (session.agent) return session.agent.kind === "beam";
  return snapshot !== null && snapshot !== undefined && session.cwd === snapshot.workspaces.beam;
}

/** Where a new Beam chat starts, once the host has said where Beam lives. */
export function beamWorkspace(snapshot: AgentsSnapshot | null | undefined): { cwd: string; agentName: string } | undefined {
  const cwd = snapshot?.workspaces.beam;
  return cwd ? { cwd, agentName: BEAM_AGENT_NAME } : undefined;
}

/** The sentence a send gets while the host has not said where Beam lives yet. */
export const BEAM_UNAVAILABLE = "Beam is still connecting. Try again in a moment.";

/**
 * `transform-origin` for a bubble growing out of its spark: the spark's centre
 * in the bubble's own coordinates. Both rectangles are viewport-relative.
 */
export function bubbleOrigin(
  spark: { left: number; top: number; width: number; height: number } | undefined,
  bubble: { left: number; top: number },
): string | undefined {
  if (!spark) return undefined;
  const x = Math.round(spark.left + spark.width / 2 - bubble.left);
  const y = Math.round(spark.top + spark.height / 2 - bubble.top);
  return `${x}px ${y}px`;
}

/**
 * Start a Beam chat in the main view.
 *
 * The bubble is where Beam usually lives, but it is not the only way in: the
 * Beam group in the sessions sidebar starts one too, and a chat started there
 * belongs in the window rather than in a corner (the person asked for it from
 * the full-size list). Selecting it is what "full view" means; the bubble's
 * own maximize control does the same thing for the chat it is showing.
 */
export async function startBeamSession(
  actions: { newSession: (cwd: string, options?: { agentName?: string }) => Promise<string> },
  snapshot: AgentsSnapshot | null | undefined,
): Promise<string> {
  const workspace = beamWorkspace(snapshot);
  if (!workspace) throw new Error(BEAM_UNAVAILABLE);
  return actions.newSession(workspace.cwd, { agentName: workspace.agentName });
}
