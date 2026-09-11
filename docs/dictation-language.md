# Dictation is English, always

Research date: 2026-09-11. Documentation only — no live API call was made with
any credential on this machine.

## The decision

Every dictation request pins English in the request itself. The person's
`pi-gpt-transcribe` config (`languages`) and a client's per-recording
`pi/transcribe/begin` `language` are still parsed — a typo there must never take
dictation away — and then ignored, with one log line the first time each ignored
value is seen.

Why it is a pin and not a hint: the endpoint auto-detects when nothing is sent,
and one foreign word inside an English sentence is enough to flip the whole
phrase into another language or another script. A transliterated phrase is not
a prompt anyone can send. English is a product decision, so it lives in the
request, not in a setting.

## The parameter, per model

`POST /v1/audio/transcriptions` has two language fields, and which one is
correct depends on the model:

| Model | Field sent | Value |
| --- | --- | --- |
| `gpt-transcribe` (the pinned core's `DEFAULT_MODEL`) | `languages[]` | `en` |
| `whisper-1` | `language` | `en` |
| `gpt-4o-transcribe` | `language` | `en` |
| `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15` | `language` | `en` |
| `gpt-4o-transcribe-diarize` | `language` | `en` |
| anything else (a gateway's own model id) | `language` | `en` |

Never both fields in one request. `languageFieldFor()` in
`packages/worker/src/transcribe.ts` decides: a model id starting with
`gpt-transcribe` takes `languages[]`, everything else takes `language`.

The reference says exactly this:

- `language`: "The language of the input audio. Supplying the input language in
  ISO-639-1 (e.g. `en`) format will improve accuracy and latency." — no model
  restriction.
- `languages`: "Possible languages of the input audio, in ISO-639-1 format.
  **Supported by `gpt-transcribe`.**"

…and the guide is explicit about the pairing:

> For `gpt-transcribe`, `languages` replaces the singular `language` field.
> Don't send both fields.

> Existing models that accept one language hint use `language` instead of
> `languages`.

So `languages[]` **is** a documented parameter — but only for `gpt-transcribe`,
and only in the plural. The worker used to send `languages[]` for every model,
including `whisper-1`, which is unsupported for those models; the same guide
notes the API "rejects the entire request" over malformed context fields, and a
rejected request is silence where a phrase should have been. That is the defect
this change also closes.

Codes accepted for `languages`: ISO-639-1 (`en`), selected ISO-639-3 (`eng`),
and regional `zh` locales. "The API rejects unsupported or incorrectly formatted
language codes." `en` is ISO-639-1 and valid for both fields.

## Does pinning English produce English, or garbage?

English. The field describes the **input** language, and the endpoint
"[t]ranscribes audio into the input language" — the guide contrasts transcription,
which "preserves the recording's original language", with translation. Telling
the model the audio is English makes it decode accented and code-switched speech
in the English vocabulary and write it in Latin script, which is the behaviour
asked for: an accent, or an Arabic word dropped into an English sentence, comes
back as English text rather than as another script.

It is not a translator. A phrase spoken entirely in another language comes back
as an English-script approximation, not as a translation of its meaning. That is
the intended trade: the microphone here is for one person prompting an agent in
English.

## Ruled out

- **`/v1/audio/translations`** ("Translates audio into English", "supports
  translation into English only"). Fits the words "always English", but it is
  `whisper-1` only — the `gpt-transcribe` model page lists
  `v1/audio/translations` as *Not supported* — so using it would mean downgrading
  every dictation to Whisper, losing `keywords`/`languages`, streaming and
  accuracy. It also *translates*: it would silently change what a person said
  rather than write it down. Not used, for any model.
- **A steering sentence appended to `prompt`.** `prompt` is documented for
  style, vocabulary and "[s]electing a preferred writing system for a language",
  so an English prompt is not wrong — but the prompt is the person's own field
  (jargon, project names), prompt text can surface in the transcript, and for
  `whisper-1` "Whisper doesn't follow instructions like a general-purpose text
  model". An instruction sentence is a weaker lever than the parameter that
  exists for this, and it costs the person's own context. The configured
  `prompt` and `keywords` are passed through untouched.
- **A Laser setting for the dictation language.** The request is "audio input
  should always be in English"; a setting would reintroduce the auto-detect
  failure it asks to remove. The config file and the wire field stay parsed for
  compatibility and are reported once, then ignored.
- **Changing the protocol.** `pi/transcribe/begin` keeps its optional
  `language`; an older or third-party client that sends `fr` still dictates, and
  still gets English. No protocol change was needed.

## Sources

- Create transcription (API reference) — parameters `language`, `languages`,
  `prompt`, `keywords`, model enum:
  <https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create>
  (mirrored at <https://platform.openai.com/docs/api-reference/audio>)
- File transcription guide — "`languages` replaces the singular `language`",
  supported language codes, prompting, translations:
  <https://developers.openai.com/api/docs/guides/speech-to-text>
- Create translation (API reference) — "Translates audio into English":
  <https://developers.openai.com/api/reference/resources/audio/subresources/translations/methods/create>
- GPT-Transcribe model page — endpoint support matrix (`v1/audio/translations`:
  Not supported): <https://developers.openai.com/api/docs/models/gpt-transcribe>

## Where it lives

`packages/worker/src/transcribe.ts`: `TRANSCRIBE_LANGUAGE`, `languageFieldFor()`,
the pin in `buildMultipart()`, and the once-per-value notice for an ignored
config or request language. Pinned by
`packages/worker/test/transcribe.test.ts`.
