/**
 * M5-T1: the deep-link parser.
 *
 * Tested because it is a parser handed hostile-ish input by the operating
 * system, and because the one thing it must never do is turn a link into a
 * plausible-looking wrong path. Everything else in the shell needs an Electron
 * process to exercise; this does not.
 */
import { PRODUCT_NAME, URL_SCHEME_PREFIX } from "@piorbit/protocol";
import { describe, expect, it } from "vitest";
import { buildDeepLink, deepLinkFromArgv, parseDeepLink } from "../src/deep-links.js";

describe("parseDeepLink", () => {
  it("reads the canonical percent-encoded form", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session/%2Fhome%2Fme%2Fp%2Fs.jsonl`)).toEqual({
      kind: "session",
      path: "/home/me/p/s.jsonl",
    });
  });

  it("reads a hand-written unencoded path", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session//home/me/p/s.jsonl`)).toEqual({
      kind: "session",
      path: "/home/me/p/s.jsonl",
    });
  });

  it("keeps a path that contains characters a URL treats specially", () => {
    const path = "/home/me/a project/what? #1/s.jsonl";
    expect(parseDeepLink(buildDeepLink({ kind: "session", path }))).toEqual({ kind: "session", path });
  });

  it("keeps case in the path and ignores it in the verb", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}Session/%2FUsers%2FMe%2FProj%2FS.jsonl`)).toEqual({
      kind: "session",
      path: "/Users/Me/Proj/S.jsonl",
    });
  });

  it("accepts a Windows path", () => {
    const path = "C:\\Users\\me\\proj\\s.jsonl";
    expect(parseDeepLink(buildDeepLink({ kind: "session", path }))).toEqual({ kind: "session", path });
  });

  it("accepts a UNC path", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}project/%5C%5Cbuild01%5Csrc%5Cproj`)).toEqual({
      kind: "project",
      cwd: "\\\\build01\\src\\proj",
    });
  });

  it("reads the query form", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session?path=%2Fa%2Fb.jsonl`)).toEqual({ kind: "session", path: "/a/b.jsonl" });
  });

  it("reads a bare open link", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}open`)).toEqual({ kind: "open" });
  });

  it("refuses a relative path, which could otherwise resolve anywhere", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session/..%2F..%2Fetc%2Fpasswd`)).toBeUndefined();
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session/s.jsonl`)).toBeUndefined();
  });

  it("refuses an embedded NUL", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session/%2Fhome%2Fme%00.jsonl`)).toBeUndefined();
  });

  it("refuses a malformed escape rather than throwing", () => {
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}session/%zz`)).toBeUndefined();
  });

  it("refuses another scheme, an unknown verb, and junk", () => {
    expect(parseDeepLink("https://example.com/session//home/me")).toBeUndefined();
    expect(parseDeepLink(`${URL_SCHEME_PREFIX}drop/%2Fhome%2Fme`)).toBeUndefined();
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
    const argv = [`/opt/${PRODUCT_NAME}/${PRODUCT_NAME}`, "--allow-file-access-from-files", `${URL_SCHEME_PREFIX}session/%2Fa%2Fb.jsonl`];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/a/b.jsonl" });
  });

  it("takes the newest when two arrived at once", () => {
    const argv = [`${URL_SCHEME_PREFIX}session/%2Fa.jsonl`, `${URL_SCHEME_PREFIX}session/%2Fb.jsonl`];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/b.jsonl" });
  });

  it(`skips a ${PRODUCT_NAME} link it cannot use and keeps looking`, () => {
    const argv = [`${URL_SCHEME_PREFIX}session/%2Fa.jsonl`, `${URL_SCHEME_PREFIX}nonsense`];
    expect(deepLinkFromArgv(argv)).toEqual({ kind: "session", path: "/a.jsonl" });
  });

  it("finds nothing in an ordinary launch", () => {
    expect(deepLinkFromArgv([`/opt/${PRODUCT_NAME}/${PRODUCT_NAME}`, "--no-sandbox"])).toBeUndefined();
  });
});
