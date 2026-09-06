import type { DictationAdapter } from "@assistant-ui/react";

import { CHUNK_BYTES, chunkBase64, type DictationPhase, type TranscribeTransport } from "./dictation.js";

export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MIN_SEGMENT_SECONDS = 0.35;
export const DICTATION_MAX_SEGMENT_SECONDS = 20;
export const DICTATION_SILENCE_HOLDOFF_MS = 500;
export const DICTATION_SPEECH_FLOOR = 0.005;

const NOISE_FLOOR_MARGIN = 3;
const MAX_SPEECH_THRESHOLD = 0.02;
const NOISE_FLOOR_RISE = 0.0005;

export interface PhraseSegmenterOptions {
  onLevel?(level: number): void;
  onSegment(samples: Int16Array): void;
  sampleRate?: number;
  minSegmentSeconds?: number;
  maxSegmentSeconds?: number;
  silenceHoldoffMs?: number;
  speechFloor?: number;
}

/** Browser capture counterpart to pi-gpt-transcribe's phrase cutter. */
export class PhraseSegmenter {
  private readonly sampleRate: number;
  private readonly minSamples: number;
  private readonly maxSamples: number;
  private readonly silenceSamples: number;
  private readonly speechFloor: number;
  private readonly chunks: Int16Array[] = [];
  private samples = 0;
  private quietSamples = 0;
  private sawSpeech = false;
  private peak = 0;
  private noiseFloor = Number.POSITIVE_INFINITY;

  constructor(private readonly options: PhraseSegmenterOptions) {
    this.sampleRate = options.sampleRate ?? DICTATION_SAMPLE_RATE;
    this.minSamples = Math.round((options.minSegmentSeconds ?? DICTATION_MIN_SEGMENT_SECONDS) * this.sampleRate);
    this.maxSamples = Math.round((options.maxSegmentSeconds ?? DICTATION_MAX_SEGMENT_SECONDS) * this.sampleRate);
    this.silenceSamples = Math.round(((options.silenceHoldoffMs ?? DICTATION_SILENCE_HOLDOFF_MS) / 1000) * this.sampleRate);
    this.speechFloor = options.speechFloor ?? DICTATION_SPEECH_FLOOR;
  }

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    const level = rmsPcm16(chunk);
    this.options.onLevel?.(level);
    this.chunks.push(chunk);
    this.samples += chunk.length;
    this.peak = Math.max(this.peak, level);
    this.noiseFloor =
      level < this.noiseFloor ? level : this.noiseFloor + (level - this.noiseFloor) * NOISE_FLOOR_RISE;
    const floor = Number.isFinite(this.noiseFloor) ? this.noiseFloor : 0;
    const threshold = Math.min(MAX_SPEECH_THRESHOLD, Math.max(this.speechFloor, floor * NOISE_FLOOR_MARGIN));
    if (level >= threshold) {
      this.sawSpeech = true;
      this.quietSamples = 0;
    } else if (this.sawSpeech) {
      this.quietSamples += chunk.length;
    }

    if (this.sawSpeech && this.quietSamples >= this.silenceSamples) this.flush();
    else if (this.samples >= this.maxSamples) this.flush();
  }

  finish(): void {
    this.flush();
    this.options.onLevel?.(0);
  }

  private flush(): void {
    if (this.samples >= this.minSamples && this.sawSpeech && this.peak >= this.speechFloor) {
      const joined = new Int16Array(this.samples);
      let offset = 0;
      for (const chunk of this.chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      this.options.onSegment(joined);
    }
    this.chunks.length = 0;
    this.samples = 0;
    this.quietSamples = 0;
    this.sawSpeech = false;
    this.peak = 0;
  }
}

export function rmsPcm16(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

/** 16 kHz mono PCM in the exact WAV container upstream's core produces. */
export function encodePcmWav(samples: Int16Array, sampleRate = DICTATION_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(bytes.buffer);
  const write = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.byteLength, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = CHUNK_BYTES;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export interface PcmCapture {
  stop(): void;
}

export type PcmCaptureFactory = (stream: MediaStream, onChunk: (chunk: Int16Array) => void) => Promise<PcmCapture>;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? candidate.webkitAudioContext;
}

class StreamingPcmResampler {
  private carry = new Float32Array(0);
  private position = 0;
  constructor(private readonly inputRate: number, private readonly outputRate = DICTATION_SAMPLE_RATE) {}

  push(input: Float32Array): Int16Array {
    const source = new Float32Array(this.carry.length + input.length);
    source.set(this.carry);
    source.set(input, this.carry.length);
    const ratio = this.inputRate / this.outputRate;
    const values: number[] = [];
    while (this.position + 1 < source.length) {
      const left = Math.floor(this.position);
      const mix = this.position - left;
      const value = source[left]! * (1 - mix) + source[left + 1]! * mix;
      values.push(Math.round(Math.max(-1, Math.min(1, value)) * 32767));
      this.position += ratio;
    }
    const consumed = Math.floor(this.position);
    this.carry = source.slice(consumed);
    this.position -= consumed;
    return Int16Array.from(values);
  }
}

export const createBrowserPcmCapture: PcmCaptureFactory = async (stream, onChunk) => {
  const Context = audioContextConstructor();
  if (!Context) throw new Error("Live audio capture is not available in this browser.");
  const context = new Context();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  const resampler = new StreamingPcmResampler(context.sampleRate);
  mute.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const samples = resampler.push(event.inputBuffer.getChannelData(0));
    if (samples.length > 0) onChunk(samples);
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  await context.resume();
  let closed = false;
  return {
    stop() {
      if (closed) return;
      closed = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
      void context.close();
    },
  };
};

export interface PhraseDictationOptions {
  transport: TranscribeTransport;
  onLevel?(level: number): void;
  onPhase?(phase: DictationPhase): void;
  onPhrase?(phrase: string): void;
  onPending?(pending: number): void;
  onError?(error: unknown): void;
  maxSeconds?: number;
  getMedia?: () => Promise<MediaStream>;
  createCapture?: PcmCaptureFactory;
}

/** Phrase-by-phrase dictation with ordered delivery and a live editable composer. */
export class PhraseDictationAdapter implements DictationAdapter {
  readonly disableInputDuringDictation = false;
  private activeSession: DictationAdapter.Session | undefined;

  constructor(private readonly options: PhraseDictationOptions) {}

  static isSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      audioContextConstructor() !== undefined
    );
  }

  async finishActive(): Promise<void> {
    await this.activeSession?.stop();
  }

  listen(): DictationAdapter.Session {
    const o = this.options;
    const speech = new Set<(result: DictationAdapter.Result) => void>();
    const starts = new Set<() => void>();
    const ends = new Set<(result: DictationAdapter.Result) => void>();
    let stream: MediaStream | undefined;
    let capture: PcmCapture | undefined;
    let segmenter: PhraseSegmenter | undefined;
    let cancelled = false;
    let stopped = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivery = Promise.resolve();
    const active = new Set<string>();
    let pending = 0;

    const session: DictationAdapter.Session = {
      status: { type: "starting" },
      stop: async () => {},
      cancel: () => {},
      onSpeechStart(callback) {
        starts.add(callback);
        return () => starts.delete(callback);
      },
      onSpeechEnd(callback) {
        ends.add(callback);
        return () => ends.delete(callback);
      },
      onSpeech(callback) {
        speech.add(callback);
        return () => speech.delete(callback);
      },
    };

    const setPending = (next: number) => {
      pending = next;
      o.onPending?.(next);
    };
    const teardown = () => {
      if (timer !== undefined) clearTimeout(timer);
      capture?.stop();
      capture = undefined;
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
      o.onLevel?.(0);
    };
    const finish = (reason: "stopped" | "cancelled" | "error") => {
      if (finished) return;
      finished = true;
      session.status = { type: "ended", reason };
      if (this.activeSession === session) this.activeSession = undefined;
      o.onPhase?.("idle");
      for (const callback of ends) callback({ transcript: "", isFinal: true });
    };
    const transcribe = async (samples: Int16Array): Promise<string> => {
      let id: string | undefined;
      try {
        id = await o.transport.begin("audio/wav");
        active.add(id);
        const encoded = bytesToBase64(encodePcmWav(samples));
        for (const chunk of chunkBase64(encoded)) {
          if (cancelled) throw new Error("cancelled");
          await o.transport.chunk(id, chunk);
        }
        return (await o.transport.end(id)).trim();
      } catch (error) {
        if (id) await o.transport.cancel(id).catch(() => {});
        if (!cancelled) o.onError?.(error);
        return "";
      } finally {
        if (id) active.delete(id);
      }
    };
    const enqueue = (samples: Int16Array) => {
      setPending(pending + 1);
      const result = transcribe(samples);
      delivery = delivery.then(async () => {
        try {
          const phrase = await result;
          if (!cancelled && phrase) {
            for (const callback of speech) callback({ transcript: phrase, isFinal: true });
            o.onPhrase?.(phrase);
          }
        } catch (error) {
          if (!cancelled) o.onError?.(error);
        } finally {
          setPending(Math.max(0, pending - 1));
        }
      });
    };
    const start = async () => {
      o.onPhase?.("starting");
      try {
        await o.transport.check?.();
        stream = await (o.getMedia ?? (() => navigator.mediaDevices.getUserMedia({ audio: true })))();
        if (cancelled || stopped) {
          teardown();
          finish(cancelled ? "cancelled" : "stopped");
          return;
        }
        segmenter = new PhraseSegmenter({
          ...(o.onLevel ? { onLevel: o.onLevel } : {}),
          onSegment: enqueue,
        });
        capture = await (o.createCapture ?? createBrowserPcmCapture)(stream, (chunk) => segmenter?.push(chunk));
        session.status = { type: "running" };
        o.onPhase?.("listening");
        for (const callback of starts) callback();
        timer = setTimeout(() => void session.stop(), (o.maxSeconds ?? 90) * 1000);
      } catch (error) {
        teardown();
        o.onError?.(error);
        finish("error");
      }
    };

    session.stop = async () => {
      if (stopped || cancelled) return;
      stopped = true;
      capture?.stop();
      capture = undefined;
      segmenter?.finish();
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
      if (pending > 0) o.onPhase?.("transcribing");
      await delivery;
      finish("stopped");
    };
    session.cancel = () => {
      if (cancelled || finished) return;
      cancelled = true;
      teardown();
      for (const id of active) void o.transport.cancel(id).catch(() => {});
      finish("cancelled");
    };

    this.activeSession = session;
    void start();
    return session;
  }
}
