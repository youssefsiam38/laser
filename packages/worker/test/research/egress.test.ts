/**
 * Where a research read is allowed to go (M21-T22, threat model §4).
 *
 * The private-address floor is only a floor if it holds for *every* address a
 * read actually reaches, not only the one the model typed. Two ways past it
 * existed before this suite: a public page that answers with a redirect into
 * this machine's network, and the repository adapter, which builds a git
 * remote from any host at all and never consulted the floor.
 *
 * Nothing here touches the network: the fetcher is driven by an inert double
 * that answers from a script, and the repository check is a pure function.
 */
import { describe, expect, it } from "vitest";
import { ResearchRefused } from "../../src/research/errors.js";
import { RESEARCH_FETCH_MAX_REDIRECTS, createResearchFetcher } from "../../src/research/adapters/fetch.js";
import { resolveRepositoryInput } from "../../src/research/adapters/repository.js";

/** A fetch double: one scripted answer per URL, and a record of what was asked. */
function scripted(script: Record<string, { status: number; location?: string; body?: string }>): {
  impl: typeof fetch;
  asked: string[];
} {
  const asked: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push(url);
    const answer = script[url];
    if (!answer) throw new Error(`nothing scripted for ${url}`);
    const headers = new Headers();
    if (answer.location !== undefined) headers.set("location", answer.location);
    const response = new Response(answer.status >= 300 && answer.status < 400 ? null : (answer.body ?? ""), {
      status: answer.status,
      headers,
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as unknown as typeof fetch;
  return { impl, asked };
}

async function refusal(run: () => Promise<unknown>): Promise<ResearchRefused> {
  try {
    await run();
  } catch (failure) {
    if (failure instanceof ResearchRefused) return failure;
    throw failure;
  }
  throw new Error("that call should have been refused");
}

describe("redirects", () => {
  it("refuses a redirect into this machine's own network and never asks for it", async () => {
    const { impl, asked } = scripted({
      "https://docs.example.org/page": { status: 302, location: "http://127.0.0.1:41441/secret" },
    });
    const fetcher = createResearchFetcher(impl);
    const refused = await refusal(() => fetcher({ url: "https://docs.example.org/page" }));
    expect(refused.code).toBe("private_address");
    expect(asked).toEqual(["https://docs.example.org/page"]);
  });

  it("refuses a redirect to a link-local metadata address", async () => {
    const { impl } = scripted({
      "https://docs.example.org/page": { status: 301, location: "http://169.254.169.254/latest/meta-data/" },
    });
    const refused = await refusal(() => createResearchFetcher(impl)({ url: "https://docs.example.org/page" }));
    expect(refused.code).toBe("private_address");
  });

  it("refuses a redirect that leaves http(s) or carries credentials", async () => {
    const scheme = scripted({ "https://docs.example.org/a": { status: 302, location: "file:///etc/passwd" } });
    expect((await refusal(() => createResearchFetcher(scheme.impl)({ url: "https://docs.example.org/a" }))).code).toBe("unsupported_scheme");
    const creds = scripted({ "https://docs.example.org/b": { status: 302, location: "https://user:pw@example.org/x" } });
    expect((await refusal(() => createResearchFetcher(creds.impl)({ url: "https://docs.example.org/b" }))).code).toBe("credentials_in_url");
  });

  it("follows a public redirect and answers with the page it ended at", async () => {
    const { impl, asked } = scripted({
      "https://docs.example.org/page": { status: 302, location: "https://cdn.example.org/page.html" },
      "https://cdn.example.org/page.html": { status: 200, body: "the real page" },
    });
    const result = await createResearchFetcher(impl)({ url: "https://docs.example.org/page" });
    expect(result.body).toBe("the real page");
    expect(result.status).toBe(200);
    expect(result.url).toBe("https://cdn.example.org/page.html");
    expect(asked).toEqual(["https://docs.example.org/page", "https://cdn.example.org/page.html"]);
  });

  it("gives up on a redirect chain rather than following it forever", async () => {
    const script: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i <= RESEARCH_FETCH_MAX_REDIRECTS + 2; i++) {
      script[`https://example.org/${String(i)}`] = { status: 302, location: `https://example.org/${String(i + 1)}` };
    }
    const { impl, asked } = scripted(script);
    const refused = await refusal(() => createResearchFetcher(impl)({ url: "https://example.org/0" }));
    expect(refused.code).toBe("too_many_redirects");
    expect(asked.length).toBeLessThanOrEqual(RESEARCH_FETCH_MAX_REDIRECTS + 1);
  });

  it("refuses a redirect that names no address at all", async () => {
    const { impl } = scripted({ "https://docs.example.org/page": { status: 302 } });
    const refused = await refusal(() => createResearchFetcher(impl)({ url: "https://docs.example.org/page" }));
    expect(refused.code).toBe("bad_url");
  });
});

describe("repository remotes", () => {
  it("refuses a repository on this machine or its private network", () => {
    for (const value of [
      "https://127.0.0.1/acme/widgets",
      "http://localhost:3000/acme/widgets",
      "https://10.0.0.5/acme/widgets",
      "https://192.168.1.10/acme/widgets",
      "git@localhost:acme/widgets.git",
    ]) {
      expect(() => resolveRepositoryInput(value)).toThrow(ResearchRefused);
      try {
        resolveRepositoryInput(value);
      } catch (failure) {
        expect((failure as ResearchRefused).code).toBe("private_address");
      }
    }
  });

  it("still resolves the public forms the contract documents", () => {
    expect(resolveRepositoryInput("facebook/react").url).toBe("https://github.com/facebook/react.git");
    expect(resolveRepositoryInput("git@gitlab.com:group/thing.git").url).toBe("https://gitlab.com/group/thing.git");
    expect(resolveRepositoryInput("https://github.com/acme/widgets").host).toBe("github.com");
  });
});
