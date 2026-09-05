import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";

import { ComposerVoice, ComposerVoiceButton } from "@/components/assistant-ui/elements/composer";
import { cn } from "@/lib/utils";
import {
  MediaRecorderDictationAdapter,
  clearDictationError,
  describeMicrophoneError,
  placePhraseAtCaret,
  setDictationPhraseSink,
  setDictationScope,
  useDictationError,
  useDictationLevel,
  useDictationPhase,
  useEnvironment,
} from "@/pwa";
import { usePiorbitStable, usePiorbitView } from "@/runtime";

/**
 * The composer's microphone, drawn by the `composer` element's voice pieces
 * (docs/ux-elements.md "Composer" → Dictation): `ComposerVoiceButton` is the
 * one control that morphs from mic to stop, `ComposerVoice` the listening row
 * with the live level meter and the elapsed time. This file is the runtime
 * binding: where the phrase lands, which session is being recorded, and when
 * the control exists at all.
 *
 * Hidden entirely where dictation cannot work (R2 — hide the control, never
 * show a dead one): a browser with no microphone or no MediaRecorder, an
 * insecure origin (the insecure-origin notice says why), no open session, or
 * a project whose companion extension did not report a `transcribe` module.
 * The reason a *configured* project still cannot dictate — an OAuth-only
 * provider, say — comes back from `pi/transcribe/status` when someone presses
 * it, because it is a sentence, not a state to pre-render.
 *
 * Needs `adapters.dictation` on the runtime (`getMobileDictationAdapter`);
 * `ComposerPrimitive.Dictate` disables itself without one.
 */
export function DictateButton({ className, size }: { className?: string | undefined; size?: "icon-sm" | "icon-lg" | undefined }) {
  const env = useEnvironment();
  const view = usePiorbitView();
  const available = view?.capabilities.includes("transcribe") ?? false;

  // The adapter outlives every session; tell it which one is being recorded.
  useEffect(() => {
    if (!view || !available) {
      setDictationScope(undefined);
      return;
    }
    setDictationScope({ cwd: view.state.cwd, path: view.path });
    return () => setDictationScope(undefined);
  }, [available, view]);

  if (!available) return null;
  if (!env.microphone || !env.mediaRecorder || !MediaRecorderDictationAdapter.isSupported()) return null;
  return <DictateControls className={className} size={size} />;
}

function DictateControls({ className, size }: { className?: string | undefined; size?: "icon-sm" | "icon-lg" | undefined }) {
  const aui = useAui();
  const { actions } = usePiorbitStable();
  const phase = useDictationPhase();
  const level = useDictationLevel();
  const error = useDictationError();
  const active = useAuiState((s) => s.composer.dictation != null);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  // Where the caret was when dictation began: the phrase goes there, not at the end.
  const caret = useRef<{ text: string; at: number | undefined } | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    setStartedAt(Date.now());
    const textarea = composerTextarea();
    caret.current = { text: aui.composer.getState().text, at: textarea?.selectionStart ?? undefined };
    setDictationPhraseSink((phrase) => {
      const snap = caret.current;
      caret.current = undefined;
      if (!snap || snap.at === undefined || snap.at >= snap.text.length) return; // runtime already appended
      const placed = placePhraseAtCaret(snap.text, snap.at, phrase);
      aui.composer.setText(placed.text);
      requestAnimationFrame(() => {
        const el = composerTextarea();
        el?.setSelectionRange(placed.caret, placed.caret);
        el?.focus({ preventScroll: true });
      });
    });
    return () => setDictationPhraseSink(undefined);
  }, [active, aui]);

  useEffect(() => {
    if (error === undefined) return;
    const { title, body } = describeMicrophoneError(error);
    actions.toast("error", `${title}. ${body}`);
    clearDictationError();
  }, [error, actions]);

  const voicePhase = phase === "transcribing" ? "transcribing" : phase === "starting" ? "starting" : "listening";

  return (
    <span data-slot="dictate" data-phase={phase} className={cn("flex items-center gap-1", className)}>
      <AuiIf condition={(s) => s.composer.dictation == null}>
        <ComposerPrimitive.Dictate asChild>
          <ComposerVoiceButton active={false} aria-label="Dictate a message" {...(size ? { size } : {})} />
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation != null}>
        <ComposerVoice level={level} phase={voicePhase} startedAt={startedAt} />
        <ComposerPrimitive.StopDictation asChild>
          <ComposerVoiceButton
            active
            tooltip={phase === "transcribing" ? "Transcribing…" : "Stop and transcribe"}
            aria-label={phase === "transcribing" ? "Transcribing" : "Stop dictation and transcribe"}
            disabled={phase === "transcribing"}
            className="disabled:opacity-100"
            {...(size ? { size } : {})}
          />
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </span>
  );
}

function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea');
}
