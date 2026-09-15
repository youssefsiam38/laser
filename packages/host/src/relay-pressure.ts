/**
 * What may be dropped on the way to one paired device, and what may not
 * (RP-7).
 *
 * The relay client used to refuse frames in three unrelated places — a frame
 * the relay's size ceiling could not carry, a full outbound queue, and a full
 * keystroke shaper — and each of them dropped whatever it was holding,
 * including a question, a terminal task update or an answer somebody was
 * waiting for. The declared policy is narrower than that: exactly three
 * diagnostics may be released, because a device can read each of them back
 * with a request it already makes. Anything else that cannot be sent means
 * this channel is no longer carrying the conversation, and the honest answer
 * is to close it so the device reconnects and re-reads — never to decide on
 * its behalf which of its own state it can do without.
 *
 * So every refusal goes through one decision, here.
 */
import { isSheddable } from "@lasercode/protocol";

export type RelayRefusal = "oversize" | "queue-full" | "shaper-full" | "pressure";

export type RelayVerdict = { kind: "shed"; method: string } | { kind: "fence"; refusal: RelayRefusal; method?: string };

/**
 * Decide what a refusal means for this message.
 *
 * A notification the protocol declares re-readable is shed and counted. A
 * response (no method) and every other notification fence the channel.
 */
export function refuse(refusal: RelayRefusal, method?: string): RelayVerdict {
  if (method !== undefined && isSheddable(method)) return { kind: "shed", method };
  return { kind: "fence", refusal, ...(method !== undefined ? { method } : {}) };
}

/** One sentence per refusal, for the error a person may see. */
export function refusalText(refusal: RelayRefusal, device: string): string {
  switch (refusal) {
    case "oversize":
      return `${device} cannot be sent something this large over the relay; reconnecting reloads it from the desktop`;
    case "queue-full":
      return `${device} is not draining its connection; reconnecting reloads what it missed`;
    case "shaper-full":
      return `${device} is not draining its paced connection; reconnecting reloads what it missed`;
    default:
      return `${device} fell too far behind to keep queueing for it; reconnecting reloads what it missed`;
  }
}
