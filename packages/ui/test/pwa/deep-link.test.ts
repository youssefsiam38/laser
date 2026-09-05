/**
 * Notification URLs: the decision rides the query string and the session the
 * hash, both directions round-trip, and a stale intent is dropped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME, decisionNavigateUrl, decisionPushPayload } from "@piorbit/protocol";
import { LINK_TTL_MS, parseDecisionLink, pendingDecisionLink, rememberDecisionLink, resetDecisionLinks, stripDecisionParams } from "../../src/pwa/deep-link.js";

const path = "/home/me/.pi/agent/sessions/x/2026 09 05.jsonl";

describe("decision links", () => {
  afterEach(resetDecisionLinks);

  it("round-trips through decisionNavigateUrl", () => {
    const url = new URL(decisionNavigateUrl("https://relay.example", path, "d-42", "deny"));
    expect(url.origin).toBe("https://relay.example");
    expect(parseDecisionLink(url.search, url.hash, 1000)).toEqual({ decisionId: "d-42", answer: "deny", sessionPath: path, at: 1000 });
    const plain = new URL(decisionNavigateUrl("https://relay.example/", path, "d-42"));
    expect(parseDecisionLink(plain.search, plain.hash, 1)).toEqual({ decisionId: "d-42", sessionPath: path, at: 1 });
  });

  it("ignores unknown answers and URLs without a decision", () => {
    expect(parseDecisionLink("?decision=a&answer=maybe", "", 1)).toEqual({ decisionId: "a", at: 1 });
    expect(parseDecisionLink("?foo=1", "#/session/x")).toBeUndefined();
  });

  it("strips only its own parameters", () => {
    expect(stripDecisionParams("?decision=a&answer=allow&shortcut=inbox")).toBe("?shortcut=inbox");
    expect(stripDecisionParams("?decision=a")).toBe("");
  });

  it("forgets a link older than the TTL", () => {
    rememberDecisionLink({ search: "?decision=old", hash: "" });
    const link = pendingDecisionLink();
    expect(link?.decisionId).toBe("old");
    (link as { at: number }).at = Date.now() - LINK_TTL_MS - 1;
    expect(pendingDecisionLink()).toBeUndefined();
  });
});

describe("decisionPushPayload", () => {
  it("is one declarative document with buttons only for yes/no", () => {
    const yesNo = decisionPushPayload({ origin: "https://r.example", sessionPath: path, projectName: PRODUCT_NAME, decisionId: "d1", title: "Allow bash?", message: "rm -rf dist", yesNo: true });
    expect(yesNo.web_push).toBe(8030);
    expect(yesNo.notification.title).toBe(`${PRODUCT_NAME} needs you`);
    expect(yesNo.notification.body).toBe("Allow bash? — rm -rf dist");
    expect(yesNo.notification.tag).toBe("decision:d1");
    expect(yesNo.notification.actions?.map((a) => a.action)).toEqual(["allow", "deny"]);
    expect(yesNo.notification.actions?.[0]?.navigate).toContain("answer=allow");
    const pick = decisionPushPayload({ origin: "https://r.example", sessionPath: path, projectName: PRODUCT_NAME, decisionId: "d2", title: "Pick one", yesNo: false });
    expect(pick.notification.actions).toBeUndefined();
    expect(pick.notification.body).toBe("Pick one");
  });

  it("clips a long body on a word boundary", () => {
    const long = decisionPushPayload({ origin: "https://r.example", sessionPath: path, projectName: "p", decisionId: "d", title: "Allow?", message: "word ".repeat(80), yesNo: true });
    expect(long.notification.body!.length).toBeLessThanOrEqual(161);
    expect(long.notification.body!.endsWith("…")).toBe(true);
  });
});
