/**
 * Pure helpers for the project line under the composer (M2-T6). No React.
 * Tested in test/thread/project-git.test.ts.
 */

/** Tools whose completion can change the working tree, so the git line re-reads after the turn. */
export const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

export interface GitHubRemote {
  owner: string;
  repo: string;
}

/**
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo(.git)`,
 * `ssh://git@github.com/owner/repo.git` → `{ owner, repo }`; anything else
 * (GitLab, a bare path) → `undefined`, and the dialog shows commands only.
 */
export function parseGitHubRemote(url: string): GitHubRemote | undefined {
  const m =
    /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m || !m[1] || !m[2]) return undefined;
  return { owner: m[1], repo: m[2] };
}

/** `origin/main` → `main`; a ref with no remote prefix passes through. */
export function branchOfUpstream(upstream: string): string {
  const slash = upstream.indexOf("/");
  return slash === -1 ? upstream : upstream.slice(slash + 1);
}

/** GitHub's compare page for `base...head`, prefilled as a new pull request. */
export function githubCompareUrl(remoteUrl: string, upstream: string, branch: string): string | undefined {
  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) return undefined;
  const base = branchOfUpstream(upstream);
  const enc = (s: string) => encodeURIComponent(s).replace(/%2F/g, "/");
  return `https://github.com/${enc(remote.owner)}/${enc(remote.repo)}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}

/** The exact commands the "Create PR" dialog shows. `gh` is optional; the push is not. */
export function pullRequestCommands(branch: string, upstream: string | undefined): string[] {
  const remote = upstream && upstream.includes("/") ? upstream.slice(0, upstream.indexOf("/")) : "origin";
  const base = upstream ? branchOfUpstream(upstream) : undefined;
  const cmds = [`git push -u ${remote} ${shellQuote(branch)}`];
  cmds.push(base && base !== branch ? `gh pr create --web --base ${shellQuote(base)}` : "gh pr create --web");
  return cmds;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._\/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `+12 −3` style pieces; an empty array when nothing changed. */
export function deltaParts(added: number, removed: number): Array<{ sign: "+" | "−"; value: number }> {
  const parts: Array<{ sign: "+" | "−"; value: number }> = [];
  if (added > 0) parts.push({ sign: "+", value: added });
  if (removed > 0) parts.push({ sign: "−", value: removed });
  return parts;
}
