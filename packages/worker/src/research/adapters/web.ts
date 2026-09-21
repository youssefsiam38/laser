/**
 * The `web` adapter: search through the person's own provider, and one page
 * at a time as readable text.
 *
 * | | |
 * | --- | --- |
 * | Reach | network |
 * | Auth | the search provider the person already connected; pages are fetched signed-out |
 * | Rate | 20 requests a minute, a second apart, robots and terms honoured |
 * | Search result | hits with a normalised URL, title, snippet and the date the source declares |
 * | Read result | HTML-stripped readable text with canonical URL, title, published date and a digest |
 *
 * It adds no search engine of its own: `search` is the existing
 * `WebSearchService`, which already runs in its own thread with a scrubbed
 * environment, so no credential path is duplicated here. `read` is a bounded
 * fetch and the shared extractor — no browser, no script, nothing executed.
 */
import { researchAdapter, researchHostAllowed, type SourceRef } from "@lasercode/protocol";
import { ResearchRefused } from "../errors.js";
import { digestOf } from "../cache.js";
import { readableText } from "../readable-text.js";
import { checkFetchTarget, RESEARCH_FETCH_MAX_BYTES } from "./fetch.js";
import { serveSource } from "./serve.js";
import { licenceClass, normaliseUrl, trustForHost, type ResearchAdapter, type ResearchAdapterContext, type ResearchHit, type ResearchReadInput, type ResearchReadResult, type ResearchSearchInput, type ResearchSearchResult } from "./types.js";

const READABLE_TYPES = /^(?:text\/(?:html|plain|markdown|x-markdown|csv)|application\/(?:xhtml\+xml|json|ld\+json|xml|rss\+xml|atom\+xml)|text\/xml)\b/i;

/** What a provider answer can look like, whichever provider it came from. */
interface ProviderHit {
  url?: unknown;
  link?: unknown;
  href?: unknown;
  title?: unknown;
  name?: unknown;
  snippet?: unknown;
  description?: unknown;
  content?: unknown;
  text?: unknown;
  date?: unknown;
  publishedDate?: unknown;
  published_date?: unknown;
  datePublished?: unknown;
  score?: unknown;
}

function stringOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** A provider's answer to hits. Tolerant: a provider that changes shape is not a crash. */
export function parseProviderAnswer(answer: string): { hits: Array<{ url: string; title?: string; snippet?: string; date?: string; score?: number }>; note?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    // Not JSON: take the addresses out of the prose, so a provider that
    // answers in text still gives the model something to read.
    const urls = [...new Set([...answer.matchAll(/https?:\/\/[^\s<>")\]]+/g)].map((match) => match[0]))];
    return {
      hits: urls.map((url) => ({ url })),
      ...(urls.length === 0 ? { note: "Your search provider answered with text and no links." } : {}),
    };
  }
  const root = parsed as { results?: unknown; data?: unknown; items?: unknown; answer?: unknown };
  const list = [root.results, root.data, root.items].find((candidate) => Array.isArray(candidate)) as ProviderHit[] | undefined;
  if (!list) {
    const text = stringOf(root.answer);
    const urls = text ? [...new Set([...text.matchAll(/https?:\/\/[^\s<>")\]]+/g)].map((match) => match[0]))] : [];
    return { hits: urls.map((url) => ({ url })), ...(urls.length === 0 ? { note: "Your search provider returned no sources for that query." } : {}) };
  }
  const hits: Array<{ url: string; title?: string; snippet?: string; date?: string; score?: number }> = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const url = stringOf(entry.url, entry.link, entry.href);
    if (!url) continue;
    const title = stringOf(entry.title, entry.name);
    const snippet = stringOf(entry.snippet, entry.description, entry.content, entry.text);
    const date = stringOf(entry.date, entry.publishedDate, entry.published_date, entry.datePublished);
    hits.push({
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(typeof entry.score === "number" ? { score: entry.score } : {}),
    });
  }
  return { hits };
}

function webSourceRef(url: string, title?: string): SourceRef {
  const normalised = normaliseUrl(url);
  return {
    kind: "web",
    id: normalised,
    title: (title ?? new URL(normalised).host).slice(0, 500),
    fetchedVia: "web",
    trust: trustForHost(new URL(normalised).host),
  };
}

export const webResearchAdapter: ResearchAdapter = {
  id: "web",
  descriptor: researchAdapter("web"),

  async search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult> {
    const search = context.webSearch;
    if (!search) {
      throw new ResearchRefused(
        "search_unconnected",
        "No web search provider is connected, so the web cannot be searched from here. The other research sources still work.",
        "search another adapter, or tell the person to connect a search provider in Settings before searching the web",
      );
    }
    const window = input.after ?? input.before ? `${input.after ?? ""}..${input.before ?? ""}` : undefined;
    context.ledger.chargeSearch("web", input.query, window);
    const recency = recencyFor(input.after, context.now?.() ?? Date.now());
    let answer: string;
    try {
      answer = await search(input.query, context.signal, {
        numResults: input.limit,
        ...(recency !== undefined ? { recencyFilter: recency } : {}),
        ...(context.sources.allowDomains.length > 0 ? { domainFilter: context.sources.allowDomains.slice(0, 20) } : {}),
      });
    } catch (failure) {
      throw new ResearchRefused(
        "search_failed",
        failure instanceof Error ? failure.message : "The search provider did not answer.",
        "try the search again with different terms, or use another adapter for this question",
      );
    }
    const parsed = parseProviderAnswer(answer);
    const notes: string[] = parsed.note ? [parsed.note] : [];
    const hits: ResearchHit[] = [];
    let denied = 0;
    for (const hit of parsed.hits) {
      let ref: SourceRef;
      try {
        ref = webSourceRef(hit.url, hit.title);
      } catch {
        continue;
      }
      const host = new URL(ref.id).host;
      const allowed = researchHostAllowed(context.sources, host);
      if (!allowed.allowed) {
        denied += 1;
        continue;
      }
      hits.push({
        sourceRef: ref,
        title: ref.title,
        snippet: (hit.snippet ?? "").slice(0, 600),
        ...(hit.date !== undefined ? { date: hit.date } : {}),
        ...(hit.score !== undefined ? { score: hit.score } : {}),
      });
      if (hits.length >= input.limit) break;
    }
    if (denied > 0) notes.push(`${String(denied)} result${denied === 1 ? " was" : "s were"} left out because this project does not allow research to reach them.`);
    return { hits, ...(notes.length > 0 ? { notes } : {}) };
  },

  async read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult> {
    const url = checkFetchTarget(input.ref.id);
    const allowed = researchHostAllowed(context.sources, url.host);
    if (!allowed.allowed) {
      throw new ResearchRefused(
        "host_not_allowed",
        allowed.reason ?? `${url.host} is not a host this project allows research to reach.`,
        "read one of the other hits, or ask the person to add that host to this project's research sources",
      );
    }
    // Trust is a property of the host, not of how the model happened to name
    // the source: a page read by URL is classified the same way a search hit
    // is, or the confidence rule would depend on the route in.
    const source: SourceRef = { ...webSourceRef(input.ref.id, input.ref.title !== "" ? input.ref.title : undefined) };
    return serveSource({
      context,
      source,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      load: async () => {
        const response = await context.fetch({ url: source.id, maxBytes: RESEARCH_FETCH_MAX_BYTES }, context.signal);
        if (response.status >= 400) {
          throw new ResearchRefused(
            response.status === 404 ? "source_not_found" : "source_refused",
            `${url.host} answered ${String(response.status)} for that page, so there is nothing to read.`,
            response.status === 404 ? "read another of the hits, or search again for a page that still exists" : "read another source for this question",
          );
        }
        const type = response.contentType ?? "";
        if (type !== "" && !READABLE_TYPES.test(type)) {
          throw new ResearchRefused(
            "unsupported_content",
            `That address serves ${type.split(";")[0]}, which research does not read. It reads web pages, plain text, Markdown and JSON.`,
            "find an HTML or text version of the same source, or attach the file and read it with the document adapter",
          );
        }
        const extracted = readableText(response.body, { url: response.url, maxBytes: RESEARCH_FETCH_MAX_BYTES });
        if (extracted.text.trim() === "") {
          throw new ResearchRefused(
            "no_readable_text",
            `${url.host} returned a page with no readable text — it is built by script, or it is an image.`,
            "read another of the hits, or search for the same content in a text form",
          );
        }
        const canonical = extracted.canonical ? normaliseUrl(extracted.canonical) : normaliseUrl(response.url);
        return {
          text: extracted.text,
          digest: digestOf(response.body),
          bytes: response.bytes,
          canonical,
          ...(extracted.title !== undefined ? { title: extracted.title } : {}),
          ...(extracted.publishedAt !== undefined ? { publishedAt: extracted.publishedAt } : {}),
          licence: licenceClass(undefined),
          contentType: type,
          notices: [
            ...(extracted.truncated ? ["This page was longer than one research read may take; what follows is its beginning."] : []),
            ...(canonical !== source.id ? [`The page declares its canonical address as ${canonical}; cite that.`] : []),
          ],
        };
      },
    });
  },
};

/** Date bounds only when the question is time-sensitive, as the loop says. */
function recencyFor(after: string | undefined, now: number): "day" | "week" | "month" | "year" | undefined {
  if (!after) return undefined;
  const from = Date.parse(after);
  if (!Number.isFinite(from)) return undefined;
  const days = (now - from) / 86_400_000;
  if (days <= 1.5) return "day";
  if (days <= 8) return "week";
  if (days <= 32) return "month";
  if (days <= 370) return "year";
  return undefined;
}
