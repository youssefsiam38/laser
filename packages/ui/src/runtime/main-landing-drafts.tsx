import { storageKey } from "@lasercode/protocol";
import { useAui, useAuiState, type CreateAttachment, type ThreadComposerRuntime } from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { codeLandingKey, type MainDestination } from "./main-destination.js";

type ComposerState = ReturnType<ThreadComposerRuntime["getState"]>;

interface MainLandingDraft {
  text: string;
  runConfig: ComposerState["runConfig"];
  quote: ComposerState["quote"];
  attachments: Array<File | CreateAttachment>;
}

export interface MainLandingDraftStore {
  composer: ThreadComposerRuntime | undefined;
  readonly drafts: Map<string, MainLandingDraft>;
  captureBeforeTransition(destination: MainDestination): void;
}

/**
 * A landing has no session, so it has no session draft — and a frontend the
 * app replaces after a version handshake (`refreshFrontend`, AGENTS.md §5a)
 * used to take an unsent landing message with it. The text is kept the way a
 * session's is (`useComposerDraft`): the same `draft:` prefix and the same
 * `{ text, at }`, under the landing's own stable key rather than a path, so
 * the two can never collide. Attachments and a quote stay in memory: a `File`
 * does not survive a reload, and half a draft would be a lie.
 */
const LANDING_DRAFT_PREFIX = `${storageKey("draft:")}landing:`;
const SAVE_DEBOUNCE_MS = 300;

function readLandingDraft(key: string): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(`${LANDING_DRAFT_PREFIX}${key}`);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { text } = parsed as { text?: unknown };
    return typeof text === "string" && text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function writeLandingDraft(key: string, text: string | undefined): void {
  try {
    if (text === undefined) globalThis.localStorage?.removeItem(`${LANDING_DRAFT_PREFIX}${key}`);
    else globalThis.localStorage?.setItem(`${LANDING_DRAFT_PREFIX}${key}`, JSON.stringify({ text, at: new Date().toISOString() }));
  } catch {
    /* private mode / quota: the draft lives for this tab */
  }
}

const capture = (composer: ThreadComposerRuntime): MainLandingDraft => {
  const state = composer.getState();
  return {
    text: state.text,
    runConfig: state.runConfig,
    quote: state.quote,
    attachments: state.attachments.flatMap<File | CreateAttachment>((attachment) => {
      if (attachment.file) return [attachment.file];
      if (!attachment.content) return [];
      return [{
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
        content: attachment.content,
      }];
    }),
  };
};

export function createMainLandingDraftStore(): MainLandingDraftStore {
  return {
    composer: undefined,
    drafts: new Map(),
    captureBeforeTransition(destination) {
      const key = codeLandingKey(destination);
      if (!key || !this.composer) return;
      const draft = capture(this.composer);
      this.drafts.set(key, draft);
      writeLandingDraft(key, draft.text.trim() ? draft.text : undefined);
      void this.composer.reset();
    },
  };
}

/** Bind the assistant-ui local composer to project-keyed, ephemeral landing drafts. */
export function useMainLandingDrafts(destination: MainDestination, store: MainLandingDraftStore): void {
  const aui = useAui();
  const key = codeLandingKey(destination);
  const previousKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const composer = aui.composer as unknown as ThreadComposerRuntime;
    store.composer = composer;
    if (previousKey.current === key) return () => {
      if (store.composer === composer) store.composer = undefined;
    };
    previousKey.current = key;
    const draft = key ? store.drafts.get(key) : undefined;
    // Nothing in memory, but something on this machine: a reload (a version
    // handshake, a view refresh, a closed tab) left the text here.
    const stored = !draft && key ? readLandingDraft(key) : undefined;
    let cancelled = false;
    void (async () => {
      await composer.reset();
      if (cancelled || store.composer !== composer) return;
      if (!draft) {
        if (stored !== undefined) composer.setText(stored);
        return;
      }
      composer.setText(draft.text);
      composer.setRunConfig(draft.runConfig);
      composer.setQuote(draft.quote);
      for (const attachment of draft.attachments) {
        if (cancelled || store.composer !== composer) return;
        await composer.addAttachment(attachment);
      }
    })();
    return () => {
      cancelled = true;
      if (store.composer === composer) store.composer = undefined;
    };
  }, [aui, key, store]);

  // What is on screen, kept where a reload can find it. Debounced while typing,
  // flushed on the way out; emptying the composer under the same landing (a
  // send, a deliberate clear) spends the draft.
  const text = useAuiState((s) => s.composer.text);
  const live = useRef<{ key: string | undefined; text: string }>({ key: undefined, text: "" });
  useEffect(() => {
    const previous = live.current;
    live.current = { key, text };
    if (!key) return undefined;
    if (text.trim()) {
      const timer = setTimeout(() => writeLandingDraft(key, text), SAVE_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }
    // Only when this landing is the one that emptied: a transition resets the
    // composer after it has already stored what it captured.
    if (previous.key === key && previous.text.trim()) writeLandingDraft(key, undefined);
    return undefined;
  }, [key, text]);

  useEffect(() => {
    const save = (): void => {
      const { key: landing, text: unsent } = live.current;
      if (landing && unsent.trim()) writeLandingDraft(landing, unsent);
    };
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, []);
}
