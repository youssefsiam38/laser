/**
 * M5-T1: the `piorbit://` parser.
 *
 * Tested because it is a parser handed hostile-ish input by the operating
 * system, and because the one thing it must never do is turn a link into a
 * plausible-looking wrong path. Everything else in the shell needs an Electron
 * process to exercise; this does not.
 */
import { describe, expect, it } from "vitest";
import { buildDeepLink, deepLinkFromArgv, parseDeepLink } from "../src/deep-links.js";

describe("parseDeepLink", () => {
  it("reads the canonical percent-encoded form", () => {
    expect(parseDeepLink("piorbit://session/%2Fhome%2Fme%2Fp%2Fs.jsonl")).toEqual({
      kind: "session",
      path: "/home/me/p/s.jsonl",
    });
  });

  it("reads a hand-written unencoded path", () => {
    expect(parseDeepLink("piorbit://session//home/me/p/s.jsonl")).toEqual({
      kind: "session",
      path: "/home/me/p/s.jsonl",
    });
  });

  it("keeps a path that contains characters a URL treats specially", () => {
    const path = "/home/me/a project/what? #1/s.jsonl";
    expect(parseDeepLink(buildDeepLink({ kind: "session", path }))).toEqual({ kind: "session", path });
  });

  it("keeps case in the path and ignores it in the verb", () => {
    expect(parseDeepLink("piorbit://Session/%2FUsers%2FMe%2FProj%2FS.jsonl")).toEqual({
      kind: "session",
      path: "/Users/Me/Proj/S.jsonl",
    });
  });

  it("accepts a Windows path", () => {
    const path = "C:\\Users\\me\\proj\\s.jsonl";
    expect(parseDeepLink(buildDeepLink({ kind: "session", path }))).toEqual({ kind: "session", path });
  });

  it("accepts a UNC path", () => {
    expect(parseDeepLink("piorbit://project/%5C%5Cbuild01%5Csrc%5Cproj")).toEqual({
      kind: "project",
      cwd: "\\\\build01\\src\\proj",
    });
  });

  it("reads the query form", () => {
    expect(parseDeepLink("piorbit://session?path=%2Fa%2Fb.jsonl")).toEqual({ kind: "session", path: "/a/b.jsonl" });
  });

  it("reads a bare open link", () => {
    expect(parseDeepLink("piorbit://open")).toEqual({ kind: "open" });
  });

  it("refuses a relative path, which could otherwise resolve anywhere", () => {
    expect(parseDeepLink("piorbit://session/..%2F..%2Fetc%2Fpasswd")).toBeUndefined();
    expect(parseDeepLink("piorbit://session/s.jsonl")).toBeUndefined();
  });

  it("refuses an embedded NUL", () => {
    expect(parseDeepLink("piorbit://session/%2Fhome%2Fme%00.jsonl")).toBeUndefined();
  });

  it("refuses a malformed escape rather than throwing", () => {
    expect(parseDeepLink("piorbit://session/%zz")).toBeUndefined();
  });

  it("refuses another scheme, an unknown verb, and junk", () => {
    expect(parseDeepLink("https://example.com/session//home/me")).toBeUndefined();
    expect(parseDeepLink("piorbit://drop/%2Fhome%2Fme")).toBeUndefined();
    expect(parseDeepLink("not a url")).toBeUndefined();
  });

  it("round-trips every kind", () => {
    for (const link of [
      { kind: "open" },
      { kind: "session", path: "/home/me/p/s.jsonl" },
      { kind: "project", cwd: "/home/me/p" },
    ] as const) {
      expect(parseDeepLink(buildDeepLink(link))).toEqual(link);
    }
  });
});

describe("deepLinkFromArgv", () => {
  it("finds a link among Chromium's own switches", () => {
    const argv = ["/opt/piorbit/piorbit", "--allow-file-access-from-files", "piorbit://session/%2Fa%2Fb.jsonl"];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/a/b.jsonl" });
  });

  it("takes the newest when two arrived at once", () => {
    const argv = ["piorbit://session/%2Fa.jsonl", "piorbit://session/%2Fb.jsonl"];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/b.jsonl" });
  });

  it("skips a piorbit link it cannot use and keeps looking", () => {
    const argv = ["piorbit://session/%2Fa.jsonl", "piorbit://nonsense"];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/a.jsonl" });
  });

  it("finds nothing in an ordinary launch", () => {
    expect(deepLinkFromArgv(["/opt/piorbit/piorbit", "--no-sandbox"])).toBeUndefined();
  });
});
