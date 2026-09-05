import { AuiIf, ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { StatusDot } from "@/components/status";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { duration } from "@/format";
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
 * The composer's microphone. Idle: one icon button. Listening: a stop button,
 * a live level meter and the elapsed time, in the same slot — the button
 * morphs, nothing pops in elsewhere. Transcribing: the working dot and the
 * word.
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
export function DictateButton({ className }: { className?: string | undefined }) {
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
  return <DictateControls className={className} />;
}

function DictateControls({ className }: { className?: string | undefined }) {
  const aui = useAui();
  const { actions } = usePiorbitStable();
  const phase = useDictationPhase();
  const error = useDictationError();
  const active = useAuiState((s) => s.composer.dictation != null);

  // Where the caret was when dictation began: the phrase goes there, not at the end.
  const caret = useRef<{ text: string; at: number | undefined } | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
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

  return (
    <span data-slot="dictate" data-phase={phase} className={cn("flex items-center gap-1", className)}>
      <AuiIf condition={(s) => s.composer.dictation == null}>
        <ComposerPrimitive.Dictate asChild>
          <TooltipIconButton tooltip="Dictate" side="top" aria-label="Dictate a message">
            <Mic />
          </TooltipIconButton>
        </ComposerPrimitive.Dictate>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation != null}>
        <Listening phase={phase} />
        <ComposerPrimitive.StopDictation asChild>
          <TooltipIconButton
            tooltip={phase === "transcribing" ? "Transcribing…" : "Stop and transcribe"}
            side="top"
            variant="default"
            aria-label={phase === "transcribing" ? "Transcribing" : "Stop dictation and transcribe"}
            disabled={phase === "transcribing"}
            className="rounded-full disabled:opacity-100"
          >
            {phase === "transcribing" ? <StatusDot status="working" size="md" aria-hidden="true" className="bg-on-live" /> : <Square className="size-3 fill-current" />}
          </TooltipIconButton>
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </span>
  );
}

function composerTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea');
}

function Listening({ phase }: { phase: string }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const label = phase === "transcribing" ? "Transcribing…" : phase === "starting" ? "Starting…" : "Listening";
  return (
    <span role="status" className="flex h-8 items-center gap-2 rounded-full bg-surface-2 ps-2.5 pe-3 text-xs text-ink-2">
      {phase === "listening" ? <Waveform /> : <StatusDot status={phase === "transcribing" ? "working" : "idle"} size="sm" aria-hidden="true" />}
      <span className="font-medium text-ink">{label}</span>
      {phase !== "transcribing" ? <span className="typed text-ink-3 tnum">{duration(Math.max(0, now - started)).replace(/\.\ds$/, "s")}</span> : null}
    </span>
  );
}

const BARS = 5;

/**
 * Five bars driven by the live RMS level, each lagging the last so the shape
 * reads as sound rather than a VU needle. Height, never scale: a bar is 2px
 * wide and 3–16px tall. Under reduced motion the bars hold the current level.
 */
function Waveform() {
  const level = useDictationLevel();
  const history = useRef<number[]>(Array.from({ length: BARS }, () => 0));
  history.current = [level, ...history.current.slice(0, BARS - 1)];
  return (
    <span aria-hidden="true" className="flex h-4 items-center gap-0.5">
      {history.current.map((v, i) => (
        <span
          key={i}
          className="w-0.5 rounded-full bg-live motion-safe:transition-[height] motion-safe:duration-(--motion-instant)"
          style={{ height: `${3 + Math.round(Math.min(1, v * (1 + (BARS - i) * 0.15)) * 13)}px` }}
        />
      ))}
    </span>
  );
}
