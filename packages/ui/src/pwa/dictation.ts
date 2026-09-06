/**
 * Dictation on a phone: `getUserMedia` → `MediaRecorder` → the host.
 *
 * Implements assistant-ui's `DictationAdapter` so `ComposerPrimitive.Dictate`
 * / `StopDictation` drive it and the desktop path (M8-T2) can reuse it. The
 * audio travels over the same JSON-RPC socket as everything else, base64 in
 * ≤ 32 KiB chunks so each frame fits the relay's 64 KiB ceiling; the host's
 * transcribe backend (owned by M8) answers with text.
 *
 * The runtime appends a final transcript to the end of the composer text.
 * `placePhraseAtCaret` is the pure helper `DictateButton` uses to move it to
 * where the caret actually was.
 */
import type { DictationAdapter } from "@assistant-ui/react";
import { extendedRequest, type RawRequestClient } from "./host-rpc.js";

/** Decoded bytes per chunk. 32 KiB → ~43 KiB of base64 + envelope, under 64 KiB. */
export const CHUNK_BYTES = 32 * 1024;
export const DEFAULT_MAX_SECONDS = 90;

/** MediaRecorder container/codec preference. iOS Safari records mp4; everyone else webm/opus. */
export const RECORDER_MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function pickRecorderMimeType(isSupported: (type: string) => boolean, candidates = RECORDER_MIME_CANDIDATES): string | undefined {
  return candidates.find((c) => {
    try {
      return isSupported(c);
    } catch {
      return false;
    }
  });
}

/** Split a base64 string so each piece decodes to at most `bytes`. Pure. */
export function chunkBase64(base64: string, bytes = CHUNK_BYTES): string[] {
  // 4 base64 characters ↔ 3 bytes; keep boundaries on 4 so every chunk decodes alone.
  const chars = Math.max(4, Math.floor((bytes / 3) * 4) - (Math.floor((bytes / 3) * 4) % 4));
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += chars) out.push(base64.slice(i, i + chars));
  return out.length ? out : [""];
}

export interface CaretPlacement {
  text: string;
  caret: number;
}

/**
 * Insert `phrase` at `caret` in `text` with sensible spacing: a space before
 * when the previous character is not whitespace, a space after when the next
 * one is a word character. `caret` undefined or past the end appends.
 */
export function placePhraseAtCaret(text: string, caret: number | undefined, phrase: string): CaretPlacement {
  const trimmed = phrase.trim();
  if (!trimmed) return { text, caret: caret ?? text.length };
  const at = caret === undefined ? text.length : Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  const inserted = `${lead}${trimmed}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: at + inserted.length };
}

/** Undo assistant-ui's end append before placing a phrase at the live caret. */
export function removeRuntimeAppend(text: string, phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return text;
  const spaced = ` ${trimmed}`;
  if (text.endsWith(spaced)) return text.slice(0, -spaced.length);
  if (text.endsWith(trimmed)) return text.slice(0, -trimmed.length);
  return text;
}

/** Words for a `getUserMedia` failure, in the app's voice. */
export function describeMicrophoneError(error: unknown): { title: string; body: string } {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return {
        title: "Microphone access is off",
        body: "Allow the microphone for this site in your browser settings, then try again. On iPhone, Safari asks again each time the app is opened from the home screen.",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { title: "No microphone found", body: "This device has no microphone the browser can use." };
    case "NotReadableError":
    case "AbortError":
      return { title: "The microphone is busy", body: "Another app is using it. Close that app and try again." };
    default:
      return { title: "Could not start dictation", body: error instanceof Error && error.message ? error.message : "The microphone did not start." };
  }
}

export interface TranscribeTransport {
  /** Fail before opening the microphone when the required provider is unavailable. */
  check?(): Promise<void>;
  begin(mimeType: string): Promise<string>;
  chunk(id: string, data: string): Promise<void>;
  end(id: string): Promise<string>;
  cancel(id: string): Promise<void>;
}

/** Which project (and, when known, which session) a recording belongs to. */
export interface TranscribeScope {
  cwd: string;
  /**
   * Binds the recording to a session, so a phrase still in flight when Enter
   * is pressed is folded into that prompt instead of being lost.
   */
  path?: string | undefined;
}

export function transcribeTransport(client: RawRequestClient, scope: () => TranscribeScope | undefined): TranscribeTransport {
  const need = (): TranscribeScope => {
    const current = scope();
    if (!current) throw new Error("Open a session before dictating.");
    return current;
  };
  return {
    check: async () => {
      const { cwd } = need();
      const status = await extendedRequest(client, "pi/transcribe/status", { cwd });
      if (!status.available) throw new Error(status.reason ?? "Dictation is not available for this project.");
    },
    begin: (mimeType) => {
      const { cwd, path } = need();
      return extendedRequest(client, "pi/transcribe/begin", {
        cwd,
        mimeType,
        ...(path !== undefined ? { path } : {}),
      }).then((r) => r.id);
    },
    chunk: (id, data) => extendedRequest(client, "pi/transcribe/chunk", { id, data }).then(() => undefined),
    end: (id) => extendedRequest(client, "pi/transcribe/end", { id }).then((r) => r.text),
    cancel: (id) => extendedRequest(client, "pi/transcribe/cancel", { id }).then(() => undefined),
  };
}

export type DictationPhase = "idle" | "starting" | "listening" | "transcribing";

export interface MediaRecorderDictationOptions {
  transport: TranscribeTransport;
  /** Audio level 0..1 at ~30 Hz while listening, for a meter. */
  onLevel?: (level: number) => void;
  onPhase?: (phase: DictationPhase) => void;
  /** The final phrase, after the runtime has already received it via `onSpeech`. */
  onPhrase?: (phrase: string) => void;
  onError?: (error: unknown) => void;
  maxSeconds?: number;
  /** Test seams. */
  getMedia?: () => Promise<MediaStream>;
  createRecorder?: (stream: MediaStream, mimeType: string | undefined) => MediaRecorder;
  isTypeSupported?: (type: string) => boolean;
}

type Unsubscribe = () => void;

/**
 * Non-streaming: the phrase arrives once, after stop. `stop()` resolves only
 * when the text is in the composer, so the button can show "Transcribing…"
 * for as long as the session is pending.
 */
export class MediaRecorderDictationAdapter implements DictationAdapter {
  readonly disableInputDuringDictation = false;

  constructor(private readonly options: MediaRecorderDictationOptions) {}

  static isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof (window as Window & { MediaRecorder?: unknown }).MediaRecorder === "function"
    );
  }

  listen(): DictationAdapter.Session {
    const o = this.options;
    const speech = new Set<(r: DictationAdapter.Result) => void>();
    const starts = new Set<() => void>();
    const ends = new Set<(r: DictationAdapter.Result) => void>();
    const session = {
      status: { type: "starting" } as DictationAdapter.Status,
      stop: async () => {},
      cancel: () => {},
      onSpeechStart: (cb: () => void): Unsubscribe => {
        starts.add(cb);
        return () => starts.delete(cb);
      },
      onSpeechEnd: (cb: (r: DictationAdapter.Result) => void): Unsubscribe => {
        ends.add(cb);
        return () => ends.delete(cb);
      },
      onSpeech: (cb: (r: DictationAdapter.Result) => void): Unsubscribe => {
        speech.add(cb);
        return () => speech.delete(cb);
      },
    };

    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let mimeType: string | undefined;
    const blobs: Blob[] = [];
    let cancelled = false;
    let stopped = false;
    let meter: (() => void) | undefined;
    let limit: ReturnType<typeof setTimeout> | undefined;
    let recorded: Promise<void> | undefined;

    const phase = (p: DictationPhase) => o.onPhase?.(p);
    const finish = (reason: "stopped" | "cancelled" | "error", transcript = "") => {
      session.status = { type: "ended", reason };
      for (const cb of ends) cb({ transcript, isFinal: true });
      phase("idle");
    };
    const teardown = () => {
      if (limit !== undefined) clearTimeout(limit);
      meter?.();
      meter = undefined;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
    };
    const fail = (error: unknown) => {
      teardown();
      o.onError?.(error);
      finish("error");
    };

    const start = async () => {
      phase("starting");
      try {
        await o.transport.check?.();
        stream = await (o.getMedia ?? (() => navigator.mediaDevices.getUserMedia({ audio: true })))();
        if (cancelled) {
          teardown();
          return;
        }
        const isSupported = o.isTypeSupported ?? ((t: string) => MediaRecorder.isTypeSupported(t));
        mimeType = pickRecorderMimeType(isSupported);
        recorder = (o.createRecorder ?? ((s, m) => (m ? new MediaRecorder(s, { mimeType: m }) : new MediaRecorder(s))))(stream, mimeType);
        mimeType = recorder.mimeType || mimeType;
        recorded = new Promise<void>((resolve) => {
          recorder!.addEventListener("dataavailable", (e) => {
            if (e.data.size > 0) blobs.push(e.data);
          });
          recorder!.addEventListener("stop", () => resolve());
          recorder!.addEventListener("error", () => resolve());
        });
        recorder.addEventListener("start", () => {
          session.status = { type: "running" };
          for (const cb of starts) cb();
          phase("listening");
        });
        recorder.start(1000);
        meter = o.onLevel ? startMeter(stream, o.onLevel) : undefined;
        limit = setTimeout(() => void session.stop(), (o.maxSeconds ?? DEFAULT_MAX_SECONDS) * 1000);
      } catch (error) {
        fail(error);
      }
    };

    session.stop = async () => {
      if (stopped || cancelled) return;
      stopped = true;
      if (limit !== undefined) clearTimeout(limit);
      meter?.();
      meter = undefined;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        await recorded;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = undefined;
        if (blobs.length === 0) {
          finish("stopped");
          return;
        }
        phase("transcribing");
        const type = mimeType ?? blobs[0]?.type ?? "application/octet-stream";
        const base64 = await blobToBase64(new Blob(blobs, { type }));
        const id = await o.transport.begin(type.split(";")[0] ?? type);
        try {
          for (const piece of chunkBase64(base64)) {
            if (cancelled) throw new Error("cancelled");
            await o.transport.chunk(id, piece);
          }
          const text = await o.transport.end(id);
          const phrase = text.trim();
          if (phrase) {
            for (const cb of speech) cb({ transcript: phrase, isFinal: true });
            o.onPhrase?.(phrase);
          }
          finish("stopped", phrase);
        } catch (error) {
          await o.transport.cancel(id).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (cancelled) {
          finish("cancelled");
          return;
        }
        fail(error);
      }
    };

    session.cancel = () => {
      if (cancelled) return;
      cancelled = true;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      teardown();
      if (!stopped) finish("cancelled");
    };

    void start();
    return session;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the recording."));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** RMS level from an AnalyserNode, ~30 Hz. Returns a stop function. */
/**
 * The level meter's dB floor and ceiling, and its envelope rates.
 *
 * Conversational speech sits around −30 to −20 dBFS, which is 0.03 to 0.1 as
 * raw RMS: on a linear bar that is the bottom tenth, and the meter looks dead
 * while someone is talking into it. So the level is mapped on a dB scale and
 * followed with a fast attack and a slow release, which makes a syllable read
 * as a spike instead of a flicker.
 *
 * The same four numbers appear in `@lasercode/worker`'s `transcribe.ts`, where
 * they document pi-gpt-transcribe's own widget contract. They are restated
 * here rather than imported because nothing above the worker may import it
 * (AGENTS.md invariant 1), and the browser is the side that owns the meter.
 */
export const WAVE_FLOOR_DB = -60;
export const WAVE_CEIL_DB = -8;
export const WAVE_ATTACK = 0.85;
export const WAVE_RELEASE = 0.35;

/** Normalized RMS → [0, 1] on a dB scale. Pure. */
export function levelToUnit(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - WAVE_FLOOR_DB) / (WAVE_CEIL_DB - WAVE_FLOOR_DB)));
}

/** One envelope-follower step: fast attack, slow release. Pure. */
export function followEnvelope(previous: number, target: number): number {
  return previous + (target - previous) * (target > previous ? WAVE_ATTACK : WAVE_RELEASE);
}

function startMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const Ctx = (window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return () => {};
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let last = 0;
  let envelope = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 33) return;
    last = now;
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const v of buffer) {
      const centred = (v - 128) / 128;
      sum += centred * centred;
    }
    envelope = followEnvelope(envelope, levelToUnit(Math.sqrt(sum / buffer.length)));
    onLevel(envelope);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    envelope = 0;
    source.disconnect();
    void ctx.close().catch(() => {});
    onLevel(0);
  };
}
