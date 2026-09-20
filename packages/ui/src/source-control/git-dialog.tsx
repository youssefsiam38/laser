import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import type {
  GitActionConfirmation,
  GitActionCopyable,
  GitActionResult,
  GitHostStatus,
  GitPrCreateResult,
  GitPrMergeMethod,
  GitPullRequest,
} from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";

import type { ChangedFile } from "./contract.js";
import { getChangesAdapter } from "./data.js";
import { personFacingChangesError } from "./errors.js";
import {
  GIT_BITBUCKET_REBASE,
  GIT_BRANCH_FAILED,
  GIT_BRANCH_NAME,
  GIT_COMMIT_FAILED,
  GIT_NEEDS_COPY,
  GIT_NO_REMOTE,
  GIT_NOTHING_TO_COMMIT,
  GIT_ON_DEFAULT_BRANCH,
  GIT_PR_CHECKOUT_FAILED,
  GIT_PR_FAILED,
  GIT_PR_MERGE_FAILED,
  GIT_PR_NOT_OPEN,
  GIT_PR_READ_FAILED,
  GIT_PROSE_FAILED,
  GIT_PUSH_FAILED,
  GIT_UNCERTAIN_NEXT,
  GIT_WRITE_MESSAGE,
  GIT_WRITE_PR,
  actionTitle,
  checkSummary,
  confirmLabel,
  formatCopyable,
  hostStatusSentence,
  mergeMethodAllowed,
  mergeMethodsFor,
  numstatSummary,
  onDefaultBranch,
  offersMutation,
  offersPreviewAgain,
  parsePullRequestNumber,
  repoLeafName,
  withConfirm,
  type GitActionKind,
} from "./git-model.js";
import { attachOverlayPullRequest, clearGitAction, peekChangesUi, setChangesScope, useChangesUi } from "./store.js";

function refreshChanges(): void {
  const ui = peekChangesUi();
  setChangesScope({ ...ui.scope });
}

function GitCopyableCommand({ copyable }: { copyable: GitActionCopyable }) {
  const { copy, copied } = useCopy();
  const command = formatCopyable(copyable);
  return (
    <div data-slot="git-action-copyable" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Command</span>
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => void copy(command)}>
          {copied ? <Check className="text-ok" /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre dir="ltr" className="terminal overflow-x-auto rounded-lg px-3 py-2">
        <code className="typed text-xs">{command}</code>
      </pre>
      <p className="typed truncate text-xs text-ink-3" title={copyable.cwd}>
        {copyable.cwd}
      </p>
      {copyable.url ? (
        <a
          href={copyable.url}
          className="text-sm text-live underline-offset-4 hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          Open the host page
        </a>
      ) : null}
    </div>
  );
}

function GitConfirmation({ confirmation }: { confirmation: GitActionConfirmation }) {
  return (
    <div data-slot="git-action-confirmation" className="flex flex-col gap-2">
      <p className="text-sm text-ink">{confirmation.summary}</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        <div>
          <dt className="eyebrow inline">Repository </dt>
          <dd className="typed inline text-ink">{repoLeafName(confirmation.repo)}</dd>
        </div>
        <div>
          <dt className="eyebrow inline">Branch </dt>
          <dd className="typed inline text-ink">{confirmation.branch}</dd>
        </div>
        {confirmation.remote ? (
          <div>
            <dt className="eyebrow inline">Remote </dt>
            <dd className="typed inline text-ink">{confirmation.remote}</dd>
          </div>
        ) : null}
      </dl>
      {confirmation.files?.length ? (
        /* One hairline above the list, not a box around it: the dialog is
           already the card this sits in. */
        <ul className="max-h-32 overflow-y-auto overscroll-contain hairline-t pt-2">
          {confirmation.files.map((file) => (
            <li key={file} className="typed truncate text-ink-2">
              {file}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GitOutcomeView({
  kind,
  result,
  onClose,
  onReviewAgain,
}: {
  kind: GitActionKind;
  result: GitActionResult;
  onClose: () => void;
  onReviewAgain?: () => void;
}) {
  const outcome = result.outcome;
  const copyable = result.copyable;
  const isCopy = outcome === "needs_copy";
  const isUncertain = outcome === "uncertain";
  const isRefused = outcome === "refused";
  const isDone = outcome === "done";
  const message = result.message ?? (isCopy ? GIT_NEEDS_COPY : isUncertain ? GIT_UNCERTAIN_NEXT : undefined);
  return (
    <div data-slot="git-action-outcome" data-outcome={outcome} className="flex flex-col gap-3">
      <p
        role={isRefused ? "alert" : "status"}
        className={cn(
          "text-sm",
          isRefused && "border-s-2 border-danger ps-3 text-ink",
          isUncertain && "border-s-2 border-attention ps-3 text-ink",
          isCopy && "text-ink",
          isDone && "text-ink",
        )}
      >
        {isUncertain ? <span className="font-medium text-attention">This may already have happened. </span> : null}
        {isCopy ? <span className="font-medium text-ink">{GIT_NEEDS_COPY} </span> : null}
        {message && !(isCopy && message === GIT_NEEDS_COPY) ? message : null}
      </p>
      {copyable ? <GitCopyableCommand copyable={copyable} /> : null}
      <DialogFooter>
        <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={onClose}>
          {isDone ? "Close" : "Cancel"}
        </Button>
        {isRefused && onReviewAgain ? (
          <Button className="pointer-coarse:min-h-11" onClick={onReviewAgain}>
            Review again
          </Button>
        ) : null}
        {isDone && kind === "pull-request-create" && prUrlOf(result) ? (
          <Button asChild className="pointer-coarse:min-h-11">
            <a href={prUrlOf(result)} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

function prUrlOf(result: GitActionResult): string | undefined {
  const created = result as GitPrCreateResult;
  return created.pullRequest?.url;
}

function BusyMark({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" />
      {label}
    </span>
  );
}

function useRepoHost(repo: string): { host: GitHostStatus | undefined; error: string | null } {
  const [host, setHost] = useState<GitHostStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const adapter = getChangesAdapter();
    void adapter.gitHosts?.([repo]).then(
      (result) => {
        if (cancelled) return;
        setHost(result.hosts.find((row) => row.repo === repo) ?? result.hosts[0]);
        setError(null);
      },
      (failure: unknown) => {
        if (cancelled) return;
        setHost(undefined);
        setError(personFacingChangesError(failure, "Could not read this repository's host. Try again."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repo]);
  return { host, error };
}

export function GitActionDialog() {
  const request = useChangesUi().gitAction;
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) clearGitAction(); }}>
      {request ? <GitActionBody key={`${request.kind}:${request.repo}`} kind={request.kind} repo={request.repo} /> : null}
    </Dialog>
  );
}

function GitActionBody({ kind, repo }: { kind: GitActionKind; repo: string }) {
  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg"
      showCloseButton={false}
      data-slot="git-action-dialog"
      data-kind={kind}
      onOpenAutoFocus={(event) => {
        const root = event.currentTarget;
        if (!(root instanceof HTMLElement)) return;
        const field = root.querySelector<HTMLElement>("[data-git-autofocus]");
        if (!field) return;
        event.preventDefault();
        field.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{actionTitle(kind)}</DialogTitle>
        <DialogDescription>
          <span className="typed text-ink">{repoLeafName(repo)}</span>
          {kind === "commit"
            ? " · the files you choose, with a message you can edit."
            : kind === "push"
              ? " · names the branch and the remote before anything is sent."
              : kind === "branch"
                ? " · created from an explicit base."
                : kind === "pull-request-create"
                  ? " · title and body are drafted by this session's model. You can edit both."
                  : " · comments, checks, check out or merge."}
        </DialogDescription>
      </DialogHeader>
      {kind === "commit" ? <CommitBody repo={repo} /> : null}
      {kind === "push" ? <PushBody repo={repo} /> : null}
      {kind === "branch" ? <BranchBody repo={repo} /> : null}
      {kind === "pull-request-create" ? <PrCreateBody repo={repo} /> : null}
      {kind === "pull-request-read" ? <PrReadBody repo={repo} /> : null}
    </DialogContent>
  );
}

function FormFooter({
  busy,
  confirmBusy,
  confirmDisabled,
  confirmText,
  onCancel,
  onConfirm,
  extra,
}: {
  busy: boolean;
  confirmBusy: boolean;
  confirmDisabled: boolean;
  confirmText: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  extra?: ReactNode;
}) {
  return (
    <DialogFooter>
      <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      {extra}
      <Button
        className="pointer-coarse:min-h-11"
        onClick={onConfirm}
        disabled={confirmDisabled || busy}
        aria-busy={confirmBusy || undefined}
      >
        {confirmBusy ? <BusyMark label="Working…" /> : confirmText}
      </Button>
    </DialogFooter>
  );
}

function CommitBody({ repo }: { repo: string }) {
  const adapter = getChangesAdapter();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<GitActionResult | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"prose" | "preview" | "confirm" | null>(null);

  const paths = useMemo(() => files.filter((file) => selected.has(file.path)).map((file) => file.path), [files, selected]);

  useEffect(() => {
    let cancelled = false;
    setBusy("prose");
    void (async () => {
      try {
        const list = await adapter.listChanges({ kind: "uncommitted" });
        if (cancelled) return;
        const repoFiles = list.repos.find((row) => row.repo === repo)?.files ?? [];
        setFiles(repoFiles);
        setSelected(new Set(repoFiles.map((file) => file.path)));
        if (!repoFiles.length) return;
        let text = "";
        try {
          const summary = numstatSummary(repoFiles);
          const prose = await adapter.gitProse?.({
            kind: "commit",
            files: repoFiles.map((file) => file.path),
            repo,
            ...(summary ? { summary } : {}),
          });
          text = prose?.text ?? "";
        } catch {
          if (!cancelled) setError(GIT_PROSE_FAILED);
        }
        if (cancelled) return;
        setMessage(text);
        if (!text.trim() || !adapter.gitCommit) return;
        setBusy("preview");
        const next = await adapter.gitCommit({ repo, paths: repoFiles.map((file) => file.path), message: text });
        if (!cancelled) setPreview(next);
      } catch (failure) {
        if (!cancelled) setError(personFacingChangesError(failure, GIT_COMMIT_FAILED));
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, repo]);

  const runPreview = async (nextPaths = paths, nextMessage = message) => {
    if (!adapter.gitCommit) return;
    if (!nextPaths.length) {
      setError(GIT_NOTHING_TO_COMMIT);
      return;
    }
    if (!nextMessage.trim()) {
      setError(GIT_WRITE_MESSAGE);
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next = await adapter.gitCommit({ repo, paths: nextPaths, message: nextMessage });
      setPreview(next);
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_COMMIT_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    if (!adapter.gitCommit || !preview || !offersMutation(preview.outcome)) return;
    setBusy("confirm");
    setError(null);
    try {
      const next = await adapter.gitCommit(withConfirm(preview, { repo, paths, message }));
      setResult(next);
      if (next.outcome === "done") refreshChanges();
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_COMMIT_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (preview && preview.outcome !== "preview" ? preview : null);
  if (shown) {
    return (
      <GitOutcomeView
        kind="commit"
        result={shown}
        onClose={clearGitAction}
        {...(offersPreviewAgain(shown.outcome) ? { onReviewAgain: () => void runPreview() } : {})}
      />
    );
  }

  const empty = !files.length && busy === null;
  const previewFiles = preview?.confirmation.files;
  const filesMatch = Boolean(
    previewFiles && previewFiles.length === paths.length && paths.every((path) => previewFiles.includes(path)),
  );
  const canConfirm = offersMutation(preview?.outcome) && filesMatch;

  return (
    <div className="flex flex-col gap-3" aria-busy={busy !== null}>
      {empty ? <p className="text-sm text-ink-2">{GIT_NOTHING_TO_COMMIT}</p> : null}
      {files.length ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="eyebrow mb-1">Files</legend>
          {files.map((file) => (
            <label
              key={file.path}
              className="flex min-h-8 items-center gap-2 rounded-md px-1 text-sm pointer-coarse:min-h-11"
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--live)]"
                checked={selected.has(file.path)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(file.path)) next.delete(file.path);
                  else next.add(file.path);
                  setSelected(next);
                }}
              />
              <span className="typed min-w-0 truncate text-ink" title={file.path}>
                {file.path}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Message</span>
        <Textarea
          data-git-autofocus
          data-slot="git-commit-message"
          aria-label="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy === "prose"}
          className="max-h-40 min-h-20 text-sm"
        />
      </label>
      {preview && preview.outcome === "preview" ? <GitConfirmation confirmation={preview.confirmation} /> : null}
      {error ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {error}
        </p>
      ) : null}
      <FormFooter
        busy={busy !== null}
        confirmBusy={busy === "confirm"}
        confirmDisabled={!paths.length || !message.trim() || !canConfirm}
        confirmText={confirmLabel("commit", preview?.confirmation)}
        onCancel={clearGitAction}
        onConfirm={() => void runConfirm()}
        extra={
          !canConfirm && !empty ? (
            <Button
              variant="outline"
              className="pointer-coarse:min-h-11"
              disabled={busy !== null || !paths.length || !message.trim()}
              onClick={() => void runPreview()}
            >
              {busy === "preview" ? <BusyMark label="Reviewing…" /> : "Review commit"}
            </Button>
          ) : null
        }
      />
    </div>
  );
}

function PushBody({ repo }: { repo: string }) {
  const adapter = getChangesAdapter();
  const { host, error: hostError } = useRepoHost(repo);
  const [preview, setPreview] = useState<GitActionResult | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "confirm" | null>(null);

  const remote = host?.remote;
  const branch = host?.branch;

  useEffect(() => {
    if (!adapter.gitPush || !remote || !branch) return;
    let cancelled = false;
    setBusy("preview");
    void adapter
      .gitPush({ repo, remote, branch })
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(personFacingChangesError(failure, GIT_PUSH_FAILED));
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, repo, remote, branch]);

  const runConfirm = async () => {
    if (!adapter.gitPush || !preview || !offersMutation(preview.outcome) || !remote || !branch) return;
    setBusy("confirm");
    setError(null);
    try {
      const next = await adapter.gitPush(withConfirm(preview, { repo, remote, branch }));
      setResult(next);
      if (next.outcome === "done") refreshChanges();
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_PUSH_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (preview && preview.outcome !== "preview" ? preview : null);
  if (shown) {
    return <GitOutcomeView kind="push" result={shown} onClose={clearGitAction} />;
  }

  const missingRemote = host && !remote;

  return (
    <div className="flex flex-col gap-3" aria-busy={busy !== null}>
      {hostError ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {hostError}
        </p>
      ) : null}
      {missingRemote ? <p className="text-sm text-ink-2">{GIT_NO_REMOTE}</p> : null}
      {hostStatusSentence(host) ? <p className="text-sm text-ink-2">{hostStatusSentence(host)}</p> : null}
      {preview && preview.outcome === "preview" ? <GitConfirmation confirmation={preview.confirmation} /> : null}
      {error ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {error}
        </p>
      ) : null}
      <FormFooter
        busy={busy !== null}
        confirmBusy={busy === "confirm"}
        confirmDisabled={!offersMutation(preview?.outcome)}
        confirmText={confirmLabel("push", preview?.confirmation)}
        onCancel={clearGitAction}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}

function BranchBody({ repo }: { repo: string }) {
  const adapter = getChangesAdapter();
  const { host } = useRepoHost(repo);
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [preview, setPreview] = useState<GitActionResult | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "confirm" | null>(null);

  useEffect(() => {
    if (!base && (host?.branch || host?.defaultBranch)) {
      setBase(host.branch ?? host.defaultBranch ?? "");
    }
  }, [base, host]);

  const runPreview = async () => {
    if (!adapter.gitBranch) return;
    if (!name.trim()) {
      setError(GIT_BRANCH_NAME);
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next = await adapter.gitBranch({
        repo,
        name: name.trim(),
        base: base.trim() || "HEAD",
        ...(checkout ? { checkout: true } : {}),
      });
      setPreview(next);
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_BRANCH_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    if (!adapter.gitBranch || !preview || !offersMutation(preview.outcome)) return;
    setBusy("confirm");
    setError(null);
    try {
      const next = await adapter.gitBranch(
        withConfirm(preview, {
          repo,
          name: name.trim(),
          base: base.trim() || "HEAD",
          ...(checkout ? { checkout: true } : {}),
        }),
      );
      setResult(next);
      if (next.outcome === "done") refreshChanges();
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_BRANCH_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (preview && preview.outcome !== "preview" ? preview : null);
  if (shown) {
    return (
      <GitOutcomeView
        kind="branch"
        result={shown}
        onClose={clearGitAction}
        {...(offersPreviewAgain(shown.outcome) ? { onReviewAgain: () => void runPreview() } : {})}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy !== null}>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Name</span>
        <Input
          data-git-autofocus
          aria-label="Branch name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="pointer-coarse:min-h-11"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Base</span>
        <Input
          aria-label="Base revision"
          value={base}
          onChange={(event) => setBase(event.target.value)}
          className="typed pointer-coarse:min-h-11"
        />
      </label>
      <label className="flex min-h-8 items-center gap-2 text-sm pointer-coarse:min-h-11">
        <input
          type="checkbox"
          className="size-4 accent-[var(--live)]"
          checked={checkout}
          onChange={(event) => setCheckout(event.target.checked)}
        />
        Switch to this branch after creating it
      </label>
      {preview && preview.outcome === "preview" ? <GitConfirmation confirmation={preview.confirmation} /> : null}
      {error ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {error}
        </p>
      ) : null}
      <FormFooter
        busy={busy !== null}
        confirmBusy={busy === "confirm"}
        confirmDisabled={!name.trim() || (Boolean(preview) && !offersMutation(preview?.outcome))}
        confirmText={offersMutation(preview?.outcome) ? confirmLabel("branch", preview?.confirmation) : "Review branch"}
        onCancel={clearGitAction}
        onConfirm={() => void (offersMutation(preview?.outcome) ? runConfirm() : runPreview())}
      />
    </div>
  );
}

function PrCreateBody({ repo }: { repo: string }) {
  const adapter = getChangesAdapter();
  const { host } = useRepoHost(repo);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [preview, setPreview] = useState<GitActionResult | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"prose" | "preview" | "confirm" | null>(null);

  useEffect(() => {
    if (host?.defaultBranch && !base) setBase(host.defaultBranch);
    if (host?.branch && !head) setHead(host.branch);
  }, [host, base, head]);

  useEffect(() => {
    let cancelled = false;
    setBusy("prose");
    void (async () => {
      try {
        const list = await adapter.listChanges({ kind: "uncommitted" });
        if (cancelled) return;
        const files = (list.repos.find((row) => row.repo === repo)?.files ?? []).map((file) => file.path);
        const summary = numstatSummary(list.repos.find((row) => row.repo === repo)?.files ?? []);
        const [titleProse, bodyProse] = await Promise.all([
          adapter.gitProse?.({ kind: "pr_title", files, repo, ...(summary ? { summary } : {}) }),
          adapter.gitProse?.({ kind: "pr_description", files, repo, ...(summary ? { summary } : {}) }),
        ]);
        if (cancelled) return;
        setTitle(titleProse?.text.trim() ?? "");
        setBody(bodyProse?.text ?? "");
      } catch {
        if (!cancelled) setError(GIT_PROSE_FAILED);
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, repo]);

  const runPreview = async () => {
    if (!adapter.gitPrCreate) return;
    if (!title.trim()) {
      setError(GIT_WRITE_PR);
      return;
    }
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next = await adapter.gitPrCreate({
        repo,
        title: title.trim(),
        body,
        base: base.trim() || "main",
        head: head.trim(),
      });
      setPreview(next);
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_PR_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    if (!adapter.gitPrCreate || !preview || !offersMutation(preview.outcome)) return;
    setBusy("confirm");
    setError(null);
    try {
      const next = await adapter.gitPrCreate(
        withConfirm(preview, {
          repo,
          title: title.trim(),
          body,
          base: base.trim() || "main",
          head: head.trim(),
        }),
      );
      setResult(next);
      if (next.outcome === "done") refreshChanges();
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_PR_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (preview && preview.outcome !== "preview" ? preview : null);
  if (shown) {
    return (
      <GitOutcomeView
        kind="pull-request-create"
        result={shown}
        onClose={clearGitAction}
        {...(offersPreviewAgain(shown.outcome) ? { onReviewAgain: () => void runPreview() } : {})}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy !== null}>
      {onDefaultBranch(host) ? <p className="text-sm text-ink-2">{GIT_ON_DEFAULT_BRANCH}</p> : null}
      {hostStatusSentence(host) ? <p className="text-sm text-ink-2">{hostStatusSentence(host)}</p> : null}
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Title</span>
        <Input
          data-git-autofocus
          data-slot="git-pr-title"
          aria-label="Pull request title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="pointer-coarse:min-h-11"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Body</span>
        <Textarea
          data-slot="git-pr-body"
          aria-label="Pull request body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="max-h-48 min-h-24 text-sm"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Base</span>
          <Input aria-label="Base branch" value={base} onChange={(event) => setBase(event.target.value)} className="typed" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Head</span>
          <Input aria-label="Head branch" value={head} onChange={(event) => setHead(event.target.value)} className="typed" />
        </label>
      </div>
      {preview && preview.outcome === "preview" ? <GitConfirmation confirmation={preview.confirmation} /> : null}
      {error ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {error}
        </p>
      ) : null}
      <FormFooter
        busy={busy !== null}
        confirmBusy={busy === "confirm"}
        confirmDisabled={!title.trim() || (Boolean(preview) && !offersMutation(preview?.outcome))}
        confirmText={offersMutation(preview?.outcome) ? confirmLabel("pull-request-create", preview?.confirmation) : "Review pull request"}
        onCancel={clearGitAction}
        onConfirm={() => void (offersMutation(preview?.outcome) ? runConfirm() : runPreview())}
      />
    </div>
  );
}

function checkTone(status: GitPullRequest["checks"][number]["status"]): string {
  if (status === "success") return "text-ok";
  if (status === "failure") return "text-danger";
  if (status === "pending") return "text-attention";
  return "text-ink-3";
}

function PrReadBody({ repo }: { repo: string }) {
  const adapter = getChangesAdapter();
  const { host } = useRepoHost(repo);
  const [rawNumber, setRawNumber] = useState("");
  const [pullRequest, setPullRequest] = useState<GitPullRequest | undefined>(undefined);
  const [preview, setPreview] = useState<GitActionResult | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "preview" | "confirm" | null>(null);
  const [intent, setIntent] = useState<"checkout" | "merge" | null>(null);
  const [method, setMethod] = useState<GitPrMergeMethod>("merge");

  const methods = mergeMethodsFor(host);
  const number = parsePullRequestNumber(rawNumber);
  const checks = pullRequest ? checkSummary(pullRequest.checks) : undefined;

  const runRead = async () => {
    if (!adapter.gitPrRead || number === undefined) {
      setError(GIT_PR_READ_FAILED);
      return;
    }
    setBusy("read");
    setError(null);
    setResult(null);
    setPreview(null);
    setIntent(null);
    try {
      const next = await adapter.gitPrRead({ repo, number });
      if (next.outcome === "needs_copy" || next.outcome === "refused" || next.outcome === "uncertain") {
        setResult(next);
        return;
      }
      setPullRequest(next.pullRequest);
      if (next.pullRequest) {
        attachOverlayPullRequest({
          repo,
          number: next.pullRequest.number,
          viewedPaths: (next.pullRequest.files ?? []).filter((file) => file.viewed).map((file) => file.path),
        });
      } else {
        setError(next.message ?? GIT_PR_READ_FAILED);
      }
    } catch (failure) {
      setError(personFacingChangesError(failure, GIT_PR_READ_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async (nextIntent: "checkout" | "merge") => {
    if (number === undefined) return;
    setIntent(nextIntent);
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      const next =
        nextIntent === "checkout"
          ? await adapter.gitPrCheckout?.({ repo, number })
          : await adapter.gitPrMerge?.({ repo, number, method });
      if (next) setPreview(next);
    } catch (failure) {
      setError(personFacingChangesError(failure, nextIntent === "checkout" ? GIT_PR_CHECKOUT_FAILED : GIT_PR_MERGE_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const runConfirm = async () => {
    if (!preview || !offersMutation(preview.outcome) || number === undefined || !intent) return;
    setBusy("confirm");
    setError(null);
    try {
      const next =
        intent === "checkout"
          ? await adapter.gitPrCheckout?.(withConfirm(preview, { repo, number }))
          : await adapter.gitPrMerge?.(withConfirm(preview, { repo, number, method }));
      if (next) {
        setResult(next);
        if (next.outcome === "done") refreshChanges();
      }
    } catch (failure) {
      setError(personFacingChangesError(failure, intent === "checkout" ? GIT_PR_CHECKOUT_FAILED : GIT_PR_MERGE_FAILED));
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? (preview && preview.outcome !== "preview" ? preview : null);
  if (shown) {
    return (
      <GitOutcomeView
        kind="pull-request-read"
        result={shown}
        onClose={clearGitAction}
        {...(offersPreviewAgain(shown.outcome)
          ? { onReviewAgain: () => void (intent ? runPreview(intent) : runRead()) }
          : {})}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy !== null}>
      {hostStatusSentence(host) ? <p className="text-sm text-ink-2">{hostStatusSentence(host)}</p> : null}
      <label className="flex flex-col gap-1">
        <span className="eyebrow">Number</span>
        <Input
          data-git-autofocus
          aria-label="Pull request number"
          inputMode="numeric"
          value={rawNumber}
          onChange={(event) => setRawNumber(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runRead();
            }
          }}
          className="tnum pointer-coarse:min-h-11"
        />
      </label>
      <Button
        variant="outline"
        className="self-start pointer-coarse:min-h-11"
        disabled={busy !== null || number === undefined}
        onClick={() => void runRead()}
      >
        {busy === "read" ? <BusyMark label="Reading…" /> : "Read pull request"}
      </Button>
      {pullRequest ? (
        <div data-slot="git-pull-request" className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-ink">{pullRequest.title}</p>
            <p className="text-xs text-ink-2">
              <span className="typed">{pullRequest.head}</span>
              <span> into </span>
              <span className="typed">{pullRequest.base}</span>
              <span> · </span>
              <span className="tnum">{pullRequest.state}</span>
            </p>
          </div>
          {pullRequest.body ? <p className="whitespace-pre-wrap text-sm text-ink-2">{pullRequest.body}</p> : null}
          {checks && checks.total ? (
            <div>
              <p className="eyebrow mb-1">Checks</p>
              {checks.failed ? (
                <p className="mb-1 text-sm text-danger">
                  {checks.failed.toLocaleString().replace(/,/g, "\u00a0")} {checks.failed === 1 ? "check" : "checks"} failed
                </p>
              ) : null}
              <ul className="flex flex-col gap-1">
                {pullRequest.checks.map((check) => (
                  <li key={check.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{check.name}</span>
                    <span className={cn("tnum shrink-0 text-xs", checkTone(check.status))}>{check.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pullRequest.comments.length ? (
            <div>
              <p className="eyebrow mb-1">Comments</p>
              <ul className="flex flex-col">
                {pullRequest.comments.map((comment) => (
                  <li key={comment.id} className="flex flex-col gap-0.5 hairline-t py-2 first:border-t-0 first:pt-0">
                    <p className="typed text-ink-3">{comment.author}</p>
                    <p className="whitespace-pre-wrap text-sm text-ink">{comment.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pullRequest.state !== "open" ? <p className="text-sm text-ink-2">{GIT_PR_NOT_OPEN}</p> : null}
          {pullRequest.state === "open" ? (
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Merge method</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Merge method">
                {methods.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={method === option}
                    className={cn(
                      "h-7 rounded-full border px-2.5 text-xs font-medium outline-none pointer-coarse:min-h-11",
                      "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                      method === option
                        ? "border-transparent bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live"
                        : "border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )}
                    onClick={() => setMethod(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {host?.host === "bitbucket" ? <p className="text-xs text-ink-3">{GIT_BITBUCKET_REBASE}</p> : null}
              {!mergeMethodAllowed(host, method) ? <p className="text-sm text-ink-2">{GIT_BITBUCKET_REBASE}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {preview && preview.outcome === "preview" ? <GitConfirmation confirmation={preview.confirmation} /> : null}
      {error ? (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm text-ink">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={clearGitAction} disabled={busy !== null}>
          Cancel
        </Button>
        {pullRequest ? (
          <Button
            variant="outline"
            className="pointer-coarse:min-h-11"
            disabled={busy !== null}
            onClick={() => void (intent === "checkout" && offersMutation(preview?.outcome) ? runConfirm() : runPreview("checkout"))}
          >
            {busy === "confirm" && intent === "checkout" ? (
              <BusyMark label="Working…" />
            ) : intent === "checkout" && offersMutation(preview?.outcome) ? (
              "Check out branch"
            ) : (
              "Review checkout"
            )}
          </Button>
        ) : null}
        {pullRequest?.state === "open" ? (
          <Button
            className="pointer-coarse:min-h-11"
            disabled={busy !== null || !mergeMethodAllowed(host, method)}
            onClick={() => void (intent === "merge" && offersMutation(preview?.outcome) ? runConfirm() : runPreview("merge"))}
          >
            {busy === "confirm" && intent === "merge" ? <BusyMark label="Working…" /> : intent === "merge" && offersMutation(preview?.outcome) ? "Merge pull request" : "Review merge"}
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}
