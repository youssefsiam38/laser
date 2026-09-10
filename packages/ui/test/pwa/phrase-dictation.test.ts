import { afterEach, describe, expect, it, vi } from "vitest";

import { PhraseDictationAdapter, PhraseSegmenter, encodePcmWav } from "../../src/pwa/phrase-dictation.js";

const pcm = (count: number, value: number) => Int16Array.from({ length: count }, () => value);

describe("PhraseSegmenter", () => {
  it("cuts voiced audio after the configured quiet holdoff", () => {
    const segments: Int16Array[] = [];
    const segmenter = new PhraseSegmenter({
      sampleRate: 10,
      minSegmentSeconds: 0.2,
      maxSegmentSeconds: 10,
      silenceHoldoffMs: 200,
      onSegment: (segment) => segments.push(segment),
    });
    segmenter.push(pcm(3, 16_000));
    segmenter.push(pcm(2, 0));
    expect(segments).toHaveLength(1);
    expect([...segments[0]!]).toEqual([16_000, 16_000, 16_000, 0, 0]);
  });

  it("cuts long continuous speech into bounded chunks without ending capture", () => {
    const segments: Int16Array[] = [];
    const segmenter = new PhraseSegmenter({ sampleRate: 10, minSegmentSeconds: 0.2, maxSegmentSeconds: 1, onSegment: (segment) => segments.push(segment) });
    for (let i = 0; i < 30; i++) segmenter.push(pcm(5, 16_000));
    expect(segments).toHaveLength(15);
    expect(segments.every((segment) => segment.length === 10)).toBe(true);
  });

  it("does not send room tone as a phrase", () => {
    const segments: Int16Array[] = [];
    const segmenter = new PhraseSegmenter({ sampleRate: 10, minSegmentSeconds: 0.2, maxSegmentSeconds: 1, onSegment: (segment) => segments.push(segment) });
    segmenter.push(pcm(12, 0));
    segmenter.finish();
    expect(segments).toEqual([]);
  });
});

describe("encodePcmWav", () => {
  it("writes a valid mono 16-bit WAV header", () => {
    const wav = encodePcmWav(Int16Array.from([1, -2]));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
  });
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function recording(overrides: Partial<ConstructorParameters<typeof PhraseDictationAdapter>[0]> = {}) {
  let emit!: (chunk: Int16Array) => void;
  let interrupt!: () => void;
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const capture = { stop: vi.fn() };
  const transport = { check: vi.fn(async () => {}), begin: vi.fn(async () => "upload"), chunk: vi.fn(async () => {}), end: vi.fn(async () => "spoken"), cancel: vi.fn(async () => {}) };
  const onPhrase = vi.fn(), onError = vi.fn(), onPhase = vi.fn(), onPending = vi.fn();
  const getMedia = vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  const adapter = new PhraseDictationAdapter({ transport, onPhrase, onError, onPhase, onPending, getMedia,
    createCapture: async (_stream, onChunk, onInterrupted) => { emit = onChunk; interrupt = onInterrupted; return capture; }, ...overrides });
  return { adapter, transport, capture, track, getMedia, onPhrase, onError, onPhase, onPending,
    speak: () => { emit(pcm(6_000, 16_000)); }, pause: () => emit(pcm(8_000, 0)), interrupt: () => interrupt() };
}
afterEach(() => vi.useRealTimers());

describe("PhraseDictationAdapter", () => {
  it("keeps listening past 90 seconds and through hours of chunked speech until explicitly stopped", async () => {
    vi.useFakeTimers();
    const r = recording();
    const session = r.adapter.listen();
    await settle();
    for (let hour = 0; hour < 3; hour++) {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      r.speak(); r.pause(); await settle();
      expect(session.status.type).toBe("running");
      expect(r.capture.stop).not.toHaveBeenCalled();
    }
    expect(r.onPhrase).toHaveBeenCalledTimes(3);
    await session.stop();
    expect(session.status).toEqual({ type: "ended", reason: "stopped" });
    expect(r.track.stop).toHaveBeenCalledOnce();
  });

  it("discards captured audio without flushing, transcribing or publishing a phrase", async () => {
    const r = recording(); const session = r.adapter.listen(); await settle(); r.speak();
    const end = vi.fn(); session.onSpeechEnd(end);
    r.adapter.cancelActive(); await session.stop();
    expect(r.transport.begin).not.toHaveBeenCalled();
    expect(r.onPhrase).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
    expect(r.track.stop).toHaveBeenCalledOnce();
    expect(session.status).toEqual({ type: "ended", reason: "cancelled" });
  });

  it("aborts an in-flight transcription and ignores its late result after another recording starts", async () => {
    const r = recording(); const result = deferred<string>();
    r.transport.end.mockImplementationOnce(() => result.promise);
    const session = r.adapter.listen(); await settle(); r.speak(); r.pause(); await settle();
    const speech = vi.fn(); session.onSpeech(speech);
    const stopping = session.stop(); session.cancel();
    expect(r.transport.cancel).toHaveBeenCalledWith("upload");
    const next = r.adapter.listen(); await settle();
    r.onPhase.mockClear(); r.onPending.mockClear();
    result.resolve("discard this"); await stopping; await settle();
    expect(speech).not.toHaveBeenCalled(); expect(r.onPhrase).not.toHaveBeenCalled();
    expect(r.onPhase).not.toHaveBeenCalled(); expect(r.onPending).not.toHaveBeenCalled();
    expect(next.status.type).toBe("running"); next.cancel();
  });

  it("cancels a late upload id without sending any bytes", async () => {
    const r = recording(); const opened = deferred<string>();
    r.transport.begin.mockImplementationOnce(() => opened.promise);
    const session = r.adapter.listen(); await settle(); r.speak(); r.pause(); session.cancel();
    opened.resolve("late-id"); await settle();
    expect(r.transport.cancel).toHaveBeenCalledWith("late-id");
    expect(r.transport.chunk).not.toHaveBeenCalled(); expect(r.transport.end).not.toHaveBeenCalled();
  });

  it("does not request a microphone when cancelled during the provider check", async () => {
    const r = recording(); const checked = deferred<void>();
    r.transport.check.mockImplementationOnce(() => checked.promise);
    const session = r.adapter.listen(); session.cancel(); checked.resolve(); await settle();
    expect(r.getMedia).not.toHaveBeenCalled();
  });

  it("releases a microphone granted after cancellation without starting capture", async () => {
    const permission = deferred<MediaStream>(); const createCapture = vi.fn();
    const r = recording({ getMedia: () => permission.promise, createCapture });
    const session = r.adapter.listen(); await settle(); session.cancel();
    permission.resolve({ getTracks: () => [r.track] } as unknown as MediaStream); await settle();
    expect(r.track.stop).toHaveBeenCalledOnce(); expect(createCapture).not.toHaveBeenCalled();
  });

  it.each(["stop", "cancel"] as const)("does not resurrect recording after %s during capture startup", async (action) => {
    const opening = deferred<{ stop(): void }>();
    const r = recording({ createCapture: () => opening.promise });
    const session = r.adapter.listen(); await settle(); await session[action]();
    opening.resolve(r.capture); await settle();
    expect(r.capture.stop).toHaveBeenCalledOnce(); expect(r.onPhase).not.toHaveBeenCalledWith("listening");
  });

  it("does not allow a pending send to continue after the person discards recording", async () => {
    const r = recording(); const result = deferred<string>(); r.transport.end.mockImplementationOnce(() => result.promise);
    r.adapter.listen(); await settle(); r.speak();
    const finishing = r.adapter.finishActive(); await settle(); r.adapter.cancelActive();
    result.resolve("late phrase"); await expect(finishing).resolves.toBe(false);
    expect(r.onPhrase).not.toHaveBeenCalled();
  });

  it("shares the pending flush across repeated stop requests", async () => {
    const r = recording(); const result = deferred<string>(); r.transport.end.mockImplementationOnce(() => result.promise);
    const session = r.adapter.listen(); await settle(); r.speak();
    const first = session.stop(), second = session.stop();
    expect(first).toBe(second); await settle(); result.resolve("last phrase"); await second;
    expect(r.onPhrase).toHaveBeenCalledWith("last phrase");
  });

  it.each(["track", "context"])("reports a %s interruption and releases the microphone", async (kind) => {
    const r = recording(); const session = r.adapter.listen(); await settle();
    if (kind === "track") r.track.dispatchEvent(new Event("ended")); else r.interrupt();
    expect(r.onError.mock.calls[0]?.[0].message).toContain("Recording was interrupted");
    expect(r.track.stop).toHaveBeenCalledOnce(); expect(session.status.type).toBe("ended");
  });

  it("refuses a second microphone owner without replacing the first", async () => {
    const r = recording(); const session = r.adapter.listen(); await settle();
    expect(() => r.adapter.listen()).toThrow("another composer");
    expect(session.status.type).toBe("running"); session.cancel();
  });

  it("transcribes phrases concurrently but inserts them in spoken order", async () => {
    let emit!: (chunk: Int16Array) => void;
    let ready!: () => void;
    const captureReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const releases: Array<(text: string) => void> = [];
    let count = 0;
    const adapter = new PhraseDictationAdapter({
      transport: {
        check: async () => {},
        begin: async () => String(++count),
        chunk: async () => {},
        end: async () => new Promise<string>((resolve) => releases.push(resolve)),
        cancel: async () => {},
      },
      getMedia: async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      createCapture: async (_stream, onChunk) => {
        emit = onChunk;
        ready();
        return { stop() {} };
      },
    });
    const phrases: string[] = [];
    const session = adapter.listen();
    session.onSpeech((result) => phrases.push(result.transcript));
    await captureReady;

    emit(pcm(6_000, 16_000));
    emit(pcm(8_000, 0));
    emit(pcm(6_000, 12_000));
    emit(pcm(8_000, 0));
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    const stopping = session.stop();
    releases[1]!("second");
    await Promise.resolve();
    expect(phrases).toEqual([]);
    releases[0]!("first");
    await stopping;
    expect(phrases).toEqual(["first", "second"]);
  });
});
