import { useEffect, useState } from "react";

import { useLaserStable, useLaserState } from "@/runtime";

/**
 * The other versions of one message, from the producer's bounded sibling
 * window (`{ versionsOf }`, M16-T98, D-340): how many there are in all, and
 * for each one carried, the entry to move the session to in order to be
 * looking at that version. `total` is the honest count even when the page had
 * to shrink; `leaves` is what can be reached from here.
 */
export interface MessageVersions {
  total: number;
  leaves: ReadonlyArray<{ id: string; leafId: string }>;
}

/**
 * Answers already read, per conversation, per message, at the history revision
 * they were read at. A message's siblings change only when the tree does —
 * an edit, a fork, a regenerate — and every one of those moves the revision,
 * so the revision is the whole of the cache key. Bounded so a long session
 * that is paged through cannot grow it without limit.
 */
const answers = new Map<string, MessageVersions>();
const ANSWERS_MAX = 512;
const remember = (key: string, versions: MessageVersions): void => {
  if (answers.size >= ANSWERS_MAX) {
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
  answers.set(key, versions);
};

/** Bodies are not wanted; the schema's floor is the smallest page that carries none of substance. */
const NO_BODIES = 1024;

/**
 * The versions of the message at `entryId` in the conversation at `path`,
 * read from the producer when the loaded tree cannot answer alone.
 *
 * With every branch of the conversation loaded, the tree on hand knows every
 * sibling and nothing is asked. While it is partial — which is any long
 * conversation, since the transcript is read in pages — the loaded entries
 * may hold one version of a message whose others live on branches never paged
 * in, and only the producer can say how many there are. That question is one
 * bounded request per message, answered from the session index, never a read
 * of the whole conversation; the transcript itself is untouched by the answer.
 *
 * `undefined` until the answer is in, or when none is needed; the caller then
 * falls back to what the loaded tree says.
 */
export function useMessageVersions(path: string | undefined, entryId: string | undefined, partial: boolean): MessageVersions | undefined {
  const { client } = useLaserStable();
  const revision = useLaserState(s => (path ? s.open[path]?.history?.revision : undefined));
  const key = path && entryId && partial ? `${path}\0${entryId}\0${revision ?? ""}` : undefined;
  const [answer, setAnswer] = useState<{ key: string; versions: MessageVersions }>();
  useEffect(() => {
    if (!key || !path || !entryId) return;
    const held = answers.get(key);
    if (held) { setAnswer({ key, versions: held }); return; }
    let cancelled = false;
    void client.request("pi/session/entries", { path, authority: "any", window: { versionsOf: entryId }, bodyLimit: NO_BODIES })
      .then(result => {
        // Only a versions page is an answer. Anything else — a producer too
        // old to know the window, a transcript page by mistake — is treated as
        // no answer, and the loaded tree's count stands. Never applied to the
        // transcript: this is siblings, not a page of the conversation.
        const window = result.window;
        if (!window || window.mode !== "versions" || !window.versions) return;
        const versions: MessageVersions = { total: window.versions.total, leaves: window.versions.leaves };
        remember(key, versions);
        if (!cancelled) setAnswer({ key, versions });
      })
      .catch(() => {
        // The loaded tree's count stands. A failure here is not a sentence to
        // show anyone: the message is still on screen, still editable, and the
        // versions that are loaded are still reachable.
      });
    return () => { cancelled = true; };
  }, [client, key, path, entryId]);
  return answer && answer.key === key ? answer.versions : undefined;
}
