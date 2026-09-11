import { useAui, type CreateAttachment, type ThreadComposerRuntime } from "@assistant-ui/react";
import { useLayoutEffect, useRef } from "react";

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
      this.drafts.set(key, capture(this.composer));
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
    let cancelled = false;
    void (async () => {
      await composer.reset();
      if (cancelled || store.composer !== composer || !draft) return;
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
}
