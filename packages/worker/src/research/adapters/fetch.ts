/**
 * The bounded fetch every network adapter goes through.
 *
 * Rules, all from `docs/research-phase.md` "Security, privacy and cost":
 *
 * - **http(s) only, never authenticated.** No cookies, no credentials in the
 *   URL, no `Authorization` header this module would add, and nothing is kept
 *   from a response that needed one.
 * - **Bounded before it is read.** The body is read from the stream and cut
 *   at the ceiling, so a source that never ends costs one page, not a
 *   process. A declared `content-length` over the ceiling is refused without
 *   reading anything.
 * - **No private network, on every hop.** A literal loopback, link-local or
 *   RFC1918 address is refused outright, and redirects are followed **by this
 *   module** so that the same check runs against every address a read really
 *   reaches: a public page that answers `302 Location: http://127.0.0.1/…`
 *   would otherwise walk straight through the floor (M21-T22, threat model
 *   §4). This is still a floor, not a full SSRF defence: name resolution
 *   belongs to the platform, and the worker never proxies a fetch for the
 *   model to an address it chose.
 * - **No execution, ever.** What comes back is text, handed to the extractor.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { ResearchRefused } from "../errors.js";
import type { ResearchFetchRequest, ResearchFetchResult, ResearchFetcher } from "./types.js";

export const RESEARCH_FETCH_TIMEOUT_MS = 20_000;
export const RESEARCH_FETCH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many redirects one read follows before it gives up.
 *
 * Redirects are followed here rather than by the platform, because the
 * platform would not apply {@link checkFetchTarget} to each hop. A chain
 * longer than this is a loop or a crawl, and neither is a source.
 */
export const RESEARCH_FETCH_MAX_REDIRECTS = 5;

/** Sent on every research request, so an operator can see who called. */
export const RESEARCH_USER_AGENT = `${PRODUCT_DISPLAY_NAME.replace(/\s+/g, "")}-Research/1.0 (+documented research adapter; one request at a time)`;

const PRIVATE_V4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/;

/**
 * Is this host name one research must never reach?
 *
 * Shared with the repository adapter, which hands a host to **git** rather
 * than to `fetch` and needs the same answer (M21-T22, threat model §4).
 */
export function isPrivateResearchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    PRIVATE_V4.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host)
  );
}

/** The refusal a private address gets, wherever it was going to be reached. */
export function refusePrivateHost(hostname: string): ResearchRefused {
  return new ResearchRefused(
    "private_address",
    `${hostname} is on this machine or its private network, and research only reads sources a person could open from the public internet.`,
    "give the public address of the source, or attach the file and read it with the document adapter",
  );
}

/** Refuses an address research must not reach. The sentence is the person's. */
export function checkFetchTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ResearchRefused("bad_url", `"${value.slice(0, 200)}" is not a complete web address.`, "call read_source again with a full https:// address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ResearchRefused(
      "unsupported_scheme",
      `Research reads web pages over http and https only, and that address is ${url.protocol.replace(":", "")}.`,
      "use the https address of the page, or read a local file with the document adapter",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ResearchRefused(
      "credentials_in_url",
      "That address carries a user name and password. Research never signs in to a site, so it will not fetch it.",
      "use the public address of the page, without credentials",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateResearchHost(host)) throw refusePrivateHost(host);
  return url;
}

/** The status codes that mean "the source is somewhere else". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Where this answer says the source really is, checked, or `undefined` when
 * the answer is the source itself.
 *
 * Only the five statuses that name a location are followed: a `300` or a `304`
 * is an answer about this address, not a move to another one.
 */
function redirectTarget(response: Response, from: URL): URL | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined;
  const location = response.headers.get("location");
  if (location === null || location.trim() === "") {
    throw new ResearchRefused(
      "bad_url",
      `${from.host} answered with a redirect that names no address, so there is nothing to read.`,
      "read another source for the same question",
    );
  }
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new ResearchRefused(
      "bad_url",
      `${from.host} redirected to "${location.slice(0, 200)}", which is not an address this can read.`,
      "read another source for the same question",
    );
  }
  // The same floor as the first address, because this is an address the read
  // really reaches (M21-T22).
  return checkFetchTarget(next.toString());
}

/** The real fetcher. Everything above is enforced here, once. */
export function createResearchFetcher(impl: typeof fetch = fetch): ResearchFetcher {
  return async (request: ResearchFetchRequest, signal?: AbortSignal): Promise<ResearchFetchResult> => {
    let url = checkFetchTarget(request.url);
    const maxBytes = request.maxBytes ?? RESEARCH_FETCH_MAX_BYTES;
    const timeout = AbortSignal.timeout(request.timeoutMs ?? RESEARCH_FETCH_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    for (let hop = 0; ; hop++) {
      try {
        response = await impl(url, {
          method: "GET",
          // Followed here, one hop at a time, so the floor above runs against
          // every address; `follow` would hand that decision to the platform.
          redirect: "manual",
          signal: abort,
          headers: {
            "user-agent": RESEARCH_USER_AGENT,
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            "accept-language": "en",
            ...request.headers,
          },
        });
      } catch (failure) {
        const reason = failure instanceof Error && failure.name === "TimeoutError" ? "did not answer in time" : "could not be reached";
        throw new ResearchRefused(
          "source_unreachable",
          `${url.host} ${reason}. Nothing was read from it.`,
          "try another source for the same question, or read one of the hits you already have",
        );
      }
      const next = redirectTarget(response, url);
      if (!next) break;
      if (hop >= RESEARCH_FETCH_MAX_REDIRECTS) {
        throw new ResearchRefused(
          "too_many_redirects",
          `${url.host} kept redirecting, so nothing was read from it.`,
          "read the address the source finally lives at, or another source for the same question",
        );
      }
      await response.body?.cancel().catch(() => {});
      url = next;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const declared = Number.parseInt(headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes * 8) {
      throw new ResearchRefused(
        "source_too_large",
        `That source is ${(declared / (1024 * 1024)).toFixed(1)} MB, far more than one research read may take.`,
        "read a specific page of the source instead of the whole file",
      );
    }

    const { text, bytes, truncated } = await readBounded(response, maxBytes);
    return {
      url: response.url === "" ? url.toString() : response.url,
      status: response.status,
      ...(headers["content-type"] !== undefined ? { contentType: headers["content-type"] } : {}),
      body: text,
      bytes,
      truncated,
      headers,
    };
  };
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const whole = await response.text();
    const buffer = Buffer.from(whole, "utf8");
    const cut = buffer.subarray(0, maxBytes);
    return { text: cut.toString("utf8"), bytes: cut.byteLength, truncated: buffer.byteLength > maxBytes };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), bytes: buffer.byteLength, truncated };
}
