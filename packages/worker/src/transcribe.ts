/**
 * Dictation backend (M8-T2).
 *
 * pi-gpt-transcribe refuses to start unless `ctx.mode === "tui"`: it captures
 * the microphone from the terminal process, draws a TUI waveform component, and
 * writes into Pi's own editor with `pasteToEditor`. None of that exists in a
 * browser, so laser does not drive the package — it reimplements the same
 * contract on this side of the wire and keeps the package as the *configuration*
 * and the *reason the affordance is offered at all* (see modules/transcribe.ts).
 *
 * What lives where:
 *
 *   browser   microphone, voice-activity segmentation, the level meter, and
 *             inserting each phrase at the composer cursor without stealing
 *             focus. The browser owns `level`; nothing else can measure it.
 *   worker    this file: the API key, the network call, retries, the pending /
 *             inserted / error counters, and the phrase that finishes after
 *             the prompt was submitted.
 *
 * `WidgetState` from pi-gpt-transcribe 0.2.1 (`src/widget.ts`) is the contract
 * kept across that split — `{ level, pending, inserted, error, startedAt }` —
 * so the native waveform shows exactly what the terminal one shows.
 *
 * The spoken language is not one of the things either side chooses: every
 * request pins the input-language hint to English rather than letting the API
 * detect it ({@link TRANSCRIBE_LANGUAGE}, `docs/dictation-language.md`).
 *
 * The one thing that cannot be done in the browser is the pre-send transform.
 * A phrase still being transcribed when you press Enter belongs to the prompt
 * you just sent, not to the next one, and only something inside the Pi process
 * can hold the prompt open while it lands. {@link TranscribeService.drain} is
 * that hold; `modules/transcribe.ts` awaits it from Pi's `input` hook.
 */

import { PRODUCT_NAME, symbolKey } from "@lasercode/protocol";
import type { ProviderAuthInfo, TranscribeStatus } from "@lasercode/protocol";
import { randomBytes } from "node:crypto";
import {
  configPath as packageConfigPath,
  loadConfig as loadPackageConfig,
  CONFIG_DIR_NAME,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type DictationState,
} from "pi-gpt-transcribe/core";

// ---------------------------------------------------------------------------
// Configuration — read from pi-gpt-transcribe's own file, so one edit serves
// the terminal and laser.
//
// The parsing is the package's, not ours. It is the package's file format, and
// a second parser for it is a copy that drifts silently: a key added on that
// side keeps parsing here, it just stops meaning anything. Importing the
// definitions turns that into a build error, which is why the package now
// publishes its terminal-free half as `pi-gpt-transcribe/core`.
//
// The *shape* stays ours. The package's config carries terminal concerns —
// hotkey, voice-activity thresholds, segment lengths — that belong to the
// side doing the capture, and here that is the browser.
// ---------------------------------------------------------------------------

/** The pinned copy, reported by `doctor` and in the capability report. */
export const TRANSCRIBE_PACKAGE_VERSION = PACKAGE_VERSION;

export const TRANSCRIBE_CONFIG_DIR_NAME = CONFIG_DIR_NAME;
export const TRANSCRIBE_PACKAGE_NAME = PACKAGE_NAME;
export const DEFAULT_TRANSCRIBE_MODEL = DEFAULT_MODEL;
export const DEFAULT_TRANSCRIBE_BASE_URL = DEFAULT_BASE_URL;
export const DEFAULT_TRANSCRIBE_KEY_ENV = DEFAULT_API_KEY_ENV;

/** The provider whose credential the audio endpoint accepts. Never the session's model provider. */
export const TRANSCRIBE_PROVIDER = "openai";

export interface TranscribeConfig {
  readonly model: string;
  /** API root, no trailing slash. Points at a gateway or Azure-style proxy when set. */
  readonly baseUrl: string;
  /** Literal key from the config file. */
  readonly apiKey: string | undefined;
  readonly apiKeyEnv: string;
  /** Free-form context: jargon, project names, style. */
  readonly prompt: string | undefined;
  readonly keywords: readonly string[] | undefined;
  /**
   * ISO-639-1 hints from the package's config file. Parsed so a typo in that
   * file still cannot break dictation — and then ignored: dictation is English,
   * always ({@link TRANSCRIBE_LANGUAGE}, `docs/dictation-language.md`).
   * A value here is reported once and dropped.
   */
  readonly languages: readonly string[] | undefined;
  /** Where the file was read from, for error messages that tell you what to edit. */
  readonly configPath: string;
}

export function transcribeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return packageConfigPath(env);
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const strArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(str).filter((v): v is string => v !== undefined);
  return items.length > 0 ? items : undefined;
};

/**
 * Load the config. A missing, unreadable or malformed file resolves to
 * defaults: the same crash-resistance the package itself has, for the same
 * reason — a typo in JSON must not take dictation away, it must take away the
 * setting that was typed wrong.
 */
export function loadTranscribeConfig(env: NodeJS.ProcessEnv = process.env): TranscribeConfig {
  // Every value is optional and a malformed file resolves to defaults — the
  // package guarantees that, because an extension that throws on a typo takes
  // its own command down with it.
  const parsed = loadPackageConfig(env);
  return {
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    apiKey: parsed.apiKey,
    apiKeyEnv: parsed.apiKeyEnv,
    prompt: parsed.prompt,
    keywords: parsed.keywords,
    languages: parsed.languages,
    configPath: packageConfigPath(env),
  };
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

export type TranscribeErrorReason =
  | "no_key"
  /** Pi holds a credential for the provider, but it is an OAuth bearer token. */
  | "oauth_key"
  | "audio_rejected"
  | "network"
  | "unsupported_audio"
  /** An upload id this worker does not hold: it finished, was cancelled, or the worker restarted. */
  | "unknown_upload";

/**
 * Every failure a person can act on. `message` is the whole sentence shown in
 * the UI — no stack traces, no "an error occurred" (AGENTS.md, "Errors are
 * written for a person").
 */
export class TranscribeError extends Error {
  override readonly name = "TranscribeError";
  constructor(
    readonly reason: TranscribeErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface KeySources {
  /** Pi's own credential for a provider id, or undefined when it has none. */
  providerKey: (provider: string) => Promise<string | undefined>;
  /** Pi's auth status per provider, so an OAuth-only setup is named, not guessed. */
  providers: () => Promise<readonly ProviderAuthInfo[]>;
  env?: NodeJS.ProcessEnv;
}

/**
 * The key the audio endpoint will actually accept, in the order a person would
 * expect: the config file, the environment, then Pi's own `openai` credential.
 *
 * The provider id is deliberately `openai` and not the session's model
 * provider. This user's providers are OAuth-backed (`openai-codex`,
 * `openrouter`, `opencode`); those hand back a bearer token that
 * `/v1/audio/transcriptions` rejects with a 401, and a confusing 401 halfway
 * through a sentence is worse than a clear "no API key" before the microphone
 * ever opens. So an OAuth-only setup is detected here and named exactly.
 */
export async function resolveTranscriptionKey(config: TranscribeConfig, sources: KeySources): Promise<string> {
  if (config.apiKey) return config.apiKey;
  const env = sources.env ?? process.env;
  const fromEnv = str(env[config.apiKeyEnv]);
  if (fromEnv) return fromEnv;

  let providers: readonly ProviderAuthInfo[] = [];
  try {
    providers = await sources.providers();
  } catch {
    // Treated as "Pi could not tell us"; the no-key message below still applies.
  }
  const openai = providers.find((p) => p.id === TRANSCRIBE_PROVIDER);
  if (openai?.configured && !openai.oauth) {
    const key = await sources.providerKey(TRANSCRIBE_PROVIDER).catch(() => undefined);
    if (key) return key;
  }

  const oauthOnly = providers.filter((p) => p.configured && p.oauth).map((p) => p.id);
  const fix = `Add an OpenAI platform API key in Settings → Providers and models.`;
  if (openai?.configured && openai.oauth) {
    throw new TranscribeError(
      "oauth_key",
      `Dictation cannot use a ChatGPT account sign-in because audio transcription requires a platform API key. ${fix}`,
    );
  }
  if (oauthOnly.length > 0) {
    throw new TranscribeError(
      "oauth_key",
      `Dictation needs a platform OpenAI API key. Your signed-in providers (${oauthOnly.join(", ")}) use account access that cannot authorize audio transcription. ${fix}`,
    );
  }
  throw new TranscribeError("no_key", `Dictation needs an OpenAI API key. ${fix}`);
}

// ---------------------------------------------------------------------------
// The one network call
// ---------------------------------------------------------------------------

/**
 * Container formats `/v1/audio/transcriptions` accepts, mapped to the filename
 * extension the multipart part must carry (the API dispatches on it).
 *
 * A browser records what its engine supports and nothing else: Chromium gives
 * `audio/webm;codecs=opus`, WebKit gives `audio/mp4`. Both are on this list, so
 * neither needs a re-encode on the way. Anything not listed is refused before
 * the upload rather than after, with the list in the message.
 */
const AUDIO_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "mp4"],
  ["audio/mpeg", "mp3"],
  ["audio/mpga", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/flac", "flac"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);

/** `audio/webm;codecs=opus` → `webm`. Throws with the accepted list otherwise. */
export function audioExtensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = AUDIO_EXTENSIONS.get(base);
  if (extension) return extension;
  const accepted = [...new Set(AUDIO_EXTENSIONS.values())].sort().join(", ");
  throw new TranscribeError(
    "unsupported_audio",
    `${PRODUCT_NAME} cannot send ${base || "that audio format"} for transcription. Accepted containers: ${accepted}.`,
  );
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
/** Enough of an error body to see the API's own message, not an HTML page. */
const ERROR_BODY_LIMIT = 400;
const CRLF = "\r\n";
const ARRAY_FIELD_SUFFIX = "[]";

// ---------------------------------------------------------------------------
// English, always
//
// Dictation here is one person talking to a coding agent in English, with an
// accent and the occasional word from another language in the middle of a
// sentence. Left to auto-detect, one such word flips the whole phrase into
// another language — and a transliterated phrase in another script is not a
// prompt anyone can send. So the request says which language the audio is in
// rather than asking the API to guess: the field carries the *possible input
// languages*, and the endpoint writes the recording down in the language it
// decoded, so this steers the decoding to English — it does not translate, and
// the API promises no language for the text it returns. The product makes that
// choice, not a setting: `docs/dictation-language.md` has the citations.
// ---------------------------------------------------------------------------

/** The one language dictation transcribes, ISO-639-1. */
export const TRANSCRIBE_LANGUAGE = "en";

/** Models that take the plural set of expected languages. */
const MULTI_LANGUAGE_MODEL_PREFIX = "gpt-transcribe";

/**
 * The multipart field that pins the spoken language for a given model.
 *
 * `gpt-transcribe` (the default) takes `languages[]`, a set of expected input
 * languages, and the guide is explicit that for that model `languages`
 * *replaces* the singular `language` and that both must never be sent. Every
 * other model on `/v1/audio/transcriptions` — `whisper-1`, `gpt-4o-transcribe`,
 * `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` — takes the singular
 * `language`, and the reference marks `languages` as supported by
 * `gpt-transcribe` alone. Hence one field per model, never both: the endpoint
 * rejects the whole request over a field it does not accept, and a rejected
 * request is silence where a phrase should have been.
 */
export function languageFieldFor(model: string): string {
  // A gateway namespaces the id it forwards (`openai/gpt-transcribe`), so the
  // model is the last segment; the prefix still cannot catch `gpt-4o-transcribe`.
  const id = model.trim().toLowerCase().split("/").pop() ?? "";
  return id.startsWith(MULTI_LANGUAGE_MODEL_PREFIX) ? `languages${ARRAY_FIELD_SUFFIX}` : "language";
}

/** Where an ignored language value came from, for the log line. */
type IgnoredLanguageSource = "config" | "request";

/** Values already reported, so a per-phrase request cannot log per phrase. */
const reportedLanguages = new Set<string>();

/** Test seam: forget what has already been reported. */
export function forgetIgnoredLanguageNotices(): void {
  reportedLanguages.clear();
}

export type TranscribeLog = (message: string) => void;

const defaultLog: TranscribeLog = (message) => {
  console.error(`${PRODUCT_NAME} worker: ${message}`);
};

/**
 * Say once — not once per phrase — that a language someone configured is not
 * being used. Silence would look like a bug in their config file; a line per
 * recording would be a flood.
 */
function noteIgnoredLanguages(
  values: readonly string[] | undefined,
  source: IgnoredLanguageSource,
  where: string | undefined,
  log: TranscribeLog,
): void {
  const ignored = (values ?? []).filter((value) => value.trim().toLowerCase() !== TRANSCRIBE_LANGUAGE);
  if (ignored.length === 0) return;
  const key = `${source}:${ignored.join(",")}`;
  if (reportedLanguages.has(key)) return;
  reportedLanguages.add(key);
  const listed = ignored.map((value) => `"${value}"`).join(", ");
  const origin = source === "config" ? `"languages" in ${where}` : "this recording's own language hint";
  const verb = ignored.length === 1 ? "is" : "are";
  log(`Dictation always transcribes English, so ${listed} from ${origin} ${verb} ignored.`);
}

export interface TranscribeAudioRequest {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly apiKey: string;
  readonly config: TranscribeConfig;
  readonly signal?: AbortSignal | undefined;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Where an ignored config value is reported. Defaults to the worker's log. */
  readonly log?: TranscribeLog | undefined;
}

/** A CR or LF in a config value would end its multipart part early. */
const sanitize = (value: string): string => value.replace(/[\r\n]+/g, " ");

/**
 * Multipart assembled by hand into one flat body rather than handed to
 * `FormData`.
 *
 * Pi replaces the global fetch with its own bundled undici, whose FormData
 * serializer enqueues into a ReadableStream it re-checks for *errored* but not
 * for *closed*. Aborting an upload closes that stream, the next enqueue throws
 * ERR_INVALID_STATE inside a floating async IIFE, and the rejection is
 * unhandled — it takes the process down and cannot be caught at the call site.
 * (Found and documented by pi-gpt-transcribe 0.2.1, `src/openai.ts`.) A flat
 * body never touches that path. The worker is a supervised process, so the
 * blast radius here is the whole project's session.
 */
function buildMultipart(request: TranscribeAudioRequest): { body: Uint8Array; contentType: string } {
  const { config } = request;
  const extension = audioExtensionFor(request.mimeType);
  const boundary = `----${PRODUCT_NAME}-transcribe-${randomBytes(16).toString("hex")}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${sanitize(value)}${CRLF}`,
      ),
    );
  };

  parts.push(
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.${extension}"${CRLF}Content-Type: ${sanitize(request.mimeType)}${CRLF}${CRLF}`,
    ),
    Buffer.from(request.audio),
    Buffer.from(CRLF),
  );
  field("model", config.model);
  if (config.prompt) field("prompt", config.prompt);
  for (const keyword of config.keywords ?? []) field(`keywords${ARRAY_FIELD_SUFFIX}`, keyword);
  // The pin, never the configured list. What was configured instead is reported
  // by the caller, once per recording rather than once per attempt.
  field(languageFieldFor(config.model), TRANSCRIBE_LANGUAGE);
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  // Copied into a plain ArrayBuffer: Node's pool-backed Buffer is not a BodyInit.
  const joined = Buffer.concat(parts);
  const body = new Uint8Array(new ArrayBuffer(joined.byteLength));
  body.set(joined);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 429, 408 and 5xx are worth another try; a 400 or 401 fails identically. */
const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

async function readErrorMessage(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // A body we cannot read is not worth a second failure mode.
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not JSON — the truncated raw body still identifies the problem.
  }
  return body.slice(0, ERROR_BODY_LIMIT) || response.statusText;
}

async function postOnce(request: TranscribeAudioRequest): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const { body, contentType } = buildMultipart(request);

  const send = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(`${request.config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": contentType },
      body,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TranscribeError(
      "network",
      `Could not reach ${request.config.baseUrl}. Check the connection, or the "baseUrl" in ${request.config.configPath}.`,
    );
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    const hint =
      response.status === 401
        ? ` The key was rejected — an OAuth token from a subscription provider will not work here; ${TRANSCRIBE_PROVIDER} needs a platform API key.`
        : "";
    throw new TranscribeError(
      "audio_rejected",
      `${request.config.model} returned ${response.status}: ${detail}.${hint}`,
      response.status,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  return typeof payload.text === "string" ? payload.text : "";
}

/**
 * Transcribe one recorded phrase. Resolves to the text, which is legitimately
 * empty for a segment of silence.
 */
export async function transcribeAudio(request: TranscribeAudioRequest): Promise<string> {
  // Once for the recording, outside the retry loop: a 429 and its retry are one
  // phrase, and the person's config was ignored once.
  noteIgnoredLanguages(request.config.languages, "config", request.config.configPath, request.log ?? defaultLog);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await postOnce(request);
    } catch (error) {
      lastError = error;
      // A stopped session is a decision, not a hiccup.
      if (request.signal?.aborted) throw error;
      const retryable = !(error instanceof TranscribeError) || (error.status !== undefined && isRetryableStatus(error.status));
      if (!retryable || attempt === MAX_ATTEMPTS) throw error;
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}


// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * `pi/transcribe/status`. The capability is bundled; `available` reports
 * whether the required OpenAI platform API key is ready.
 */
/** Re-exported so this file reads as one story; the wire type lives in the protocol. */
export type { TranscribeStatus };

/** Container the transcription API accepts, from `pi/transcribe/begin`. */
export interface BeginUpload {
  mimeType: string;
  /**
   * ISO-639-1 hint for this recording. Accepted so an older client still
   * dictates, and then ignored for the same reason the config's `languages` is:
   * every recording is transcribed as English ({@link TRANSCRIBE_LANGUAGE}).
   */
  language?: string | undefined;
  /**
   * The session this recording is being dictated into. Optional because a
   * client may not know it yet; without it the phrase cannot be held back for
   * that session's next prompt, so it is delivered to whoever asked.
   */
  sessionPath?: string | undefined;
}

/**
 * A recording being uploaded in base64 chunks.
 *
 * `late` is the whole pre-send transform in one flag: it is set the moment a
 * prompt is submitted for this upload's session, and from then on the text
 * belongs to that prompt rather than to the composer.
 */
interface Upload {
  readonly id: string;
  readonly mimeType: string;
  readonly language: string | undefined;
  readonly sessionPath: string | undefined;
  readonly startedAt: number;
  readonly chunks: Buffer[];
  bytes: number;
  /** Resolves when `end()` has finished (successfully or not). */
  settled: Promise<void> | undefined;
  /** True once `settled` has resolved. `drain` needs the answer synchronously. */
  done: boolean;
  late: boolean;
  /** Text that finished after `late` was set, waiting for the transform. */
  tail: string;
  readonly controller: AbortController;
}

/** The API's own ceiling is 25 MB per file; stop short of it, in the worker. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
/** More than this many recordings in flight at once is a runaway client. */
export const MAX_UPLOADS_IN_FLIGHT = 8;
/** Ceiling on the pre-send wait. Upstream's `DRAIN_TIMEOUT_MS`. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export interface TranscribeServiceOptions {
  keys: KeySources;
  /** Injected in tests; defaults to reading pi-gpt-transcribe's config file. */
  config?: TranscribeConfig;
  fetchImpl?: typeof fetch;
  drainTimeoutMs?: number;
  /** Where an ignored language value is reported. Defaults to the worker's log. */
  log?: TranscribeLog;
}

/**
 * The dictation backend for one worker (one project directory).
 *
 * Answers `pi/transcribe/{status,begin,chunk,end,cancel}` and publishes
 * {@link drain} to the companion extension in the same process, so a phrase
 * still in flight when Enter is pressed lands in that prompt.
 */
export class TranscribeService {
  private readonly uploads = new Map<string, Upload>();
  private readonly options: TranscribeServiceOptions;
  private config: TranscribeConfig | undefined;
  private counter = 0;

  constructor(options: TranscribeServiceOptions) {
    this.options = options;
    this.config = options.config;
  }

  /** Re-read on every recording, so a hand edit applies without a restart. */
  private currentConfig(): TranscribeConfig {
    this.config = this.options.config ?? loadTranscribeConfig();
    return this.config;
  }

  /**
   * Can this project dictate right now, and if not, why? Resolves the key, so
   * an OAuth-only setup is reported here — before the browser ever asks for
   * the microphone — rather than as a 401 mid-sentence.
   */
  async status(): Promise<TranscribeStatus> {
    const config = this.currentConfig();
    try {
      await resolveTranscriptionKey(config, this.options.keys);
    } catch (error) {
      return {
        available: false,
        provider: TRANSCRIBE_PROVIDER,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { available: true, provider: TRANSCRIBE_PROVIDER };
  }

  /**
   * Open an upload. The container is validated now, so an unsupported
   * recording is refused before its bytes are sent rather than after.
   */
  begin(options: BeginUpload): { id: string } {
    audioExtensionFor(options.mimeType);
    if (this.uploads.size >= MAX_UPLOADS_IN_FLIGHT) {
      throw new TranscribeError(
        "unsupported_audio",
        `Too many recordings are still uploading (${this.uploads.size}). Wait for one to finish, or stop dictation and start again.`,
      );
    }
    const id = `tr-${Date.now().toString(36)}-${++this.counter}`;
    this.uploads.set(id, {
      id,
      mimeType: options.mimeType,
      language: options.language,
      sessionPath: options.sessionPath,
      startedAt: Date.now(),
      chunks: [],
      bytes: 0,
      settled: undefined,
      done: false,
      late: false,
      tail: "",
      controller: new AbortController(),
    });
    return { id };
  }

  /** Append one base64 chunk, in order. */
  chunk(id: string, base64: string): void {
    const upload = this.take(id);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      throw new TranscribeError("unsupported_audio", "That audio chunk was not valid base64.");
    }
    if (upload.bytes + bytes.byteLength > MAX_UPLOAD_BYTES) {
      this.uploads.delete(id);
      throw new TranscribeError(
        "unsupported_audio",
        `That recording is longer than dictation accepts (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB). Stop and send in shorter passes.`,
      );
    }
    upload.chunks.push(bytes);
    upload.bytes += bytes.byteLength;
  }

  /**
   * Close the upload and transcribe it.
   *
   * Returns `""` when the phrase was claimed by a prompt while it was in
   * flight: it is not lost, it went into that prompt through {@link drain}, and
   * returning it here as well would say it twice.
   */
  async end(id: string): Promise<{ text: string }> {
    const upload = this.take(id);
    if (upload.settled) {
      await upload.settled;
      return { text: upload.late ? "" : upload.tail };
    }
    if (upload.bytes === 0) {
      this.uploads.delete(id);
      return { text: "" };
    }

    const config = this.currentConfig();
    const request = async (): Promise<void> => {
      try {
        const apiKey = await resolveTranscriptionKey(config, this.options.keys);
        const audio = concat(upload.chunks, upload.bytes);
        const log = this.options.log ?? defaultLog;
        // A client that still sends a per-recording language gets the same
        // answer the config file gets: noted once, then English.
        noteIgnoredLanguages(upload.language ? [upload.language] : undefined, "request", undefined, log);
        const text = await transcribeAudio({
          audio,
          mimeType: upload.mimeType,
          apiKey,
          config,
          signal: upload.controller.signal,
          log,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
        upload.tail = text.trim();
      } finally {
        // The bytes are the biggest thing this process holds; drop them the
        // moment the request is over, whichever way it went.
        upload.chunks.length = 0;
        upload.done = true;
      }
    };

    const settled = request();
    upload.settled = settled.then(
      () => undefined,
      () => undefined,
    );
    try {
      await settled;
    } catch (error) {
      this.uploads.delete(id);
      throw error;
    }
    // A drain that started while this was in flight has already taken the text
    // (it holds the upload object, so dropping the id here is safe either way).
    this.uploads.delete(id);
    return { text: upload.late ? "" : upload.tail };
  }

  /** Abandon an upload. Safe for an id that already finished or never existed. */
  cancel(id: string): void {
    const upload = this.uploads.get(id);
    if (!upload) return;
    this.uploads.delete(id);
    upload.chunks.length = 0;
    upload.controller.abort();
  }

  /** Recordings still uploading or transcribing for a session. */
  pending(sessionPath?: string): number {
    let n = 0;
    for (const upload of this.uploads.values()) if (this.belongsTo(upload, sessionPath)) n += 1;
    return n;
  }

  isActive(sessionPath: string): boolean {
    return this.pending(sessionPath) > 0;
  }

  /**
   * The pre-send transform (M8-T2).
   *
   * Called the instant a prompt is submitted, from Pi's `input` hook and from
   * the worker's steer / follow-up paths (which bypass that hook):
   *
   *   1. claim every recording in flight for this session — from here its text
   *      belongs to the prompt being sent, not to the next one;
   *   2. wait, bounded, for the ones already uploaded to come back;
   *   3. return their text, for the caller to append to the prompt.
   *
   * A recording still being *uploaded* has no bytes to transcribe yet, so it is
   * left alone: it lands in the composer as usual, for the next prompt. Waiting
   * on a microphone that is still open would hold the prompt for as long as the
   * person keeps talking.
   *
   * Safe to call for a session that is not dictating (returns "").
   */
  async drain(sessionPath: string, timeoutMs = this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS): Promise<string> {
    const inFlight: Upload[] = [];
    for (const upload of this.uploads.values()) {
      if (!this.belongsTo(upload, sessionPath) || upload.settled === undefined) continue;
      upload.late = true;
      inFlight.push(upload);
    }
    if (inFlight.length === 0) return "";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      // Bounded: a hung upload must not hold a prompt open forever. What has
      // not landed by the deadline stays claimed and is returned by the next
      // drain rather than lost.
      await Promise.race([Promise.all(inFlight.map((u) => u.settled)), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const parts: string[] = [];
    for (const upload of inFlight) {
      if (!upload.done) {
        // The deadline beat it. Un-claim it rather than keep a claim we cannot
        // honour: `end()` will hand it to the composer as usual, so the phrase
        // arrives late instead of disappearing.
        upload.late = false;
        continue;
      }
      if (upload.tail === "") continue;
      parts.push(upload.tail);
      upload.tail = "";
    }
    return parts.join(" ").trim();
  }

  private belongsTo(upload: Upload, sessionPath: string | undefined): boolean {
    if (sessionPath === undefined) return true;
    // An upload that never named a session belongs to this worker, and a
    // worker serves one project: claiming it is better than losing it.
    return upload.sessionPath === undefined || upload.sessionPath === sessionPath;
  }

  private take(id: string): Upload {
    const upload = this.uploads.get(id);
    if (!upload) {
      throw new TranscribeError(
        "unknown_upload",
        "That recording is no longer being uploaded — it finished, was cancelled, or the worker restarted. Start dictation again.",
      );
    }
    return upload;
  }

  /** Publish {@link drain} to the companion extension in this process. */
  register(): void {
    registerTranscribeBridge(this);
  }

  dispose(): void {
    for (const id of [...this.uploads.keys()]) this.cancel(id);
    unregisterTranscribeBridge(this);
  }
}

/** Chunks → one flat Uint8Array over a plain ArrayBuffer (a BodyInit). */
function concat(chunks: readonly Buffer[], bytes: number): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(bytes));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The in-process bridge to the companion extension
// ---------------------------------------------------------------------------

/**
 * `packages/pi-extension` may not import `packages/worker` (the worker depends
 * on it, not the other way round), and Pi's `input` hook is the only place a
 * prompt can be held open. So the service publishes a two-method handle on a
 * well-known symbol, exactly as pi-subagents publishes its registries, and
 * `modules/transcribe.ts` looks it up with the same key. Both sides declare the
 * shape; neither imports the other.
 *
 * Version it by renaming the symbol, never by adding a version field: a session
 * that finds a symbol it does not understand is indistinguishable from one that
 * finds nothing, and both must degrade to "no dictation" rather than to a hang.
 */
export const TRANSCRIBE_BRIDGE_KEY = symbolKey("transcribe.v1");
export const TRANSCRIBE_BRIDGE_SYMBOL = Symbol.for(TRANSCRIBE_BRIDGE_KEY);

export interface TranscribeBridge {
  /** Is anything in flight for this session? Cheap; called on every prompt. */
  isActive(sessionPath: string): boolean;
  /** Claim what is in flight, wait (bounded), return its text. */
  drain(sessionPath: string, timeoutMs?: number): Promise<string>;
}

type BridgeHost = Record<PropertyKey, unknown>;

/** The handle each service published, so disposing one cannot unpublish another's. */
const published = new WeakMap<TranscribeService, TranscribeBridge>();

function registerTranscribeBridge(service: TranscribeService): void {
  const bridge: TranscribeBridge = {
    isActive: (path) => service.isActive(path),
    drain: (path, timeoutMs) => service.drain(path, timeoutMs),
  };
  published.set(service, bridge);
  (globalThis as BridgeHost)[TRANSCRIBE_BRIDGE_SYMBOL] = bridge;
}

function unregisterTranscribeBridge(service: TranscribeService): void {
  const host = globalThis as BridgeHost;
  const mine = published.get(service);
  published.delete(service);
  // Only clear our own registration. Two services in one process is a test
  // fixture, not production, but silently unpublishing the live one would make
  // dictation stop working with no error anywhere.
  if (mine === undefined || host[TRANSCRIBE_BRIDGE_SYMBOL] !== mine) return;
  delete host[TRANSCRIBE_BRIDGE_SYMBOL];
}

/** The bridge published by this process's `TranscribeService`, if any. */
export function transcribeBridge(): TranscribeBridge | undefined {
  return (globalThis as BridgeHost)[TRANSCRIBE_BRIDGE_SYMBOL] as TranscribeBridge | undefined;
}

// ---------------------------------------------------------------------------
// The waveform contract
// ---------------------------------------------------------------------------

/**
 * pi-gpt-transcribe's `WidgetState` (0.2.1, `src/widget.ts`), kept verbatim as
 * the contract between the terminal widget and laser's native one so the two
 * show the same thing. The split across the wire:
 *
 *   level      the browser's, always — the microphone is there and nothing
 *              else can measure it. Normalized RMS in [0, 1].
 *   pending    this service's: recordings uploaded and not yet transcribed.
 *   inserted   the client's: phrases it has put into the composer.
 *   error      this service's: the last failure, already written for a person.
 *   startedAt  the client's: epoch ms when the microphone opened, so the clock
 *              is computed and never ticks over the wire.
 *
 * Rendering rules that go with it, from the same file, because a linear meter
 * looks dead while someone is talking: map RMS to decibels between
 * {@link WAVE_FLOOR_DB} and {@link WAVE_CEIL_DB}, and follow the envelope with
 * {@link WAVE_ATTACK} / {@link WAVE_RELEASE} so a syllable reads as a spike
 * rather than a flicker. Speech sits around −30 to −20 dBFS, which is 0.03 to
 * 0.1 as raw RMS — the bottom tenth of a linear bar.
 */
/** The package's own session shape, so the native waveform shows exactly what
 *  the terminal one shows rather than a second vocabulary for the same facts. */
export type WidgetState = DictationState;

export const WAVE_FLOOR_DB = -60;
export const WAVE_CEIL_DB = -8;
export const WAVE_ATTACK = 0.85;
export const WAVE_RELEASE = 0.35;

/** Normalized RMS → [0, 1] on a dB scale. The mapping the TUI widget uses. */
export function levelToUnit(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - WAVE_FLOOR_DB) / (WAVE_CEIL_DB - WAVE_FLOOR_DB)));
}

/** One envelope-follower step: fast attack, slow release. */
export function followEnvelope(previous: number, target: number): number {
  const rate = target > previous ? WAVE_ATTACK : WAVE_RELEASE;
  return previous + (target - previous) * rate;
}
