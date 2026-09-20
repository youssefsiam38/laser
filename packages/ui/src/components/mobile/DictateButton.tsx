import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";

import { ComposerVoice, ComposerVoiceButton } from "@/components/assistant-ui/elements/composer";
import { MobileComposerButtonClass } from "@/components/assistant-ui/elements/mobile-composer";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";
import {
  PhraseDictationAdapter,
  clearDictationError,
  cancelActiveDictation,
  activeDictationCancellation,
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
import { useLaserStable, useLaserState } from "@/runtime";
import { landingWorkspaceOf } from "@/runtime/main-destination";
import type { TranscribeScope } from "@/pwa/dictation";

/**
 * The composer's microphone, drawn by the `composer` element's voice pieces
 * (docs/ux-elements.md "Composer" → Dictation): `ComposerVoiceButton` is the
 * one control that morphs from mic to stop, `ComposerVoice` the listening row
 * with the live level meter and the elapsed time. This file is the runtime
 * binding: where the phrase lands, which session is being recorded, and when
 * the control exists at all.
 *
 * Hidden only where dictation cannot work in this browser at all (R2 — hide
 * the control, never show a dead one): no microphone or Web Audio capture, or
 * an insecure origin (the insecure-origin notice says why). Those are local
 * facts, known on the first frame. Everything that needs the host — whether
 * the project has a transcription provider, whether the credential is usable,
 * the browser's own permission — is asked on the press, by the transport's
 * `check()` before the microphone opens, and a real failure is said once in
 * the person's language where they pressed. Nothing is probed on mount and
 * nothing arriving from the host later adds or removes this control (D-341):
 * the microphone is ready for a press before the session exists, and the
 * person will never be faster than the request.
 *
 * Needs `adapters.dictation` on the runtime (`getMobileDictationAdapter`);
 * `ComposerPrimitive.Dictate` disables itself without one.
 */
interface DictateButtonProps {
  className?: string | undefined;
  size?: "icon-sm" | "icon-lg" | undefined;
  /** Gives every microphone action the phone's 44px touch target. */
  touchSized?: boolean | undefined;
}

export function DictateButton({ className, size, touchSized = false }: DictateButtonProps) {
  const env = useEnvironment();
  // Two narrow reads instead of the session view: a streamed token changes
  // neither, and the microphone must not re-render with the reply (M16-T32).
  const path = useLaserState(s => (s.current ? s.open[s.current]?.path : undefined));
  const sessionCwd = useLaserState(s => (s.current ? s.open[s.current]?.state.cwd : undefined));
  const { destination } = useLaserStable();
  const supported = env.microphone && PhraseDictationAdapter.isSupported();
  // Where a recording would be filed before a session exists: the project the
  // landing is for, or the built-in workspace's directory. The workspace
  // directories are known before "New chat" is offered at all (the sessions
  // panel gates the button on them), so this is not a wait either.
  const workspaces = useLaserState(s => s.agents.snapshot?.workspaces);
  const landing = destination ? landingWorkspaceOf(destination) : undefined;
  const landingCwd = landing?.kind === "project" ? landing.cwd
    : landing?.kind === "chat" ? workspaces?.chat
      : landing?.kind === "beam" ? workspaces?.beam
        : undefined;
  const cwd = sessionCwd ?? landingCwd;

  if (!supported || !cwd) return null;
  return <DictateControls className={className} size={size} touchSized={touchSized} cwd={cwd} path={path} />;
}

function DictateControls({ className, size, touchSized, cwd, path }: DictateButtonProps & TranscribeScope) {
  const aui = useAui();
  const { actions } = useLaserStable();
  const phase = useDictationPhase();
  const level = useDictationLevel();
  const pending = useDictationPending();
  const error = useDictationError();
  const active = useAuiState((s) => s.composer.dictation != null);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  const insertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * This composer, so a phrase lands in the box it was spoken into. More than
   * one composer can be mounted (Beam's bubble over the session's own), and a
   * document-wide query for a textarea would always find the first one.
   */
  const root = useRef<HTMLSpanElement>(null);
  const composerTextarea = useCallback(
    (): HTMLTextAreaElement | null => root.current?.closest('[data-slot="composer"]')?.querySelector<HTMLTextAreaElement>("textarea") ?? null,
    [],
  );

  /**
   * Which session a recording belongs to, claimed when this composer starts
   * one. The adapter is one instance for the whole app and reads the scope at
   * `begin`, so the claim is made on the way into dictation — not on mount,
   * which would let the last composer to appear speak for every other one.
   */
  const ownsRecording = useRef(false);
  const claimScope = useCallback(() => {
    ownsRecording.current = true;
    setDictationScope({ cwd, path });
  }, [path, cwd]);

  useEffect(() => {
    if (!active) return;
    claimScope();
    const cancelOwnedRecording = activeDictationCancellation();
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
          // The token, through `@/motion` — not a hand-parsed custom property:
          // a theme that spells the morph in seconds is still that duration.
          insertTimer.current = setTimeout(() => delete card.dataset.dictationInsert, motionMs("--motion-morph"));
        }
      });
    });
    return () => {
      cancelOwnedRecording?.();
      setDictationPhraseSink(undefined);
      setDictationScope(undefined);
      if (insertTimer.current !== undefined) clearTimeout(insertTimer.current);
    };
  }, [active, aui, claimScope, composerTextarea]);

  useEffect(() => {
    if (phase !== "idle" && !active) ownsRecording.current = false;
  }, [phase, active]);

  useEffect(() => {
    if (error === undefined || !ownsRecording.current) return;
    const { title, body } = describeMicrophoneError(error);
    actions.toast("error", `${title}. ${body}`);
    clearDictationError();
  }, [error, actions]);

  const voicePhase = phase === "transcribing" ? "transcribing" : phase === "starting" ? "starting" : "listening";

  return (
    <span ref={root} data-slot="dictate" data-phase={active ? phase : "idle"} className={cn("flex min-w-0 items-center gap-1", active && "basis-full", className)}>
      <AuiIf condition={(s) => s.composer.dictation == null}>
        <ComposerPrimitive.Dictate asChild>
          {/* The claim runs before the primitive begins: composed handlers run
              the child's first, and the transport reads the scope at `begin`. */}
          <ComposerVoiceButton active={false} aria-label="Dictate a message" disabled={phase !== "idle"} tooltip={phase !== "idle" ? "Recording in another composer" : "Dictate"} onClick={claimScope} className={touchSized ? MobileComposerButtonClass(false) : undefined} {...(size ? { size } : {})} />
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation != null}>
        <ComposerVoice level={level} phase={voicePhase} pending={pending} startedAt={startedAt} className="flex-1" />
        <ComposerPrimitive.StopDictation asChild>
          <ComposerVoiceButton
            active
            tooltip={phase === "transcribing" ? "Transcribing…" : "Stop and transcribe"}
            aria-label={phase === "transcribing" ? "Transcribing" : "Stop dictation and transcribe"}
            disabled={phase === "transcribing"}
            className={cn("disabled:opacity-100", touchSized && MobileComposerButtonClass(true))}
            {...(size ? { size } : {})}
          />
        </ComposerPrimitive.StopDictation>
        <TooltipIconButton
          tooltip="Discard untranscribed audio"
          aria-label="Discard recording"
          variant="ghost"
          size={size ?? "icon-sm"}
          className={cn("shrink-0 text-ink-3 hover:text-ink", touchSized && MobileComposerButtonClass(false))}
          onClick={() => cancelActiveDictation()}
        >
          <X />
        </TooltipIconButton>
      </AuiIf>
    </span>
  );
}


