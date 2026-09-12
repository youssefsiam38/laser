import { StatusDot, type Status } from "@/components/status";

/**
 * One session's own state, as one mark (M15-T4).
 *
 * Navigation stays quiet at rest; only the session that has something to say
 * speaks. Working is the same dot with the radar sweep every other surface
 * uses — it used to be a separate spinner at the end of the row, which made a
 * working session wear two marks at once (a state dot *and* a spinner) and put
 * them on opposite sides of the name. `StatusDot` already owns the sweep, the
 * attention pulse, the colours and the reduced-motion fallback, so the row has
 * exactly one indicator and one vocabulary.
 */
export function SessionActivity({ status, opening = false }: { status: Status; opening?: boolean }) {
  if (opening) return <StatusDot status="working" size="sm" label="Loading the conversation" />;
  if (status === "idle") return null;
  return <StatusDot status={status} size="sm" />;
}
