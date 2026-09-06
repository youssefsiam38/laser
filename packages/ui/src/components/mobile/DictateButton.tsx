import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";

import { ComposerVoice, ComposerVoiceButton } from "@/components/assistant-ui/elements/composer";
import { cn } from "@/lib/utils";
import {
  PhraseDictationAdapter,
  clearDictationError,
  describeMicrophoneError,
  placePhraseAtCaret,
  removeRuntimeAppend,
  setDictationPhraseSink,
  setDictationScope,
  useDictationError,
  useDictationLevel,
  useDictationPending,
  useDictationPhase,
  useEnvironment,
} from "@/pwa";
import { useLaserStable, useLaserView } from "@/runtime";

/**
 * The composer's microphone, drawn by the `composer` element's voice pieces
 * (docs/ux-elements.md "Composer" → Dictation): `ComposerVoiceButton` is the
 * one control that morphs from mic to stop, `ComposerVoice` the listening row
 * with the live level meter and the elapsed time. This file is the runtime
 * binding: where the phrase lands, which session is being recorded, and when
 * the control exists at all.
 *
 * Hidden entirely where dictation cannot work (R2 — hide the control, never
 * show a dead one): a browser with no microphone or Web Audio capture, an
 * insecure origin (the insecure-origin notice says why), or no open session.
 * The reusable transcription backend ships with Laser. Before the microphone
 * opens, the adapter checks its provider requirement and reports a missing or
 * OAuth-only OpenAI credential in product language.
 *
 * Needs `adapters.dictation` on the runtime (`getMobileDictationAdapter`);
 * `ComposerPrimitive.Dictate` disables itself without one.
 */
export function DictateButton({ className, size }: { className?: string | undefined; size?: "icon-sm" | "icon-lg" | undefined }) {
  const env = useEnvironment();
  const view = useLaserView();
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
  if (!env.microphone || !PhraseDictationAdapter.isSupported()) return null;
  return <DictateControls className={className} size={size} />;
}

function DictateControls({ className, size }: { className?: string | undefined; size?: "icon-sm" | "icon-lg" | undefined }) {
  const aui = useAui();
  const { actions } = useLaserStable();
  const phase = useDictationPhase();
  const level = useDictationLevel();
  const pending = useDictationPending();
  const error = useDictationError();
  const active = useAuiState((s) => s.composer.dictation != null);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  const insertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    setStartedAt(Date.now());
    setDictationPhraseSink((phrase) => {
      const textarea = composerTextarea();
      const current = aui.composer.getState().text;
      const base = removeRuntimeAppend(current, phrase);
      const placed = placePhraseAtCaret(base, textarea?.selectionStart, phrase);
      aui.composer.setText(placed.text);
      requestAnimationFrame(() => {
        const el = composerTextarea();
        el?.setSelectionRange(placed.caret, placed.caret);
        el?.focus({ preventScroll: true });
        const card = el?.closest<HTMLElement>('[data-slot="composer-card"]');
        if (card) {
          card.dataset.dictationInsert = "true";
          if (insertTimer.current !== undefined) clearTimeout(insertTimer.current);
          const duration = Number.parseFloat(getComputedStyle(card).getPropertyValue("--motion-morph")) || 0;
          insertTimer.current = setTimeout(() => delete card.dataset.dictationInsert, duration);
        }
      });
    });
    return () => {
      setDictationPhraseSink(undefined);
      if (insertTimer.current !== undefined) clearTimeout(insertTimer.current);
    };
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
        <ComposerVoice level={level} phase={voicePhase} pending={pending} startedAt={startedAt} />
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
