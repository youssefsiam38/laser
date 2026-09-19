/**
 * Git actions (L6): host discovery, mutations, prose, safety. CLI and HTTP
 * are injected; nothing here talks to GitHub or Bitbucket.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitActionsService } from "../src/git-actions/service.js";
import { hiddenRefPrefix, isHiddenProductRef, parseRemoteUrl } from "../src/git-actions/remotes.js";
import { cleanProse, excerptFromEntries, prosePrompt } from "../src/git-actions/prose.js";
import { redactSecrets, type GitActionsFetcher, type ProcessResult, type ProcessRunner } from "../src/git-actions/runner.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-${prefix}-`));
  temps.push(dir);
  return dir;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
}

function recording(
  script: (command: string, args: readonly string[]) => Partial<ProcessResult> | string | undefined,
): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    const answer = script(command, args);
    if (typeof answer === "string") return { code: 0, stdout: answer, stderr: "", spawned: true, timedOut: false };
    return {
      code: answer?.code ?? 0,
      stdout: answer?.stdout ?? "",
      stderr: answer?.stderr ?? "",
      spawned: answer?.spawned ?? true,
      timedOut: answer?.timedOut ?? false,
    };
  };
  return { run, calls };
}

function githubScript(overrides: (command: string, args: readonly string[]) => Partial<ProcessResult> | string | undefined = () => undefined) {
  return (command: string, args: readonly string[]): Partial<ProcessResult> | string | undefined => {
    const hit = overrides(command, args);
    if (hit !== undefined) return hit;
    if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return "true\n";
    if (command === "git" && args[0] === "symbolic-ref" && args.includes("HEAD") && !args.some((a) => a.includes("remotes"))) return "main\n";
    if (command === "git" && args[0] === "symbolic-ref" && args.some((a) => a.includes("remotes"))) return "origin/main\n";
    if (command === "git" && args[0] === "remote" && args[1] === "-v") {
      return "origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n";
    }
    if (command === "git" && args[0] === "remote") return "origin\n";
    if (command === "git" && args[0] === "check-ref-format") return { code: 0 };
    if (command === "git" && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) return `refs/heads/${args.at(-1)}\n`;
    if (command === "git" && args[0] === "rev-parse" && args.includes("--verify")) return { code: 0, stdout: "abc\n" };
    if (command === "git" && args[0] === "show-ref") return { code: 0 };
    if (command === "gh" && args[0] === "--version") return "gh 2.0\n";
    if (command === "gh" && args[0] === "auth") return { code: 0, stderr: "Logged in\n" };
    return undefined;
  };
}

describe("remote parsing", () => {
  it("classifies GitHub and Bitbucket remotes and leaves others unsupported", () => {
    expect(parseRemoteUrl("git@github.com:acme/app.git")).toMatchObject({ host: "github", owner: "acme", name: "app" });
    expect(parseRemoteUrl("https://github.com/acme/app.git")).toMatchObject({ host: "github" });
    expect(parseRemoteUrl("https://bitbucket.org/ws/app.git")).toMatchObject({ host: "bitbucket", owner: "ws", name: "app" });
    expect(parseRemoteUrl("git@bitbucket.org:ws/app.git")).toMatchObject({ host: "bitbucket" });
    expect(parseRemoteUrl("git@gitlab.com:acme/app.git")).toMatchObject({ host: "unsupported", hostname: "gitlab.com" });
  });

  it("refuses the product hidden ref namespace and not an ordinary branch", () => {
    expect(isHiddenProductRef(`${hiddenRefPrefix()}checkpoints/s/1`)).toBe(true);
    expect(isHiddenProductRef("main")).toBe(false);
    expect(isHiddenProductRef("refs/heads/main")).toBe(false);
  });
});

describe("host discovery", () => {
  it("keeps working when one repository's CLI is missing and another's host is unsupported", async () => {
    const { run } = recording((command, args) => {
      const cwdHint = args.join(" ");
      void cwdHint;
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return "true\n";
      if (command === "git" && args[0] === "symbolic-ref" && args.includes("HEAD") && !args.some((a) => String(a).includes("remotes"))) return "main\n";
      if (command === "git" && args[0] === "symbolic-ref" && args.some((a) => String(a).includes("remotes"))) return "origin/main\n";
      if (command === "git" && args[0] === "show-ref") return { code: 0 };
      if (command === "git" && args[0] === "remote" && args[1] === "-v") {
        return undefined;
      }
      if (command === "gh") return { spawned: false, code: 127 };
      return undefined;
    });
    const project = temp("hosts");
    const github = join(project, "github");
    const gitlab = join(project, "gitlab");
    const bitbucket = join(project, "bitbucket");
    mkdirSync(github); mkdirSync(gitlab); mkdirSync(bitbucket);
    const runPerRepo: ProcessRunner = async (command, args, options) => {
      if (command === "git" && args[0] === "remote" && args[1] === "-v") {
        if (options.cwd === github) return { code: 0, stdout: "origin\tgit@github.com:acme/app.git (fetch)\n", stderr: "", spawned: true, timedOut: false };
        if (options.cwd === gitlab) return { code: 0, stdout: "origin\tgit@gitlab.com:acme/app.git (fetch)\n", stderr: "", spawned: true, timedOut: false };
        if (options.cwd === bitbucket) return { code: 0, stdout: "origin\thttps://bitbucket.org/ws/app.git (fetch)\n", stderr: "", spawned: true, timedOut: false };
      }
      if (command === "gh") return { code: 127, stdout: "", stderr: "", spawned: false, timedOut: false };
      return run(command, args, options);
    };
    const service = new GitActionsService({
      projectCwd: project,
      run: runPerRepo,
      env: {},
    });
    const { hosts } = await service.hosts({ cwd: project, repos: [github, gitlab, bitbucket] });
    expect(hosts).toHaveLength(3);
    const byRepo = Object.fromEntries(hosts.map((row) => [row.repo, row]));
    expect(byRepo[github]).toMatchObject({ host: "github", usable: false });
    expect(byRepo[github]?.fix).toContain("gh auth login");
    expect(byRepo[gitlab]).toMatchObject({ host: "unsupported", usable: false });
    expect(byRepo[gitlab]?.fix).toContain("gitlab.com");
    expect(byRepo[bitbucket]).toMatchObject({ host: "bitbucket", usable: false });
    expect(byRepo[bitbucket]?.fix).toContain("BITBUCKET_API_TOKEN");
  });

  it("names the signed-out GitHub CLI with the one command that fixes it", async () => {
    const dir = temp("signed-out");
    const { run } = recording(githubScript((command, args) => {
      if (command === "gh" && args[0] === "auth") return { code: 1, spawned: true, stderr: "You are not logged into any GitHub hosts." };
      return undefined;
    }));
    const service = new GitActionsService({ projectCwd: dir, run, env: {} });
    const { hosts } = await service.hosts({ cwd: dir, repos: [dir] });
    expect(hosts[0]).toMatchObject({ host: "github", cliPresent: true, signedIn: false, usable: false });
    expect(hosts[0]?.fix).toBe("Run gh auth login.");
  });
});

describe("commit, push, branch", () => {
  it("commits an explicit path set in a real repository without confirm, then with confirm", async () => {
    const dir = temp("commit");
    gitInit(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const service = new GitActionsService({ projectCwd: dir, env: {} });
    const preview = await service.commit({ cwd: dir, paths: ["a.ts"], message: "Bump a" });
    expect(preview.outcome).toBe("preview");
    expect(preview.confirmation.files).toEqual(["a.ts"]);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir }).toString().trim()).toBe("init");
    const done = await service.commit({ cwd: dir, paths: ["a.ts"], message: "Bump a", confirm: true });
    expect(done.outcome).toBe("done");
    expect(done.commit?.subject).toBe("Bump a");
  });

  it("pushes to a local remote, never force, and previews first", async () => {
    const dir = temp("push");
    gitInit(dir);
    writeFileSync(join(dir, "a.ts"), "a\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    const bare = temp("bare");
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
    const service = new GitActionsService({ projectCwd: dir, env: {} });
    const preview = await service.push({ cwd: dir, remote: "origin", branch: "main" });
    expect(preview.outcome).toBe("preview");
    expect(preview.copyable?.argv).toEqual(["git", "push", "origin", "main"]);
    const done = await service.push({ cwd: dir, remote: "origin", branch: "main", confirm: true });
    expect(done.outcome).toBe("done");
    expect(done.pushed).toEqual({ remote: "origin", branch: "main" });
  });

  it("creates a branch from an explicit base", async () => {
    const dir = temp("branch");
    gitInit(dir);
    writeFileSync(join(dir, "a.ts"), "a\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    const service = new GitActionsService({ projectCwd: dir, env: {} });
    const done = await service.branch({ cwd: dir, name: "feature/x", base: "main", confirm: true });
    expect(done.outcome).toBe("done");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "feature/x"], { cwd: dir }).toString().trim()).toBe("feature/x");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim()).toBe("main");
  });

  it("passes hostile user text as argv elements, never a shell string", async () => {
    const hostileBranch = "foo; rm -rf /";
    const hostileMessage = "$(reboot)";
    const hostilePath = "a.ts; id";
    const { run, calls } = recording(githubScript((command, args) => {
      if (command === "git" && args[0] === "check-ref-format") return { code: 0 };
      if (command === "git" && args[0] === "commit") return { code: 0, stdout: "" };
      if (command === "git" && args[0] === "rev-parse" && args.includes("--short")) return "abc123\n";
      if (command === "git" && args[0] === "log") return "subject\n";
      return undefined;
    }));
    const dir = temp("hostile");
    const service = new GitActionsService({ projectCwd: dir, run, env: {} });
    await service.commit({ cwd: dir, paths: [hostilePath], message: hostileMessage, confirm: true });
    await service.branch({ cwd: dir, name: hostileBranch, base: "main", confirm: true }).catch(() => undefined);
    expect(calls.some((call) => call.command === "git" && call.args[0] === "commit" && call.args.includes(hostileMessage) && call.args.includes("--") && call.args.includes(hostilePath))).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.includes(hostileBranch))).toBe(true);
    expect(calls.every((call) => Array.isArray(call.args))).toBe(true);
    expect(calls.every((call) => !call.args.some((arg) => arg.includes("git commit") || arg.includes("git branch")))).toBe(true);
  });

  it("refuses to push a hidden product ref and reports an uncertain push without retrying", async () => {
    const hidden = `${hiddenRefPrefix()}checkpoints/s/1`;
    let pushes = 0;
    const { run } = recording(githubScript((command, args) => {
      if (command === "git" && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) return `${hidden}\n`;
      if (command === "git" && args[0] === "push") {
        pushes += 1;
        return { code: 1, spawned: true, timedOut: true, stderr: "fatal: unable to access 'https://example/': Could not resolve host" };
      }
      return undefined;
    }));
    const dir = temp("hidden");
    const service = new GitActionsService({ projectCwd: dir, run, env: {} });
    await expect(service.push({ cwd: dir, remote: "origin", branch: hidden, confirm: true })).rejects.toThrow(hiddenRefPrefix());
    expect(pushes).toBe(0);

    const { run: runNet } = recording(githubScript((command, args) => {
      if (command === "git" && args[0] === "push") {
        pushes += 1;
        return { code: 1, spawned: true, stderr: "fatal: unable to access: Could not resolve host" };
      }
      if (command === "git" && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) return "refs/heads/main\n";
      return undefined;
    }));
    const net = new GitActionsService({ projectCwd: dir, run: runNet, env: {} });
    const first = await net.push({ cwd: dir, remote: "origin", branch: "main", confirm: true });
    expect(first.outcome).toBe("uncertain");
    expect(first.message).toMatch(/may or may not/);
    const second = await net.push({ cwd: dir, remote: "origin", branch: "main", confirm: true });
    expect(second.outcome).toBe("uncertain");
    expect(pushes).toBe(2);
  });
});

describe("pull requests", () => {
  it("opens, reads, checks out and merges a GitHub pull request through gh argv", async () => {
    const { run, calls } = recording(githubScript((command, args) => {
      if (command === "gh" && args[0] === "pr" && args[1] === "create") return "https://github.com/acme/app/pull/12\n";
      if (command === "gh" && args[0] === "pr" && args[1] === "view" && args.includes("--json")) {
        return JSON.stringify({
          id: "PR_1",
          number: 12,
          title: "Fix",
          body: "Does the thing.",
          url: "https://github.com/acme/app/pull/12",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature/x",
          comments: [{ id: "1", author: { login: "ada" }, body: "looks good" }],
          reviews: [],
          statusCheckRollup: [{ name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/a.ts" }],
        });
      }
      if (command === "gh" && args[0] === "api") {
        return JSON.stringify({ data: { node: { files: { nodes: [{ path: "src/a.ts", viewerViewedState: "VIEWED" }] } } } });
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "checkout") return { code: 0 };
      if (command === "gh" && args[0] === "pr" && args[1] === "merge") return { code: 0 };
      return undefined;
    }));
    const dir = temp("gh-pr");
    const service = new GitActionsService({ projectCwd: dir, run, env: {} });
    const created = await service.createPr({ cwd: dir, title: "Fix", body: "Does the thing.", base: "main", head: "feature/x", confirm: true });
    expect(created.outcome).toBe("done");
    expect(created.pullRequest?.number).toBe(12);
    const read = await service.readPr({ cwd: dir, number: 12 });
    expect(read.pullRequest?.comments[0]?.body).toBe("looks good");
    expect(read.pullRequest?.checks[0]?.status).toBe("success");
    expect(read.pullRequest?.files?.[0]).toMatchObject({ path: "src/a.ts", viewed: true });
    const checked = await service.checkoutPr({ cwd: dir, number: 12, confirm: true });
    expect(checked.outcome).toBe("done");
    const merged = await service.mergePr({ cwd: dir, number: 12, method: "squash", confirm: true });
    expect(merged.outcome).toBe("done");
    expect(calls.some((call) => call.command === "gh" && call.args.includes("--squash"))).toBe(true);
    expect(calls.filter((call) => call.command === "git" || (call.command === "gh" && call.args[0] === "pr")).every((call) => !call.args.includes("--force"))).toBe(true);
  });

  it("creates and reads a Bitbucket pull request without putting the token in a result", async () => {
    const token = "ATATT" + "secretvalue00000000";
    const bodies: string[] = [];
    const seenAuth: string[] = [];
    const fetchImpl: GitActionsFetcher = async (request) => {
      if (request.headers.Authorization) seenAuth.push(request.headers.Authorization);
      if (request.method === "POST" && request.url.endsWith("/pullrequests")) {
        return { status: 201, text: JSON.stringify({ id: 9, title: "Fix", links: { html: { href: "https://bitbucket.org/ws/app/pull-requests/9" } } }) };
      }
      if (request.url.includes("/comments")) return { status: 200, text: JSON.stringify({ values: [{ id: 1, user: { display_name: "Ada" }, content: { raw: "nits" } }] }) };
      if (request.url.includes("/statuses")) return { status: 200, text: JSON.stringify({ values: [{ name: "build", state: "SUCCESSFUL" }] }) };
      return {
        status: 200,
        text: JSON.stringify({
          id: 9,
          title: "Fix",
          description: "Does the thing.",
          state: "OPEN",
          source: { branch: { name: "feature/x" } },
          destination: { branch: { name: "main" } },
          links: { html: { href: "https://bitbucket.org/ws/app/pull-requests/9" } },
        }),
      };
    };
    const { run } = recording(githubScript((command, args) => {
      if (command === "git" && args[0] === "remote" && args[1] === "-v") {
        return "origin\thttps://bitbucket.org/ws/app.git (fetch)\n";
      }
      return undefined;
    }));
    const dir = temp("bb-pr");
    const service = new GitActionsService({
      projectCwd: dir,
      run,
      fetch: fetchImpl,
      env: { BITBUCKET_API_TOKEN: token },
    });
    const created = await service.createPr({ cwd: dir, title: "Fix", body: "Does the thing.", base: "main", head: "feature/x", confirm: true });
    expect(created.outcome).toBe("done");
    expect(created.pullRequest?.number).toBe(9);
    expect(JSON.stringify(created)).not.toContain(token);
    const read = await service.readPr({ cwd: dir, number: 9 });
    expect(read.pullRequest?.comments[0]?.author).toBe("Ada");
    expect(JSON.stringify(read)).not.toContain(token);
    expect(bodies).toEqual([]);
  });

  it("keeps Bitbucket viewed marks locally and redacts credential-shaped text", async () => {
    const dir = temp("viewed");
    const viewedFile = join(dir, "viewed.json");
    const { run } = recording(githubScript((command, args) => {
      if (command === "git" && args[0] === "remote" && args[1] === "-v") {
        return "origin\thttps://bitbucket.org/ws/app.git (fetch)\n";
      }
      return undefined;
    }));
    const service = new GitActionsService({
      projectCwd: dir,
      run,
      fetch: async () => ({ status: 200, text: "{}" }),
      env: { BITBUCKET_API_TOKEN: "ATATT" + "localonly00000000" },
      viewedFile,
    });
    const marked = await service.viewed({ cwd: dir, number: 3, path: "src/a.ts", viewed: true });
    expect(marked.outcome).toBe("done");
    const stored = JSON.parse(readFileSync(viewedFile, "utf8")) as Record<string, Record<string, boolean>>;
    expect(stored["ws/app#3"]?.["src/a.ts"]).toBe(true);
    expect(redactSecrets("token ghp_abcdefghijklmnop and Bearer xyz.abc")).toContain("[redacted]");
    expect(redactSecrets("token ghp_abcdefghijklmnop")).not.toContain("ghp_abcdef");
  });
});

describe("prose", () => {
  it("asks the session model, returns editable text, and never commits", async () => {
    const dir = temp("prose");
    gitInit(dir);
    writeFileSync(join(dir, "a.ts"), "a\n");
    execFileSync("git", ["add", "a.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feat: add a"], { cwd: dir });
    let committed = false;
    const { run } = recording((command, args) => {
      if (command === "git" && args[0] === "commit") {
        committed = true;
        return { code: 0 };
      }
      if (command === "git" && args[0] === "log") return "feat: add a\n";
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return "true\n";
      return { code: 0, stdout: "" };
    });
    const service = new GitActionsService({
      projectCwd: dir,
      run,
      env: {},
      proseRuntime: async () => ({
        getModel: (provider, id) => ({ provider, id }),
        completeSimple: async (_model, context) => {
          expect(context.systemPrompt).toMatch(/commit message/i);
          expect(context.messages[0]?.content).toContain("feat: add a");
          expect(context.messages[0]?.content).toContain("a.ts");
          return { content: [{ type: "text", text: "fix: bump a" }] };
        },
      }),
      sessionContext: async () => ({ model: { provider: "stub", id: "stub-1" }, excerpt: "Please bump a." }),
    });
    const result = await service.prose({ cwd: dir, path: "/s.jsonl", kind: "commit", files: ["a.ts"] });
    expect(result.text).toBe("fix: bump a");
    expect(result.model).toEqual({ provider: "stub", id: "stub-1" });
    expect(committed).toBe(false);
    expect(cleanProse("```\nTitle: Hello.\n```", "pr_title")).toBe("Hello.");
    expect(excerptFromEntries([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }])).toContain("hi");
    const prompt = prosePrompt("pr_description", ["a.ts"], "+1", ["feat: add a"], "Use conventional commits.", "Please bump a.");
    expect(prompt.messages[0]?.content).toContain("conventional commits");
  });
});

describe("copyable fallback", () => {
  it("models a copyable command when GitHub is signed out", async () => {
    const { run } = recording(githubScript((command, args) => {
      if (command === "gh" && args[0] === "auth") return { code: 1, spawned: true };
      if (command === "gh" && args[0] === "--version") return "gh 2\n";
      return undefined;
    }));
    const dir = temp("copy");
    const service = new GitActionsService({ projectCwd: dir, run, env: {} });
    await expect(service.createPr({ cwd: dir, title: "Fix", body: "x", base: "main", head: "f", confirm: true })).rejects.toThrow(/gh auth login/);
  });
});
