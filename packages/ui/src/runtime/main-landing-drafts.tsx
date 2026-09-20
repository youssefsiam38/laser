import { useAui, useAuiState, type CreateAttachment, type ThreadComposerRuntime } from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { deviceStore } from "./device-storage.js";
import { mainLandingKey, type MainDestination } from "./main-destination.js";

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
  pendingAdopt: { key: string; path: string } | undefined;
  captureBeforeTransition(destination: MainDestination): void;
  /** The landing at `key` is becoming this session; restore the draft onto it. */
  adopt(key: string, path: string): void;
}

/**
 * A landing has no session, so it has no session draft — and a frontend the
 * app replaces after a version handshake (`refreshFrontend`, AGENTS.md §5a)
 * used to take an unsent landing message with it. The text is kept the way a
 * session's is (`useComposerDraft`): the same environment-scoped, bounded
 * draft store and the same `{ text, at }`, under the landing's own stable key
 * rather than a path, so the two can never collide. Attachments and a quote stay in memory: a `File`
 * does not survive a reload, and half a draft would be a lie.
 */
/** Landing drafts share the session drafts' bounded, admission-gated home. */
const LANDING_DRAFT_ID = (key: string): string => `landing:${key}`;
const SAVE_DEBOUNCE_MS = 300;

function readLandingDraft(key: string): string | undefined {
  return deviceStore.readDraft(LANDING_DRAFT_ID(key))?.text;
}

function writeLandingDraft(key: string, text: string | undefined): void {
  deviceStore.writeDraft(LANDING_DRAFT_ID(key), text);
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

const applyDraft = async (composer: ThreadComposerRuntime, draft: MainLandingDraft, cancelled: () => boolean): Promise<void> => {
  composer.setText(draft.text);
  composer.setRunConfig(draft.runConfig);
  composer.setQuote(draft.quote);
  for (const attachment of draft.attachments) {
    if (cancelled()) return;
    await composer.addAttachment(attachment);
  }
};

export function createMainLandingDraftStore(): MainLandingDraftStore {
  return {
    composer: undefined,
    drafts: new Map(),
    pendingAdopt: undefined,
    captureBeforeTransition(destination) {
      const key = mainLandingKey(destination);
      if (!key || !this.composer) return;
      const draft = capture(this.composer);
      this.drafts.set(key, draft);
      writeLandingDraft(key, draft.text.trim() ? draft.text : undefined);
      void this.composer.reset();
    },
    adopt(key, path) {
      this.pendingAdopt = { key, path };
    },
  };
}

/** Bind the assistant-ui local composer to destination-keyed landing drafts. */
export function useMainLandingDrafts(destination: MainDestination, store: MainLandingDraftStore): void {
  const aui = useAui();
  const destinationKey = mainLandingKey(destination);
  const physicalPath = useAuiState((s) => s.threadListItem.externalId ?? s.threadListItem.remoteId);
  // The destination commits before assistant-ui's controlled selection. Never
  // reset the session composer that is still physically mounted underneath a
  // landing; bind only after the runtime has adopted its local new thread.
  const key = physicalPath === undefined ? destinationKey : undefined;
  const previousKey = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const composer = aui.composer as unknown as ThreadComposerRuntime;
    store.composer = composer;
    const pending = store.pendingAdopt;
    if (pending && physicalPath !== undefined && physicalPath !== pending.path) {
      store.pendingAdopt = undefined;
    } else if (pending) {
      if (physicalPath !== pending.path) {
        return () => {
          if (store.composer === composer) store.composer = undefined;
        };
      }
      store.pendingAdopt = undefined;
      previousKey.current = undefined;
      const draft = store.drafts.get(pending.key);
      store.drafts.delete(pending.key);
      writeLandingDraft(pending.key, undefined);
      if (!draft || (draft.text.trim() === "" && draft.attachments.length === 0 && !draft.quote)) {
        return () => {
          if (store.composer === composer) store.composer = undefined;
        };
      }
      let cancelled = false;
      void applyDraft(composer, draft, () => cancelled || store.composer !== composer);
      return () => {
        cancelled = true;
        if (store.composer === composer) store.composer = undefined;
      };
    }
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
      await applyDraft(composer, draft, () => cancelled || store.composer !== composer);
    })();
    return () => {
      cancelled = true;
      if (store.composer === composer) store.composer = undefined;
    };
  }, [aui, key, physicalPath, store]);

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
