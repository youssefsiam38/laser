"use client";
/**
 * Research: the question tree, its findings, and the sources behind them
 * (D-355 "Detail, by kind", `docs/research-phase.md` "What a person sees").
 *
 * The tree is on the left and the findings for the selected question are
 * beside it — that pair *is* the inspector for this kind, which is why a
 * Research has none. What this surface may and may not do is the contract's,
 * not a choice:
 *
 * - **Findings are read-only here.** They are written by the research loop's
 *   own tools as it reads sources (`record_finding`, M21-T17/T26), and a
 *   correction is a new finding that contradicts the old one — never an edit.
 *   The empty state says exactly that instead of pretending at a control.
 * - **Confidence is by rule**, never editable and never a person's opinion:
 *   `declared` from an official or primary source, `observed` from this
 *   project, `inferred` from two or more findings, `proposed` from none.
 * - **Every piece of foreign text carries `[from …]`** and is rendered as
 *   text: an excerpt is a quotation, never markup (invariant 9).
 * - A person may still **resolve a question, hand one over, mark one
 *   unanswerable or add one** — those are body writes through
 *   `project/work/revise`, fenced by the revision being read.
 */
import { Check, ExternalLink, FileText, HelpCircle, Pencil, Quote as QuoteIcon, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ResearchBody, ResearchFinding, ResearchQuestionState, SourceRef } from "@lasercode/protocol";

import { ResearchReport, type ReportSection } from "@/components/assistant-ui/elements/research-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openSourcePath } from "@/components/ui/source-file-link";
import { dateTime } from "@/format";
import { useIsWide } from "@/hooks";
import { cn } from "@/lib/utils";
import { selectWork } from "@/project-work";
import {
  addQuestion,
  citedSpan,
  CONFIDENCE_DETAIL,
  deriveResearchStatus,
  findingsFor,
  LICENCE_LABEL,
  locationLabel,
  noteUnresolved,
  provenanceOf,
  QUESTION_STATE_LABEL,
  questionRows,
  quoteMarkdown,
  resolutionRefusal,
  resolveQuestion,
  RESEARCH_STATUS_LABEL,
  retrievalSpend,
  sourceTarget,
  TRUST_LABEL,
  uncitedFindings,
  type QuestionResolution,
} from "@/project-work/research";
import { useLaserStable } from "@/runtime";
import type { Status } from "@/components/status";

import { KeyTag } from "../KindBadge.js";
import { MarkdownAuthoringField, MarkdownEditorActivationProvider } from "../MarkdownAuthoringField.js";
import { quoteIntoComposer } from "../quote.js";
import type { WorkBodyContext } from "./context.js";
import { Field, MarkdownListField } from "./editor-fields.js";
import { ListSection, Prose, Section, Tags } from "./fields.js";

const QUESTION_MARK: Readonly<Record<ResearchQuestionState, Status>> = {
  open: "idle",
  answered: "finished_unread",
  unanswerable: "error",
  handed_to_person: "waiting_for_input",
};

const CONFIDENCE_TONE = { declared: "ok", observed: "live", inferred: "attention", proposed: "outline" } as const;

export function ResearchDetail({ body, context }: { body: ResearchBody; context: WorkBodyContext }) {
  const rows = useMemo(() => questionRows(body), [body]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => rows[0]?.node.id);
  const wide = useIsWide();
  const selected = rows.find((row) => row.node.id === selectedId)?.node ?? rows[0]?.node;
  const findings = useMemo(() => findingsFor(body, selected?.id), [body, selected?.id]);
  const orphans = useMemo(() => uncitedFindings(body), [body]);
  const spend = retrievalSpend(body);
  const status = deriveResearchStatus(body);
  const [framing, setFraming] = useState<{ title: string; question: string; in: string[]; out: string[]; constraints: string[] }>();
  const [savingFraming, setSavingFraming] = useState(false);
  const [framingError, setFramingError] = useState<string>();

  const saveFraming = async (): Promise<void> => {
    if (!framing || !context.store) return;
    const root = body.questions.find((question) => question.parent === undefined && question.text === body.question)
      ?? body.questions.find((question) => question.parent === undefined);
    if (!root) {
      setFramingError("This revision has no stable root question to revise. Add the root through the research loop first.");
      return;
    }
    setSavingFraming(true);
    setFramingError(undefined);
    const next: ResearchBody = {
      ...body,
      question: framing.question,
      scope: { in: framing.in, out: framing.out, constraints: framing.constraints },
      questions: body.questions.map((question) => question.id === root.id ? { ...question, text: framing.question } : question),
    };
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "research", research: next },
      framing.title.trim() !== context.detail.revision.title ? { title: framing.title.trim() } : {},
    );
    setSavingFraming(false);
    if (!outcome.ok) {
      setFramingError(outcome.failure.message);
      return;
    }
    setFraming(undefined);
    context.onChanged();
  };

  // `supports` edges are what makes a Research part of a decision. With none
  // it is standalone — complete, not pending (D-352).
  const supports = context.detail.edges.filter(
    (edge) => edge.relation === "supports" && edge.subject.entityId === context.detail.entity.entityId,
  );

  return (
    <div data-slot="research-detail" className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3 py-2">
        <Badge variant={status === "answered" ? "ok" : status === "unanswerable" ? "danger" : "outline"}>{RESEARCH_STATUS_LABEL[status]}</Badge>
        {supports.length === 0 ? (
          <span className="text-xs leading-xs text-ink-3">Standalone · it answers its own question and needs nothing above it.</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-3">
            Supports
            {supports.map((edge) => (
              <button
                key={edge.linkId}
                type="button"
                onClick={() => selectWork({ entityId: edge.object.entityId, kind: edge.object.kind })}
                className="rounded outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              >
                <KeyTag workKey={edge.object.key} />
              </button>
            ))}
          </span>
        )}
        {context.editable && !framing ? (
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            onClick={() => {
              setFraming({ title: context.detail.revision.title, question: body.question, in: [...body.scope.in], out: [...body.scope.out], constraints: [...body.scope.constraints] });
              setFramingError(undefined);
            }}
          >
            <Pencil />
            Edit framing
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className={cn("typed tnum text-ink-3 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live", (!context.editable || framing) && "ms-auto")}>
              {spend.sources} sources · {spend.findings} findings · {spend.resolved}/{spend.questions} questions settled
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 items-start">
            What this revision cost so far: the sources it read, the findings it kept and the questions it has settled. A running search's own
            budget is reported by the run itself.
          </TooltipContent>
        </Tooltip>
      </div>

      {framing ? (
        <div data-slot="research-framing-editor" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-3">
          {framingError ? <p role="alert" className="text-sm leading-5 text-danger">{framingError} Your draft is still here.</p> : null}
          <Field label="Title" htmlFor="research-title">
            <Input id="research-title" value={framing.title} maxLength={200} onChange={(event) => setFraming({ ...framing, title: event.target.value })} />
          </Field>
          <MarkdownEditorActivationProvider active>
            <MarkdownAuthoringField
              editorKey="research-question"
              label="Question"
              value={framing.question}
              onChange={(question) => setFraming({ ...framing, question })}
              placeholder="What must this research settle?"
            />
            <MarkdownListField editorKey="research-in-scope" label="In scope" values={framing.in} onChange={(value) => setFraming({ ...framing, in: value })} placeholder="Included boundary" addLabel="Add in-scope boundary" />
            <MarkdownListField editorKey="research-out-of-scope" label="Out of scope" values={framing.out} onChange={(value) => setFraming({ ...framing, out: value })} placeholder="Excluded boundary" addLabel="Add out-of-scope boundary" />
            <MarkdownListField editorKey="research-constraint" label="Constraints" values={framing.constraints} onChange={(value) => setFraming({ ...framing, constraints: value })} placeholder="Constraint" addLabel="Add a constraint" />
          </MarkdownEditorActivationProvider>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={savingFraming} onClick={() => { setFraming(undefined); setFramingError(undefined); }}>
              <X />
              Cancel
            </Button>
            <Button size="sm" disabled={savingFraming || framing.title.trim() === "" || framing.question.trim() === ""} onClick={() => void saveFraming()}>
              <Check />
              {savingFraming ? "Saving…" : "Save as a new revision"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Section title="Question">
            <Prose text={body.question} className="text-ink" />
          </Section>
          <ListSection title="In scope" items={body.scope.in} />
          <ListSection title="Out of scope" items={body.scope.out} />
          <ListSection title="Constraints" items={body.scope.constraints} />
        </>
      )}

      <div className={cn("flex min-w-0 gap-4", wide ? "flex-row items-start" : "flex-col")}>
        <div className={cn("flex min-w-0 flex-col gap-3", wide && "w-[clamp(14rem,32%,22rem)] shrink-0")}>
          <ResearchReport
            title="Questions"
            summary={`${spend.resolved} of ${spend.questions} settled`}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            empty="This research has no questions in it yet."
            sections={rows.map(
              (row): ReportSection => ({
                id: row.node.id,
                heading: row.node.text,
                state: QUESTION_STATE_LABEL[row.node.state],
                mark: QUESTION_MARK[row.node.state],
                depth: row.depth,
                sources: row.findings,
                ...(row.node.answer ? { preview: row.node.answer } : {}),
              }),
            )}
          />
          {context.editable ? <AddQuestion body={body} context={context} parentId={selected?.id} /> : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {selected ? (
            <QuestionPanel body={body} context={context} questionId={selected.id} findings={findings} />
          ) : (
            <p className="text-sm leading-5 text-ink-2">
              No questions yet. <span className="text-ink-3">A research artifact starts with its root question and grows the tree as it reads.</span>
            </p>
          )}
        </div>
      </div>

      {body.options && body.options.length > 0 ? <OptionsMatrix body={body} /> : null}

      {body.unresolved.length > 0 ? (
        <Section title="Still unresolved">
          <ul role="list" className="flex flex-col gap-1.5">
            {body.unresolved.map((unresolved) => (
              <li key={unresolved.fact} className="flex flex-col">
                <span className="text-sm leading-5 text-ink-2">{unresolved.fact}</span>
                <span className="text-xs leading-xs text-ink-3">Would settle it: {unresolved.wouldSettleIt}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {orphans.length > 0 ? (
        <Section title="Findings no question cites yet">
          <ul role="list" className="flex flex-col gap-2">
            {orphans.map((finding) => (
              <li key={finding.id}>
                <FindingCard finding={finding} workKey={context.detail.entity.key} items={context.items} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.sources.length > 0 ? (
        <Section title="Sources">
          <ul role="list" className="flex flex-col gap-1">
            {body.sources.map((source) => (
              <li key={`${source.kind}-${source.id}`} className="flex min-w-0 items-center gap-2">
                <Badge variant="mono">{source.kind}</Badge>
                <span className="min-w-0 truncate text-sm leading-5 text-ink-2" title={source.id}>
                  {source.title || source.id}
                </span>
                <OpenSource source={source} items={context.items} compact />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One question: its answer, its findings, and what a person may do about it
// ---------------------------------------------------------------------------

function QuestionPanel({
  body,
  context,
  questionId,
  findings,
}: {
  body: ResearchBody;
  context: WorkBodyContext;
  questionId: string;
  findings: readonly ResearchFinding[];
}) {
  const question = body.questions.find((candidate) => candidate.id === questionId);
  const [resolving, setResolving] = useState<ResearchQuestionState | undefined>(undefined);
  if (!question) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={question.state === "answered" ? "ok" : question.state === "handed_to_person" ? "attention" : question.state === "unanswerable" ? "danger" : "outline"}>
            {QUESTION_STATE_LABEL[question.state]}
          </Badge>
          <h3 className="min-w-0 text-sm leading-5 font-medium text-ink">{question.text}</h3>
        </span>
        {question.answer ? <Prose text={question.answer} /> : null}
        {question.inferredOnly ? (
          <span className="text-xs leading-xs text-attention">This answer rests on inference alone, and says so.</span>
        ) : null}
      </div>

      {context.editable ? (
        resolving ? (
          <ResolveForm
            body={body}
            context={context}
            questionId={questionId}
            state={resolving}
            findings={body.findings}
            selected={question.findings}
            onClose={() => setResolving(undefined)}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="outline" onClick={() => setResolving("answered")}>
              Answer this
            </Button>
            <Button size="xs" variant="outline" onClick={() => setResolving("handed_to_person")}>
              Hand it to me
            </Button>
            <Button size="xs" variant="outline" onClick={() => setResolving("unanswerable")}>
              Mark unanswerable…
            </Button>
            {question.state !== "open" ? (
              <Button size="xs" variant="ghost" onClick={() => setResolving("open")}>
                Reopen
              </Button>
            ) : null}
          </div>
        )
      ) : null}

      <div data-slot="question-findings" className="flex min-w-0 flex-col">
        <Section title="Findings">
          {findings.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
                No findings yet — the research loop records them{" "}
                <span className="text-ink-3">as it reads sources, one finding per claim, each with its excerpt and licence.</span>
              </p>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const request = `Continue ${context.detail.entity.key}: research “${question.text}” and record findings with sources.`;
                  quoteIntoComposer({ text: request, workKey: context.detail.entity.key });
                }}
              >
                Continue this research
              </Button>
            </div>
          ) : (
            <ul role="list" className="flex flex-col gap-2">
              {findings.map((finding) => (
                <li key={finding.id}>
                  <FindingCard finding={finding} workKey={context.detail.entity.key} items={context.items} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function ResolveForm({
  body,
  context,
  questionId,
  state,
  findings,
  selected,
  onClose,
}: {
  body: ResearchBody;
  context: WorkBodyContext;
  questionId: string;
  state: ResearchQuestionState;
  findings: readonly ResearchFinding[];
  selected: readonly string[];
  onClose: () => void;
}) {
  const { actions } = useLaserStable();
  const [answer, setAnswer] = useState("");
  const [cited, setCited] = useState<string[]>([...selected]);
  const [inferredOnly, setInferredOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  const resolution: QuestionResolution = {
    state,
    answer,
    findings: cited,
    inferredOnly,
  };
  const refusal = resolutionRefusal(resolution);

  const label =
    state === "answered"
      ? "Answer"
      : state === "unanswerable"
        ? "What would settle it"
        : state === "handed_to_person"
          ? "What you need to decide"
          : "Why it is open again";

  const save = async (): Promise<void> => {
    if (!context.store || refusal) return;
    setSaving(true);
    let next = resolveQuestion(body, questionId, resolution);
    if (state === "unanswerable") {
      const question = body.questions.find((candidate) => candidate.id === questionId);
      if (question) next = noteUnresolved(next, { fact: question.text, wouldSettleIt: answer });
    }
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "research", research: next },
      { note: `${QUESTION_STATE_LABEL[state].toLocaleLowerCase()} by you` },
    );
    setSaving(false);
    if (!outcome.ok) {
      actions.toast("error", outcome.failure.message);
      return;
    }
    onClose();
    context.onChanged();
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
      <label className="eyebrow" htmlFor={`resolve-${questionId}`}>
        {label}
      </label>
      <Textarea
        id={`resolve-${questionId}`}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        className="max-h-40 text-sm leading-5"
        placeholder={state === "answered" ? "What the evidence says, in your own words." : "One sentence is enough."}
      />
      {state === "answered" ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="eyebrow">Cites</legend>
          {findings.length === 0 ? (
            <p className="text-xs leading-xs text-ink-3">There are no findings to cite yet.</p>
          ) : (
            findings.map((finding) => (
              <label key={finding.id} className="flex min-w-0 items-start gap-2 text-xs leading-xs text-ink-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 shrink-0 accent-live outline-none"
                  checked={cited.includes(finding.id)}
                  onChange={(event) =>
                    setCited((current) => (event.target.checked ? [...current, finding.id] : current.filter((id) => id !== finding.id)))
                  }
                />
                <span className="min-w-0">{finding.claim}</span>
              </label>
            ))
          )}
          {cited.length === 0 ? (
            <label className="flex items-start gap-2 text-xs leading-xs text-ink-2">
              <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-live outline-none" checked={inferredOnly} onChange={(event) => setInferredOnly(event.target.checked)} />
              <span>This answer rests on inference alone, with nothing cited.</span>
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {refusal ? <p className="text-xs leading-xs text-ink-3">{refusal}</p> : null}
      <div className="flex items-center gap-1.5">
        <Button size="xs" disabled={Boolean(refusal) || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save as a new revision"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddQuestion({ body, context, parentId }: { body: ResearchBody; context: WorkBodyContext; parentId: string | undefined }) {
  const { actions } = useLaserStable();
  const [text, setText] = useState("");
  const [under, setUnder] = useState(false);
  const [saving, setSaving] = useState(false);

  const add = async (): Promise<void> => {
    if (!context.store || text.trim() === "") return;
    setSaving(true);
    const next = addQuestion(body, { text, ...(under && parentId ? { parent: parentId } : {}) });
    const outcome = await context.store.revise(
      { entityId: context.detail.entity.entityId, expectedRevisionId: context.detail.revision.revisionId },
      { kind: "research", research: next },
      { note: "question added by you" },
    );
    setSaving(false);
    if (!outcome.ok) {
      actions.toast("error", outcome.failure.message);
      return;
    }
    setText("");
    context.onChanged();
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <label className="eyebrow" htmlFor="add-question">
        Add a question
      </label>
      <Input
        id="add-question"
        value={text}
        maxLength={500}
        placeholder="What else needs settling?"
        onChange={(event) => setText(event.target.value)}
        className="text-sm"
      />
      {parentId ? (
        <label className="flex items-center gap-2 text-xs leading-xs text-ink-2">
          <input type="checkbox" className="size-3.5 shrink-0 accent-live outline-none" checked={under} onChange={(event) => setUnder(event.target.checked)} />
          Under the question that is open
        </label>
      ) : null}
      <div>
        <Button size="xs" variant="outline" type="submit" disabled={saving || text.trim() === ""}>
          {saving ? "Adding…" : "Add"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One finding
// ---------------------------------------------------------------------------

export function FindingCard({
  finding,
  workKey,
  items,
}: {
  finding: ResearchFinding;
  workKey: string;
  items: WorkBodyContext["items"];
}) {
  const { actions } = useLaserStable();
  const span = finding.excerpt ? citedSpan(finding.excerpt, finding.claim) : undefined;
  return (
    <article data-slot="research-finding" className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
      <p className="text-sm leading-5 text-ink">{finding.claim}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={CONFIDENCE_TONE[finding.confidence]} tabIndex={0} data-slot="finding-confidence">
              {finding.confidence}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 items-start">
            {CONFIDENCE_DETAIL[finding.confidence]}
            <span className="text-xs opacity-70">Confidence is set by rule, never chosen.</span>
          </TooltipContent>
        </Tooltip>
        <Badge variant={finding.licence === "unknown" ? "attention" : "outline"} data-slot="finding-licence">
          {LICENCE_LABEL[finding.licence]}
        </Badge>
        <Badge variant="mono">{finding.source.kind}</Badge>
        <Badge variant="outline">{TRUST_LABEL[finding.source.trust]}</Badge>
        <span className="min-w-0 truncate text-xs leading-xs text-ink-3" title={finding.source.title || finding.source.id}>
          {finding.source.title || finding.source.id}
        </span>
        <span className="typed shrink-0 text-ink-3">{dateTime(finding.retrievedAt)}</span>
      </div>

      {finding.excerpt ? (
        <blockquote data-slot="finding-excerpt" className="border-s-2 border-line ps-2 text-sm leading-5 whitespace-pre-wrap text-ink-2">
          {span ? (
            <>
              {span.before}
              <mark data-slot="cited-span" className="rounded-sm bg-[color-mix(in_oklab,var(--live)_18%,transparent)] px-0.5 text-ink">
                {span.match}
              </mark>
              {span.after}
            </>
          ) : (
            finding.excerpt
          )}
        </blockquote>
      ) : null}

      {finding.location ? <span className="typed break-all text-ink-3">{locationLabel(finding.location)}</span> : null}

      {finding.reuse ? (
        <span className="flex flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-2">
          <Badge variant="outline">reuse · {finding.reuse.what}</Badge>
          <span className="min-w-0 truncate">{finding.reuse.notes ?? finding.reuse.from}</span>
          {finding.licence === "unknown" ? <span className="text-attention">An unknown licence blocks reuse until it is settled.</span> : null}
        </span>
      ) : null}

      {finding.contradicts.length > 0 ? (
        <span className="text-xs leading-xs text-attention">Contradicts {finding.contradicts.length} earlier finding{finding.contradicts.length === 1 ? "" : "s"}.</span>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span data-slot="finding-provenance" className="typed min-w-0 truncate text-ink-3" title={provenanceOf(finding.source)}>
          {provenanceOf(finding.source)}
        </span>
        <span className="ms-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              quoteIntoComposer({ text: quoteMarkdown(finding, workKey), workKey });
              actions.toast("info", "Quoted into the composer, with where it came from");
            }}
          >
            <QuoteIcon />
            Quote
          </Button>
          <OpenSource source={finding.source} items={items} />
        </span>
      </div>
    </article>
  );
}

/** Open a source through an opener that already exists, or say why it cannot. */
function OpenSource({ source, items, compact = false }: { source: SourceRef; items: WorkBodyContext["items"]; compact?: boolean }) {
  const target = sourceTarget(source);
  const size = compact ? ("icon-xs" as const) : ("xs" as const);
  if (target.open === "external") {
    return (
      <Button size={size} variant="ghost" asChild>
        <a href={target.url} target="_blank" rel="noopener noreferrer" title={target.url} aria-label={`Open the source: ${target.label}`}>
          <ExternalLink />
          {compact ? null : "Open source"}
        </a>
      </Button>
    );
  }
  if (target.open === "file") {
    return (
      <Button size={size} variant="ghost" onClick={() => void openSourcePath(target.path)} title={target.path} aria-label={`Open the file ${target.label}`}>
        <FileText />
        {compact ? null : "Open source"}
      </Button>
    );
  }
  if (target.open === "work") {
    const row = items.find((item) => item.key === target.key);
    return (
      <Button
        size={size}
        variant="ghost"
        disabled={!row}
        onClick={() => row && selectWork({ entityId: row.ref.entityId, kind: row.kind })}
        aria-label={`Open ${target.key}`}
      >
        <KeyTag workKey={target.key} />
        {compact ? null : "Open"}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="flex items-center gap-1 text-xs leading-xs text-ink-3 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live">
          <HelpCircle aria-hidden="true" className="size-3.5" />
          {compact ? null : "No source to open"}
        </span>
      </TooltipTrigger>
      <TooltipContent>{target.reason}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function OptionsMatrix({ body }: { body: ResearchBody }) {
  const options = body.options ?? [];
  return (
    <Section title="Options">
      <p className="text-xs leading-xs text-ink-3">
        A recommended option is a proposal until a spec or a design revision adopts it.
      </p>
      <ul role="list" className="flex flex-col gap-2">
        {options.map((option) => (
          <li key={option.name} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-2.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm leading-5 font-medium text-ink">{option.name}</span>
              {option.recommended ? <Badge variant="ok">recommended</Badge> : null}
              <span className="typed ms-auto text-ink-3">
                {option.findings.length} finding{option.findings.length === 1 ? "" : "s"}
              </span>
            </span>
            <Prose text={option.summary} />
            <Tags values={option.tradeoffs} />
            {option.reason ? <span className="text-xs leading-xs text-ink-3">{option.reason}</span> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
