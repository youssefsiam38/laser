/**
 * What every research adapter is, and the small vocabulary they share
 * (`docs/research-phase.md`, "Sources and adapters").
 *
 * An adapter does one job for one kind of source and declares, in its
 * descriptor, what it reaches, what it needs to authenticate, how often it
 * may be called and what a search and a read return. Everything an adapter
 * needs from the outside world arrives in the context — the fetcher, the git
 * runner, the person's search provider, the cache, the budget — so an
 * adapter can be evaluated against recorded responses without a network.
 */
import type {
  RepositoryStateRef,
  ResearchAdapterDescriptor,
  ResearchAdapterId,
  ResearchSources,
  SourceLicence,
  SourceRef,
  SourceTrust,
} from "@lasercode/protocol";
import type { ProcessRunner } from "../../git-actions/index.js";
import type { ResearchLedger } from "../budget.js";
import type { ResearchCache } from "../cache.js";

// ------------------------------------------------------------------ fetching

export interface ResearchFetchRequest {
  url: string;
  headers?: Record<string, string>;
  /** Hard ceiling on the bytes read from the response. */
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ResearchFetchResult {
  /** The URL the body really came from, after redirects. */
  url: string;
  status: number;
  contentType?: string;
  /** The body, decoded as UTF-8 and cut at `maxBytes`. */
  body: string;
  bytes: number;
  truncated: boolean;
  headers: Record<string, string>;
}

/** The one network seam. Tests pass a recorded implementation. */
export type ResearchFetcher = (request: ResearchFetchRequest, signal?: AbortSignal) => Promise<ResearchFetchResult>;

/** The person's configured web-search provider, as the worker already exposes it. */
export type ResearchWebSearch = (
  query: string,
  signal?: AbortSignal,
  options?: { numResults?: number; recencyFilter?: "day" | "week" | "month" | "year"; domainFilter?: string[] },
) => Promise<string>;

// ------------------------------------------------------------------- results

export interface ResearchHit {
  sourceRef: SourceRef;
  title: string;
  /** A short passage, from the provider or the file. Never the whole body. */
  snippet: string;
  /** What the source declares about its date, when it declares one. */
  date?: string;
  score?: number;
}

export interface ResearchSearchResult {
  hits: ResearchHit[];
  /** How to ask for the next page, when the adapter pages. */
  nextCursor?: string;
  /** How many hits were left out of this page. */
  omitted?: number;
  /** What the adapter could not do, in a person's words. Never an exception. */
  notes?: string[];
}

export interface ResearchReadResult {
  /** The page of readable text, with its provenance line already on it. */
  text: string;
  totalBytes: number;
  nextOffset?: number;
  /** sha256 of the bytes this text came from. */
  digest: string;
  /** The identity a finding cites: a URL, a repo at a commit, a coordinate. */
  canonical: string;
  title?: string;
  licence?: SourceLicence;
  publishedAt?: string;
  /** Injection notices and anything else the reader must know, as data. */
  notices: string[];
  /** The exact repository state, when the source is a repository. */
  repositoryState?: RepositoryStateRef;
  /** The source as it should be cited, with its digest filled in. */
  source: SourceRef;
  /**
   * The cache entry this body lives under. The source's own id, unless the
   * adapter reads one source as several bodies (a repository read file by
   * file), in which case each body has its own key and its own digest.
   */
  bodyKey: string;
  /** True when this call was served from the research cache. */
  cached: boolean;
}

export interface ResearchSearchInput {
  query: string;
  limit: number;
  /** Date bounds, only for a time-sensitive question. */
  after?: string;
  before?: string;
  cursor?: string;
}

export interface ResearchReadInput {
  ref: SourceRef;
  offset?: number;
  limit?: number;
  /** Repository-relative paths, for the `repository` adapter. */
  paths?: string[];
}

// ------------------------------------------------------------------- context

export interface ResearchAdapterContext {
  projectCwd: string;
  /** Laser's own state directory, for the repository mirror. */
  stateDir?: string;
  /** Stable key for this project inside the state directory. */
  projectKey?: string;
  /** Where this session's attachments live, for the `document` adapter. */
  attachmentsDir?: string;
  sources: ResearchSources;
  ledger: ResearchLedger;
  cache: ResearchCache;
  fetch: ResearchFetcher;
  /** git and friends, through git-actions' own runner. Argv, never a shell. */
  run?: ProcessRunner;
  webSearch?: ResearchWebSearch;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ResearchAdapter {
  descriptor: ResearchAdapterDescriptor;
  id: ResearchAdapterId;
  search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult>;
  read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult>;
}

// ------------------------------------------------------------------- helpers

/**
 * How much a host is trusted, by what kind of host it is.
 *
 * Deliberately conservative: `official` is a standards body publishing its own
 * standard, `primary` is a project's own documentation, and everything a
 * person writes about someone else's software is `community` or `unknown`.
 * The confidence rule then does the rest — a `community` source can never
 * produce a `declared` finding.
 */
const STANDARDS = ["w3.org", "whatwg.org", "ietf.org", "rfc-editor.org", "unicode.org", "ecma-international.org", "iso.org", "iana.org", "khronos.org", "oasis-open.org"];
const COMMUNITY = ["stackoverflow.com", "stackexchange.com", "reddit.com", "medium.com", "dev.to", "hashnode.com", "hashnode.dev", "quora.com", "substack.com", "blogspot.com", "wordpress.com", "news.ycombinator.com", "x.com", "twitter.com", "youtube.com"];
const SECONDARY = ["wikipedia.org", "developer.mozilla.org", "caniuse.com"];

export function trustForHost(host: string): SourceTrust {
  const name = host.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (name === "") return "unknown";
  const under = (list: readonly string[]): boolean => list.some((entry) => name === entry || name.endsWith(`.${entry}`));
  if (under(STANDARDS)) return "official";
  if (under(COMMUNITY)) return "community";
  if (under(SECONDARY)) return "secondary";
  if (/^(?:docs?|developer|developers|api|spec|specs|standards)\./.test(name) || name.endsWith(".readthedocs.io")) return "primary";
  return "unknown";
}

/** SPDX-ish text to the licence class a finding carries. */
const PERMISSIVE = /\b(?:mit|isc|bsd(?:-[0-9]-clause)?|apache(?:[ -]2(?:\.0)?)?|unlicense|0bsd|zlib|python-2\.0|psf|boost|bsl-1\.0|cc0|wtfpl)\b/i;
const COPYLEFT = /\b(?:a?gpl(?:-[0-9](?:\.[0-9])?)?(?:[ -]only|[ -]or-later)?|lgpl[^ ]*|mpl(?:[ -]2(?:\.0)?)?|epl[^ ]*|cddl|osl|eupl|sspl|cc-by-sa)\b/i;
const PROPRIETARY = /\b(?:proprietary|all rights reserved|commercial|see licen[cs]e|unlicensed)\b/i;

export function licenceClass(declared: string | undefined | null): SourceLicence {
  const value = (declared ?? "").trim();
  if (value === "") return "unknown";
  if (PROPRIETARY.test(value)) return "proprietary";
  if (COPYLEFT.test(value)) return "copyleft";
  if (PERMISSIVE.test(value)) return "permissive";
  return "unknown";
}

/**
 * A URL as a source identity: scheme and host lower-cased, the default port,
 * the fragment and the usual tracking parameters dropped, the path kept.
 */
export function normaliseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const drop = [...url.searchParams.keys()].filter((key) => /^(?:utm_|fbclid$|gclid$|mc_[ce]id$|ref$|ref_src$|igshid$)/i.test(key));
  for (const key of drop) url.searchParams.delete(key);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** A page of text out of a whole body, on a UTF-8 boundary. */
export function pageOf(text: string, offset: number, limit: number): { text: string; totalBytes: number; nextOffset?: number } {
  const encoded = Buffer.from(text, "utf8");
  const totalBytes = encoded.byteLength;
  const start = Math.min(Math.max(0, offset), totalBytes);
  let end = Math.min(start + limit, totalBytes);
  // Do not split a character across two pages.
  while (end > start && end < totalBytes && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  const page = encoded.subarray(start, end).toString("utf8");
  return { text: page, totalBytes, ...(end < totalBytes ? { nextOffset: end } : {}) };
}

export type { ResearchAdapterDescriptor, ResearchAdapterId, ResearchSources };
