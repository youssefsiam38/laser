# Captured instruction sources

The request inspector explains the instructions retained for that request, not
the current contents of files on disk. Provenance never changes what is sent.

## Engine boundary

`packages/pi-extension/src/prompt-provenance.ts` observes Pi through the public
`ResourceLoader.extensionsOverride` seam. Each session runtime gets an isolated
observer. It installs after session-start module registration, wraps the existing
handlers without changing their arguments, results or failure behavior, and logs
the provider payload after all registered pre-request handlers have run.

At `before_agent_start`, Pi supplies the structured inputs it actually loaded.
The pinned assembly adapter verifies the **entire resource suffix** against the
base prompt: additional instructions, context files with their exact paths and
bodies, skill catalog formatted by Pi itself, and the session working directory.
It does not search the filesystem or classify text by resemblance. SYSTEM.md and
APPEND_SYSTEM.md paths come from the resource loader's source APIs. The remaining
base is engine instructions and tool guidance.

The adapter must be checked against the real system-prompt builder whenever Pi
is upgraded. A format mismatch becomes unrecorded, not a guessed file label.
Skill markers describe the catalog entry, not a claim that the full skill body
was placed in the system prompt. Invoked skill bodies remain conversation/tool
content, following the engine's normal behavior.

Prompt replacements preserve unchanged prefix/suffix provenance. The replacement
interval is attributed to the observed extension writer. Pre-request handlers
are observed too, including in-place payload mutations. No-op handlers preserve
the existing map. Tool-loop or direct overrides which bypass the observed prompt
construction cannot inherit a previous turn's labels.

## Retention and rendering

Engine-neutral `InstructionSourceMap` metadata lives in `requestContext` with the
log entry. It contains JSON leaf paths, UTF-16 ranges, source identities and a
SHA-256 digest, **not another copy of instruction text**. Existing retention,
redaction and complete-payload storage still own the request body.

The UI validates each retained string's path, digest and complete range coverage
before rendering a marker. Redaction, truncation or later alteration invalidates
the old ranges safely. Old captures explicitly say sources were not recorded.
No old request is reconstructed and no source file is opened by inspection.

The assistant-ui confidence-marker is adapted to provenance, not factual
confidence. Plain mode highlights exact boundaries with hover/focus help and
touch-accessible source details. Markdown remains one intact instance of the chat
renderer, with a recorded-source inventory; it is not reparsed per source span.
The saved machine-level content-view preference remains unchanged.

Request find counts the instruction text once. Focusable inline text markers
do not make action labels or source controls searchable. Full JSON
still searches the original retained payload, never the provenance metadata.

Verification: real Pi builder tests, ordered extension mutation tests, an actual
worker/local-provider request comparison, log persistence, digest/range rejection,
and inspector search/disclosure tests.
