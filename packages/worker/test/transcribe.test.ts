/**
 * The dictation backend's subtle parts, and only those (testing policy):
 * key precedence and the OAuth refusal, the container table, and the pre-send
 * transform's race — a phrase claimed by a prompt while it is in flight must
 * reach the prompt and must not also reach the composer.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import type { ProviderAuthInfo } from "@lasercode/protocol";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIBE_BASE_URL,
  DEFAULT_TRANSCRIBE_MODEL,
  TRANSCRIBE_LANGUAGE,
  TranscribeError,
  TranscribeService,
  audioExtensionFor,
  followEnvelope,
  forgetIgnoredLanguageNotices,
  languageFieldFor,
  levelToUnit,
  loadTranscribeConfig,
  resolveTranscriptionKey,
  transcribeBridge,
  type KeySources,
} from "../src/transcribe.js";

/** Every value sent under one multipart field name, in order. */
function multipartField(body: string, name: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`name="${name.replace(/[[\]]/g, "\\$&")}"\r\n\r\n([^\r]*)\r\n`, "g");
  for (const match of body.matchAll(pattern)) values.push(match[1] ?? "");
  return values;
}

const provider = (id: string, over: Partial<ProviderAuthInfo> = {}): ProviderAuthInfo => ({
  id,
  name: id,
  configured: true,
  oauth: false,
  subscription: false,
  modelCount: 1,
  ...over,
});

const keys = (over: Partial<KeySources> = {}): KeySources => ({
  providerKey: async () => undefined,
  providers: async () => [],
  env: {},
  ...over,
});

function configDir(): string {
  const home = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-transcribe-`));
  mkdirSync(join(home, "pi-gpt-transcribe"), { recursive: true });
  return home;
}

beforeEach(() => {
  // The "said once" guard is process-wide, like the log it protects.
  forgetIgnoredLanguageNotices();
});

describe("loadTranscribeConfig", () => {
  it("works with no file at all", () => {
    const config = loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() });
    expect(config.model).toBe(DEFAULT_TRANSCRIBE_MODEL);
    expect(config.baseUrl).toBe(DEFAULT_TRANSCRIBE_BASE_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads pi-gpt-transcribe's own file and trims the base URL", () => {
    const home = configDir();
    writeFileSync(
      join(home, "pi-gpt-transcribe", "config.json"),
      JSON.stringify({ model: "whisper-1", baseUrl: "https://gw.example/v1///", keywords: [PRODUCT_NAME, ""], languages: [] }),
    );
    const config = loadTranscribeConfig({ XDG_CONFIG_HOME: home });
    expect(config.model).toBe("whisper-1");
    expect(config.baseUrl).toBe("https://gw.example/v1");
    expect(config.keywords).toEqual([PRODUCT_NAME]);
    // An empty array is "not configured", not "no languages".
    expect(config.languages).toBeUndefined();
  });

  it("falls back to defaults rather than throwing on malformed JSON", () => {
    const home = configDir();
    writeFileSync(join(home, "pi-gpt-transcribe", "config.json"), "{ not json");
    expect(loadTranscribeConfig({ XDG_CONFIG_HOME: home }).model).toBe(DEFAULT_TRANSCRIBE_MODEL);
  });
});

describe("resolveTranscriptionKey", () => {
  const config = loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() });

  it("prefers the config file, then the environment, then Pi's own credential", async () => {
    expect(await resolveTranscriptionKey({ ...config, apiKey: "from-file" }, keys({ env: { OPENAI_API_KEY: "from-env" } }))).toBe(
      "from-file",
    );
    expect(await resolveTranscriptionKey(config, keys({ env: { OPENAI_API_KEY: "from-env" } }))).toBe("from-env");
    expect(
      await resolveTranscriptionKey(
        config,
        keys({ providers: async () => [provider("openai")], providerKey: async () => "from-pi" }),
      ),
    ).toBe("from-pi");
  });

  it("refuses an OAuth-backed openai credential by name, not with a 401 later", async () => {
    const error = await resolveTranscriptionKey(
      config,
      keys({ providers: async () => [provider("openai", { oauth: true })], providerKey: async () => "oauth-bearer" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranscribeError);
    expect((error as TranscribeError).reason).toBe("oauth_key");
    expect((error as TranscribeError).message).toContain("ChatGPT account sign-in");
    expect((error as TranscribeError).message).toContain("Settings → Providers and models");
  });

  it("names the OAuth providers a person actually signed in with", async () => {
    const error = await resolveTranscriptionKey(
      config,
      keys({
        providers: async () => [
          provider("openai-codex", { oauth: true, subscription: true }),
          provider("openrouter", { oauth: true }),
          provider("anthropic", { configured: false }),
        ],
      }),
    ).catch((e: unknown) => e);
    expect((error as TranscribeError).reason).toBe("oauth_key");
    expect((error as TranscribeError).message).toContain("openai-codex, openrouter");
    // The unconfigured provider is not blamed.
    expect((error as TranscribeError).message).not.toContain("anthropic");
  });

  it("says what to do when there is no key at all", async () => {
    const error = await resolveTranscriptionKey(config, keys()).catch((e: unknown) => e);
    expect((error as TranscribeError).reason).toBe("no_key");
    expect((error as TranscribeError).message).toContain("OpenAI platform API key");
    expect((error as TranscribeError).message).toContain("Settings → Providers and models");
  });
});

describe("audioExtensionFor", () => {
  it("ignores codec parameters and casing", () => {
    expect(audioExtensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtensionFor("AUDIO/MP4")).toBe("mp4");
    expect(audioExtensionFor("audio/wav")).toBe("wav");
  });

  it("refuses an unknown container with the accepted list", () => {
    const error = (() => {
      try {
        audioExtensionFor("audio/amr");
      } catch (e) {
        return e as TranscribeError;
      }
      return undefined;
    })();
    expect(error?.reason).toBe("unsupported_audio");
    expect(error?.message).toContain("webm");
  });
});

describe("TranscribeService", () => {
  const services: TranscribeService[] = [];
  const build = (
    fetchImpl: typeof fetch,
    over: Partial<ConstructorParameters<typeof TranscribeService>[0]> = {},
  ): TranscribeService => {
    const service = new TranscribeService({
      keys: keys({ env: { OPENAI_API_KEY: "k" } }),
      config: loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() }),
      fetchImpl,
      ...over,
    });
    services.push(service);
    return service;
  };

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
  });

  const ok = (text: string): typeof fetch =>
    (async () => new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  const audio = Buffer.from("fake-opus-bytes").toString("base64");

  it("uploads in chunks and returns the transcript", async () => {
    const service = build(ok("  hello there  "));
    const { id } = service.begin({ mimeType: "audio/webm" });
    service.chunk(id, audio);
    service.chunk(id, audio);
    await expect(service.end(id)).resolves.toEqual({ text: "hello there" });
  });

  /** The multipart body of the one request a recording makes. */
  const recorded = async (
    over: Partial<ConstructorParameters<typeof TranscribeService>[0]> = {},
    begin: Parameters<TranscribeService["begin"]>[0] = { mimeType: "audio/mp4" },
  ): Promise<string> => {
    let body = "";
    const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
      body = Buffer.from(init.body as Uint8Array).toString("utf8");
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const service = build(capture, over);
    const { id } = service.begin(begin);
    service.chunk(id, audio);
    await service.end(id);
    return body;
  };

  const withConfig = (
    over: Partial<ReturnType<typeof loadTranscribeConfig>>,
  ): { config: ReturnType<typeof loadTranscribeConfig> } => ({
    config: { ...loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() }), ...over },
  });

  it("sends the model and the right filename extension", async () => {
    const body = await recorded();
    expect(body).toContain('filename="audio.mp4"');
    expect(multipartField(body, "model")).toEqual([DEFAULT_TRANSCRIBE_MODEL]);
  });

  it("pins English with the field the default model documents, and never both fields", async () => {
    // gpt-transcribe takes the set of expected languages, and its guide says
    // that field replaces the singular one — sending both is refused.
    expect(DEFAULT_TRANSCRIBE_MODEL).toBe("gpt-transcribe");
    const body = await recorded();
    expect(multipartField(body, "languages[]")).toEqual([TRANSCRIBE_LANGUAGE]);
    expect(multipartField(body, "language")).toEqual([]);
  });

  it("pins English with the singular field on every other transcription model", async () => {
    for (const model of ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize"]) {
      const body = await recorded(withConfig({ model }));
      expect(multipartField(body, "language"), model).toEqual([TRANSCRIBE_LANGUAGE]);
      expect(multipartField(body, "languages[]"), model).toEqual([]);
    }
    // A model id nobody has heard of gets the parameter every model but
    // gpt-transcribe accepts, rather than a guess.
    expect(languageFieldFor("some-gateway/stt-v9")).toBe("language");
    expect(languageFieldFor(" GPT-Transcribe ")).toBe("languages[]");
  });

  it("ignores a configured language and a per-recording hint, and says so once", async () => {
    const lines: string[] = [];
    const options = {
      ...withConfig({ languages: ["ar"] }),
      log: (message: string) => lines.push(message),
    };

    const first = await recorded(options, { mimeType: "audio/webm", language: "fr" });
    expect(multipartField(first, "languages[]")).toEqual([TRANSCRIBE_LANGUAGE]);
    expect(first).not.toContain('name="language"');
    // Neither value reaches the request in any shape.
    expect(first).not.toMatch(/\bar\b/);
    expect(first).not.toMatch(/\bfr\b/);
    expect(lines.filter((line) => line.includes('"ar"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"fr"'))).toHaveLength(1);
    expect(lines[0]).toContain("always transcribes English");
    expect(lines.find((line) => line.includes('"ar"'))).toContain("config.json");

    // A second phrase is not a second complaint: this is per recording.
    await recorded(options, { mimeType: "audio/webm", language: "fr" });
    expect(lines).toHaveLength(2);
  });

  it("keeps the keywords and prompt the person did configure", async () => {
    const body = await recorded(withConfig({ prompt: "a session about account AC-42", keywords: ["AC-42"], languages: ["de"] }));
    expect(multipartField(body, "prompt")).toEqual(["a session about account AC-42"]);
    expect(multipartField(body, "keywords[]")).toEqual(["AC-42"]);
    expect(multipartField(body, "languages[]")).toEqual([TRANSCRIBE_LANGUAGE]);
  });

  it("returns an empty transcript for a recording with no audio", async () => {
    const service = build(ok("should not be called"));
    const { id } = service.begin({ mimeType: "audio/webm" });
    await expect(service.end(id)).resolves.toEqual({ text: "" });
  });

  it("refuses a second end() for an id it no longer holds, in words", async () => {
    const service = build(ok("once"));
    const { id } = service.begin({ mimeType: "audio/webm" });
    service.chunk(id, audio);
    await service.end(id);
    await expect(service.end(id)).rejects.toThrow(/no longer being uploaded/);
  });

  it("gives a phrase in flight to the prompt that was submitted, exactly once", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const slow: typeof fetch = (async () => {
      await held;
      return new Response(JSON.stringify({ text: "the last phrase" }), { status: 200 });
    }) as unknown as typeof fetch;

    const service = build(slow);
    const path = "/sessions/a.jsonl";
    const { id } = service.begin({ mimeType: "audio/webm", sessionPath: path });
    service.chunk(id, audio);

    const ending = service.end(id);
    // The person presses Enter while the phrase is still being transcribed.
    const draining = service.drain(path, 5_000);
    release?.();

    await expect(draining).resolves.toBe("the last phrase");
    // ...and the composer is not given it a second time.
    await expect(ending).resolves.toEqual({ text: "" });
  });

  it("hands a phrase back to the composer when the pre-send wait times out", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const slow: typeof fetch = (async () => {
      await held;
      return new Response(JSON.stringify({ text: "arrived late" }), { status: 200 });
    }) as unknown as typeof fetch;

    const service = build(slow);
    const path = "/sessions/late.jsonl";
    const { id } = service.begin({ mimeType: "audio/webm", sessionPath: path });
    service.chunk(id, audio);
    const ending = service.end(id);

    // The prompt is not held open forever; the deadline wins.
    await expect(service.drain(path, 20)).resolves.toBe("");
    release?.();
    // ...and the phrase is not lost with it — it lands in the composer instead.
    await expect(ending).resolves.toEqual({ text: "arrived late" });
  });

  it("leaves a recording that is still being spoken alone", async () => {
    const service = build(ok("later"));
    const path = "/sessions/b.jsonl";
    service.begin({ mimeType: "audio/webm", sessionPath: path });
    // Nothing has been uploaded yet: draining must not wait for the microphone.
    await expect(service.drain(path, 50)).resolves.toBe("");
  });

  it("only claims phrases from the session that submitted", async () => {
    const service = build(ok("mine"));
    const { id } = service.begin({ mimeType: "audio/webm", sessionPath: "/sessions/a.jsonl" });
    service.chunk(id, audio);
    const ending = service.end(id);
    await expect(service.drain("/sessions/other.jsonl", 50)).resolves.toBe("");
    await expect(ending).resolves.toEqual({ text: "mine" });
  });

  it("ships dictation as built in and reports a missing provider in product language", async () => {
    const builtIn = new TranscribeService({
      keys: keys({ env: { OPENAI_API_KEY: "k" } }),
      config: loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() }),
    });
    services.push(builtIn);
    await expect(builtIn.status()).resolves.toEqual({ available: true, provider: "openai" });

    const noKey = new TranscribeService({
      keys: keys({ providers: async () => [provider("openai-codex", { oauth: true })] }),
      config: loadTranscribeConfig({ XDG_CONFIG_HOME: configDir() }),
    });
    services.push(noKey);
    const denied = await noKey.status();
    expect(denied.available).toBe(false);
    expect(denied.reason).toContain("openai-codex");
    expect(denied.reason).not.toContain("pi-gpt-transcribe");
  });

  it("publishes and withdraws the in-process bridge the companion extension looks up", async () => {
    const service = build(ok("x"));
    expect(transcribeBridge()).toBeUndefined();
    service.register();
    const bridge = transcribeBridge();
    expect(bridge).toBeDefined();
    expect(bridge?.isActive("/sessions/a.jsonl")).toBe(false);
    service.begin({ mimeType: "audio/webm", sessionPath: "/sessions/a.jsonl" });
    expect(bridge?.isActive("/sessions/a.jsonl")).toBe(true);
    service.dispose();
    expect(transcribeBridge()).toBeUndefined();
  });
});

describe("the waveform mapping", () => {
  it("puts room tone at the floor and speech in the upper half", () => {
    // A linear meter is why the first version of the TUI widget looked dead:
    // conversational speech is 0.03–0.1 RMS, the bottom tenth of a linear bar.
    expect(levelToUnit(0)).toBe(0);
    expect(levelToUnit(0.001)).toBeCloseTo(0, 1); // −60 dBFS
    expect(levelToUnit(0.05)).toBeGreaterThan(0.5); // ≈ −26 dBFS
    expect(levelToUnit(1)).toBe(1);
  });

  it("rises almost instantly and falls over a few frames", () => {
    expect(followEnvelope(0, 1)).toBeCloseTo(0.85, 5);
    expect(followEnvelope(1, 0)).toBeCloseTo(0.65, 5);
  });
});
