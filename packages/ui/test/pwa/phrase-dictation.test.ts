import { describe, expect, it } from "vitest";

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

describe("PhraseDictationAdapter", () => {
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
