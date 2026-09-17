import { readFileSync } from "node:fs";

/**
 * Naming is work of its own. The worker starts it beside the prompt, so it
 * completes independently of `agent_settled` and appends one durable
 * `session_info` record whenever it is ready.
 *
 * Any assertion that a session file — or its revision, or its entries — was
 * untouched across some other operation has to settle that append first, or it
 * is asserting against a file a second legitimate writer is still finishing.
 * Three end-to-end tests learned this separately; the wait lives here so the
 * fourth does not have to (M16-T71).
 */
export async function named(path: string, attempts = 250, intervalMs = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (hasSessionInfo(path)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`session ${path} was never named`);
}

function hasSessionInfo(path: string): boolean {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return (JSON.parse(line) as { type?: string }).type === "session_info";
      } catch {
        return false;
      }
    });
}
