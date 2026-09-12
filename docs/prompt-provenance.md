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
interval is attributed to the observed extension writer. Product-owned writers
attach their identity through `recordInstructionWrite`, an out-of-band WeakMap
keyed by the returned object, not extra event or request fields. The harness
names its Agent role contribution; it never exports an inline pseudo-path as a
file. Third-party writers use the loaded package base-directory name and path;
local entry points use their owning directory (or the filename for a standalone
file under `extensions`), never generic `src` or `extensions` labels.

The worker's instruction-template writer records the actual named agent
definition (`Agent · <name>`) separately from **Variables** selected in that
definition (`Variable · Available tools`, `Variable · Tool guidance`, and so on).
A resolved template field is not attributed to app maintainers merely because
the app supplied its value: the saved definition chose to include it. Project
file bodies and skill entries within those fields keep their own source
identities. Only compulsory harness-added instructions use the app origin. A
diagnostic render brackets substituted values with collision-resistant markers;
stripping them must reproduce the actual renderer's output exactly before its
ranges are accepted. Markers never enter the real prompt. Whitespace controls,
trimming, empty values and repeated fields are tested. If detailed template
ranges cannot be recorded, the known agent definition is still named, with an
explanation that its detailed variable ranges are unavailable, without inventing
deeper attribution. Agent definitions have no individual source
file in the current definition contract, so they are inline, with directions to
the Agents editor rather than a fabricated file link. Pre-request handlers
are observed too, including in-place payload mutations. No-op handlers preserve
the existing map. Tool-loop or direct overrides which bypass the observed prompt
construction cannot inherit a previous turn's labels.

## Retention and rendering

Engine-neutral `InstructionSourceMap` metadata lives in `requestContext` with the
log entry. It contains JSON leaf paths, UTF-16 ranges, source identities and a
SHA-256 digest, **not another copy of instruction text**. Existing retention,
redaction and complete-payload storage still own the request body.

The UI validates retained maps with `instructionSourceMapSchema`, then checks
each retained string's path, digest and complete range coverage
before rendering a marker. Redaction, truncation or later alteration invalidates
the old ranges safely. Old captures explicitly say sources were not recorded.
No old request is reconstructed and no source file is opened by inspection.

The assistant-ui confidence-marker is adapted to provenance, not factual
confidence, and appears only in Instructions, never Conversation. A visible origin legend counts UTF-16 characters and percentages.
Selecting an origin highlights its contributions and jumps to the first; other
tints are muted without reducing text contrast. Plain mode carries exact source
boundaries, a left rule, a quiet tint and a source button for each contribution.
Source boundaries remain inline: only captured newline characters create hard
line breaks. Leading whitespace stays before a label, so the label sits beside
its own first character, never at the end of the previous contribution. Pure
whitespace keeps its origin and range without an empty label.
The nine `--provenance-*` colours derive from dark/light palette primitives and
are independently editable in Appearance → Custom → Instruction sources.

Markdown remains one intact instance of the chat renderer. A capture-only rehype
wrapper uses original top-level parser positions to show every source intersecting
a block, including mixed-source and literal XML blocks. Block components remain
mounted when the source panel changes, preserving their controls and keyboard
focus. Capture mode omits the chat's math-text
preprocessor so source offsets cannot drift; ordinary chat rendering is unchanged.
Markdown still renders `$…$` through the shared math plugins; Plain is the
exact-character view.
It never parses individual source fragments. The saved content-view preference
remains unchanged.

Source buttons open a grouped panel within the dialog: beside the document on
wide screens, below it on narrow screens. It has its own bounded wheel/touch
scroll area, exact captured excerpts by range, character counts and Show in text.
Contributions are grouped once per capture; excerpt text mounts only while its
disclosure is open. Jump emphasis clears after the theme's motion duration;
origin filtering uses muted tints and an underlined legend selection instead.
Only file-backed sources offer Open file (desktop) or Copy path (remote). Inline
identities and pseudo-paths have no file action. Escape closes this panel before
find or the containing dialog, restoring its opener. Hover details use a
pointer-sized virtual anchor, with the source button as the keyboard fallback.
One delegated event boundary and one detail popover serve the entire document.
Scrolling, window blur and resizing dismiss the transient detail.
Only the component tooltip renders; there is no native `title` duplicate.

Every new source carries `origin` and `inline: true` when no file is behind it.
The ordered protocol `ORIGINS` catalog derives origin types, schema, display
labels, token names and the Appearance group. The app's wire identity is the
rename-stable literal `app`. Optional agent names, field keys, module identities
and reason codes describe the source; the UI composes explanatory sentences,
never retaining presentation prose per range. A failed connection verification
has its own reason and retry guidance, distinct from absent source history. The type and schema allow absent origins solely for retained
older maps. Their ambiguous `agent`/`file` kinds retain their recorded identity
and file action, but never acquire an invented Engine, Agent or Project origin.
Old captures and unobserved overrides say Not recorded and explain
that an engine override or older capture may not have been observable; no current
files are read to repair history.

File activation is explicit. Desktop source markers and Markdown file links call
the native editor bridge; browsing a source never opens it automatically. Paths
resolve against the owning session directory, or the captured request's `cwd`,
not the browser origin. Browser/remote views copy the host path instead of trying
to open it on a different computer. Missing capture directories never guess a
browser route. Fragment-only citations and external URLs keep normal navigation.

On Linux, the bridge queries the OS's `text/plain` default and launches that
desktop entry through GIO, passing the file URI as an argument without a shell.
It does not use the file's own MIME handler: HTML must open as source, not in a
browser, and scripts must never execute. Existing regular text files are checked
after symlink resolution; binary files and executable desktop shortcuts are
rejected. A missing editor or file produces a retryable, human-readable error.

Request find counts the instruction text once. Source buttons are excluded from
its native-range traversal; the legend and duplicate panel excerpts are outside
the searchable region. Source labels are non-selectable generated content, so
native Markdown copying keeps its formatting without including controls. Native
copy from the plain document preserves the captured text exactly. Full JSON
still searches the original retained payload, never the provenance metadata.

Verification: real Pi builder tests, ordered extension mutation tests, an actual
worker/local-provider request comparison, log persistence, digest/range rejection,
and inspector search/disclosure tests.
