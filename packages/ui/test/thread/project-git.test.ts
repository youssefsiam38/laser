import { describe, expect, it } from "vitest";
import { githubCompareUrl, parseGitHubRemote, pullRequestCommands } from "../../src/components/thread/project-git.js";

describe("parseGitHubRemote", () => {
  it("reads the three remote URL shapes and rejects the rest", () => {
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
    expect(parseGitHubRemote("https://github.com/o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseGitHubRemote("https://user@github.com/o/r.git/")).toEqual({ owner: "o", repo: "r" });
    expect(parseGitHubRemote("ssh://git@github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseGitHubRemote("git@gitlab.com:o/r.git")).toBeUndefined();
    expect(parseGitHubRemote("/srv/git/r.git")).toBeUndefined();
  });

  it("builds a compare link against the upstream's branch", () => {
    expect(githubCompareUrl("git@github.com:o/r.git", "origin/main", "feat/x")).toBe(
      "https://github.com/o/r/compare/main...feat/x?expand=1",
    );
    expect(githubCompareUrl("git@gitlab.com:o/r.git", "origin/main", "feat/x")).toBeUndefined();
  });

  it("writes the push and the gh command with the remote and base from the upstream", () => {
    expect(pullRequestCommands("feat/x", "origin/main")).toEqual(["git push -u origin feat/x", "gh pr create --web --base main"]);
    expect(pullRequestCommands("main", "origin/main")).toEqual(["git push -u origin main", "gh pr create --web"]);
    expect(pullRequestCommands("odd name", undefined)).toEqual(["git push -u origin 'odd name'", "gh pr create --web"]);
  });
});
