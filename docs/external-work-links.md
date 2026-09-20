# External work links (Jira first)

Status: **binding design for M25** (`PLAN.md` "M25 · External work links";
decision D-349). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md); it extends the
leap's "Import, export and interoperability" rule that no external tool is a
second writer. Read the leap's [Canonical persistence](project-lifecycle-leap.md#canonical-persistence)
and [Security, privacy and resource rules](project-lifecycle-leap.md#security-privacy-and-resource-rules)
first.

## The idea in one paragraph

A Spec, Research, Design, Plan or Task may be **exported** to a Jira issue.
The export is explicit, previewed and recorded as an `ExternalWorkLink` that
names the exact Laser revision the issue was created from. Later revisions may
be pushed with an explicit **Update Jira from this revision**. Nothing flows
back: Jira status, comments and edits never approve, complete or change Laser
work. Laser remains the only authority; Jira is a representation.

## Domain

```text
ExternalWorkLink                       supporting record, project-partitioned
  id                                   opaque
  work         ProjectWorkRef          kind + entityId (+ revision at creation)
  provider     "jira"                  enum; open to others later
  site         { cloudId, baseUrl }    Atlassian site identity
  issue        { id, key }             Jira ids; key shown, id is identity
  createdFrom  { revisionId, digest }  exact revision used at creation
  lastPushed   { revisionId, digest, at }
  createdBy    person | agent-run identity
  createdAt
  state        "linked" | "detached"   detached = issue missing or forbidden on last check
```

- Many-to-many: one entity may link to several issues; one issue may be
  linked from several entities (a Plan and its Tasks, for example).
- Links are immutable except `lastPushed` and `state`; removing a link is
  `detach`, which keeps the row as history.
- Jira issue property `laser.work` (`{ projectId, kind, entityId, revisionId,
  digest, appVersion }`) carries Laser identity on the issue; a Jira remote
  issue link points to the Laser deep link for that exact revision. Both are
  best effort: a site that forbids properties still gets a link.

## Flow

1. From an entity's detail or inspector: **Create Jira issue…**
2. Choose site (if several), Jira project, issue type; the field form is built
   from Jira's create metadata for that project/type — required fields, enums,
   defaults — never from a hard-coded list.
3. Preview the exact summary and description Laser will send (deterministic
   Markdown → Jira wiki/ADF rendering of the revision, with a footer naming
   the Laser revision digest).
4. Create. The link is stored with `createdFrom`; the issue key appears on the
   entity with a "View in Jira" action.
5. On a later revision the entity shows "Jira issue is behind this revision"
   with **Update Jira from this revision…** → preview → push, which sets
   `lastPushed`. Never automatic.
6. Optional **Transition…** offers the issue's currently available Jira
   transitions, previewed; it changes Jira only.

Agents get the same actions through the lifecycle tools
(`export_project_work { target: "jira", … }`), gated by the
[tool contract](agent-tool-contract.md): preview required, idempotency key
required, external write annotated.

## Rules

- **No import through this feature.** Reading Jira into Laser is the leap's
  import adapter path (previewed revision with provenance), separate from
  links.
- **No watching, polling or webhooks.** Laser checks an issue's existence
  only when the person opens the entity or presses refresh.
- Jira text shown in Laser (issue summary, status name) is untrusted data:
  escaped, length-bounded, provenance-labelled.
- Credentials: OAuth 2.0 (3LO) with the minimum scopes for the operations the
  person enabled (`read:jira-work`, `write:jira-work`; `manage:jira-project`
  is never requested); tokens live in the keychain through the desktop
  keychain path, never in settings files or transcripts. A browser/relay
  client never receives a token; the host performs every Jira call.
- Site, project and issue-type choices are remembered per Laser project as
  defaults, not enforced.
- Every Jira call is logged as a provider request with method, URL and status,
  body redacted to a digest.
- Rate limiting and 4xx/5xx map to person-readable errors: what failed,
  whether the link was created, what to do next.

## What a person sees

- Entity header chip: `PROJ-123 · linked · behind by 2 revisions`.
- Create/Update/Transition dialogs with preview as the last step; Enter never
  creates.
- Settings → Integrations → Jira: connect a site, scopes shown in plain
  words, disconnect, per-project defaults.
- Empty states: not connected (one action), connected but no link (one
  action), detached (why, and re-link or forget).

## Affected areas

| Layer | Change |
| --- | --- |
| Protocol | `ExternalWorkLink`, `ExternalProvider`, `project/work/export/{preview,create,update,transition,refresh,detach}`, `integrations/jira/{sites,connect,disconnect,create-meta}`; closed schemas, method-policy rows (`settings` for connect, `project_write` for links), samples |
| Host | `integrations/jira/*` client (OAuth, create-meta, issues, properties, remote links, transitions), keychain access, store table and migrations for links, rendering of a revision to Jira description, refresh check |
| Worker | `export_project_work` tool over the project-work bridge; no Jira code in the worker |
| UI | entity chip and dialogs, integrations settings tab, list/detail filters "has Jira issue"; both widths and themes |
| Desktop | keychain entries for Jira tokens; OAuth redirect capture |
| CLI | `doctor` reports Jira connection state without secrets |
| Docs | leap "Import, export and interoperability" cross-reference; `environment-policy.md` reach for integration methods; `docs/security` threat model rows |
| Tests | schema round-trips; preview determinism; property/remote-link best effort; detached detection; token never in logs or settings; wrong-project refusal; agent path requires preview + idempotency key |
