/**
 * HTML to readable text, and the injection notice that travels with it
 * (`docs/research-phase.md`, "Security, privacy and cost"; D-351.d).
 *
 * Three rules decide everything here:
 *
 * 1. **Scripts, styles and forms are discarded.** They are not prose, they are
 *    behaviour, and a research finding never quotes behaviour.
 * 2. **Text that reads like an instruction is kept.** Deleting it would hide
 *    what a page is doing; what is returned instead is the passage *plus* a
 *    notice naming the pattern and the line it sits on. The model is told, in
 *    the provenance line, that everything below it is evidence about a source,
 *    not a message from the person.
 * 3. **Nothing executes.** No DOM, no parser that runs anything, no network:
 *    this is a string transformation, and the only thing it can do is return
 *    a shorter string.
 */

/** One passage that reads like an instruction to a model. Returned as data. */
export interface InjectionNotice {
  /** The rule that matched, in the words a person reads. */
  pattern: string;
  /** 1-based line of the extracted text. */
  line: number;
  /** The line itself, bounded. Escaped by whoever renders it. */
  text: string;
}

export interface ExtractedText {
  text: string;
  title?: string;
  canonical?: string;
  /** The date the source declares it was published. Never inferred. */
  publishedAt?: string;
  /** Instruction-shaped passages kept in the text and named here. */
  injection: InjectionNotice[];
  /** True when the body was longer than the ceiling and was cut. */
  truncated: boolean;
  /** Bytes of readable text after extraction. */
  bytes: number;
}

const INJECTION_PATTERNS: ReadonlyArray<{ name: string; test: RegExp }> = [
  { name: "tells a model to ignore its instructions", test: /\b(?:ignore|forget|disregard)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(?:instruction|prompt|message|rule)s?\b/i },
  { name: "tries to replace the system prompt", test: /\b(?:system prompt|developer message|new instructions?\s*:)/i },
  { name: "tells a model who it now is", test: /\byou are (?:now|actually|really)\b[^.\n]{0,60}/i },
  { name: "asks for a command to be run", test: /\b(?:run|execute|eval)\b[^.\n]{0,30}\b(?:the following|this)\b[^.\n]{0,20}\b(?:command|code|script|shell)\b/i },
  { name: "pipes a download into a shell", test: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i },
  { name: "asks for credentials or data to be sent somewhere", test: /\b(?:exfiltrat\w+|send|post|upload)\b[^.\n]{0,40}(?:api[-_ ]?keys?|secrets?|tokens?|credentials?|passwords?|\.env)\b/i },
  { name: "asks a model to hide something from the person", test: /\b(?:do not|don't|never)\b[^.\n]{0,20}\b(?:tell|show|mention|inform)\b[^.\n]{0,20}\b(?:the )?(?:user|person|human|owner)\b/i },
  { name: "uses a chat control token", test: /<\|(?:im_start|im_end|system|endoftext)\|>/i },
  { name: "addresses the agent directly with an order", test: /\b(?:assistant|ai agent|language model|chatbot)\b\s*[,:][^.\n]{0,20}\b(?:you must|please run|please send|immediately)\b/i },
];

/** Elements whose *content* is not prose. Dropped whole. */
const DISCARDED = ["script", "style", "noscript", "template", "form", "svg", "canvas", "iframe", "object", "embed", "head"];

const BLOCK = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|pre|figure|figcaption|hr|br)\b[^>]*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const CELL = /<\/(?:td|th)>/gi;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  times: "×",
  deg: "°",
  euro: "€",
  pound: "£",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s">]+))`, "i").exec(tag);
  if (!match) return undefined;
  const value = match[2] ?? match[3] ?? match[4];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function metaContent(html: string, matcher: RegExp): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "property") ?? attribute(tag, "name") ?? attribute(tag, "itemprop");
    if (key !== undefined && matcher.test(key)) {
      const content = attribute(tag, "content");
      if (content !== undefined && content !== "") return content;
    }
  }
  return undefined;
}

function canonicalOf(html: string, url?: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(match[0], "rel");
    if (rel?.toLowerCase() === "canonical") {
      const href = attribute(match[0], "href");
      if (href) {
        try {
          return new URL(href, url).toString();
        } catch {
          return href;
        }
      }
    }
  }
  return url;
}

function publishedOf(html: string): string | undefined {
  const meta = metaContent(html, /^(?:article:published_time|datePublished|date|pubdate|publish[-_]?date|dc\.date(?:\.issued)?)$/i);
  if (meta) return meta;
  const time = /<time\b[^>]*\bdatetime\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
  const value = time?.[2] ?? time?.[3];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** Cut on a UTF-8 boundary, never mid-character. */
function boundBytes(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return { text, truncated: false, bytes: encoded.byteLength };
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  const cut = encoded.subarray(0, end).toString("utf8");
  return { text: cut, truncated: true, bytes: Buffer.byteLength(cut, "utf8") };
}

/** The line every returned passage of foreign text carries (tool contract §2). */
export function provenanceLine(canonical: string, extra?: string): string {
  return `[from ${canonical}]${extra ? ` ${extra}` : ""}`;
}

/** Instruction-shaped passages in text that already is text. */
export function injectionNotices(text: string): InjectionNotice[] {
  const notices: InjectionNotice[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const { name, test } of INJECTION_PATTERNS) {
      if (!test.test(line)) continue;
      notices.push({ pattern: name, line: index + 1, text: line.trim().slice(0, 200) });
      break;
    }
    if (notices.length >= 20) break;
  }
  return notices;
}

export interface ReadableTextOptions {
  /** The URL it was fetched from, for resolving a relative canonical link. */
  url?: string;
  /** How much readable text to keep. */
  maxBytes?: number;
}

/**
 * HTML (or plain text, which passes through) to readable text with its
 * declared title, canonical URL and publication date.
 */
export function readableText(source: string, options: ReadableTextOptions = {}): ExtractedText {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const looksLikeHtml = /<\s*(?:html|body|head|div|p|article|main|section|span|a|h1)\b/i.test(source) || /<\/\s*[a-z]+\s*>/i.test(source);
  if (!looksLikeHtml) {
    const plain = boundBytes(source.replace(/\r\n?/g, "\n").trim(), maxBytes);
    return {
      text: plain.text,
      injection: injectionNotices(plain.text),
      truncated: plain.truncated,
      bytes: plain.bytes,
      ...(options.url !== undefined ? { canonical: options.url } : {}),
    };
  }

  const html = source.replace(/\r\n?/g, "\n");
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html;
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = decodeEntities(titleTag ?? metaContent(head, /^og:title$/i) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const canonical = canonicalOf(head, options.url);
  const publishedAt = publishedOf(head);

  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of DISCARDED) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    // An unclosed discarded element takes the rest of the document with it:
    // an unterminated <script> is not prose however the page ends.
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  }
  body = body
    .replace(/<(?:input|button|select|textarea|option)\b[^>]*>/gi, " ")
    .replace(LIST_ITEM, "\n- ")
    .replace(CELL, "\t")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const bounded = boundBytes(text, maxBytes);
  return {
    text: bounded.text,
    ...(title !== "" ? { title } : {}),
    ...(canonical !== undefined ? { canonical } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    injection: injectionNotices(bounded.text),
    truncated: bounded.truncated,
    bytes: bounded.bytes,
  };
}
