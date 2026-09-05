/**
 * What part of a file is a *value* (MX-T7).
 *
 * The identity check is about values, not about prose or identifiers:
 *
 *   - A comment that still says the old name after a rename is a documentation
 *     chore. Nothing on a person's machine is wrong because of it.
 *   - An identifier — `PiorbitPaths`, `piorbitDataDir` — is a symbol inside a
 *     private workspace. Renaming it is a mechanical sweep with no user
 *     visible effect, the same as the npm scope.
 *   - A **string literal** is different. It is the app id, the scheme, the
 *     directory, the storage key, or a sentence a person reads. Those must all
 *     derive from product.json, and those are what this returns.
 *
 * Lines are preserved so reported line numbers still point at the source.
 */

/**
 * Keep only what is inside string and template literals; blank everything else.
 *
 * Deliberately simple: it does not try to tell a regular expression from a
 * division, because the only cost of getting that wrong is scanning a few extra
 * characters, and the scan's answer is a substring search.
 */
function partition(text) {
  let out = "";
  let code = "";
  let state = "code"; // code | line | block | single | double | template | regex
  let i = 0;
  let previous = ""; // last non-space character of code, to tell `/` apart
  let inCharClass = false;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  // A `/` starts a regular expression only where a value may start. Without
  // this, `/'([^']+)'/` reads as two apostrophes and every quote after it in
  // the file is inverted — which is how a comment ends up reported as a string.
  const REGEX_MAY_START = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "~", "%", "<", ">", "^"]);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        code += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        code += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && REGEX_MAY_START.has(previous)) {
        state = "regex";
        inCharClass = false;
        out += blank(ch);
        code += blank(ch);
        i += 1;
        continue;
      }
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "`") state = "template";
      if (ch.trim() !== "") previous = ch;
      out += blank(ch);
      code += ch;
      i += 1;
      continue;
    }
    if (state === "regex") {
      if (ch === "\\") {
        out += "  ";
        code += "  ";
        i += 2;
        continue;
      }
      if (ch === "[") inCharClass = true;
      else if (ch === "]") inCharClass = false;
      else if (ch === "/" && !inCharClass) {
        state = "code";
        previous = "/";
      } else if (ch === "\n") {
        // Not a regular expression after all (a comment, or division).
        state = "code";
      }
      out += blank(ch);
      code += blank(ch);
      i += 1;
      continue;
    }
    if (state === "line" || state === "block") {
      if (state === "line" && ch === "\n") state = "code";
      if (state === "block" && ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        code += "  ";
        i += 2;
        continue;
      }
      out += blank(ch);
      code += blank(ch);
      i += 1;
      continue;
    }
    // inside a literal: this is the part that matters
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      code += "  ";
      i += 2;
      continue;
    }
    if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) {
      state = "code";
      out += blank(ch);
      code += blank(ch);
      i += 1;
      continue;
    }
    out += ch;
    code += blank(ch);
    i += 1;
  }
  return { literals: out, code };
}

/** What the identity check reads out of a `.ts` file: its string literals. */
function stringLiteralsOnly(text) {
  return partition(text).literals;
}

/**
 * A `.tsx` file's values are its string literals **and its JSX text**.
 *
 * JSX children are not quoted, so a literal-only scan blanks every sentence the
 * app actually shows — the first-run flow, the sign-in sheet, the trust dialog,
 * the update banner. Those are precisely "a sentence a person reads", and a
 * rename that leaves them behind ships a product that calls itself two things
 * on its own first screen.
 *
 * The extractor is deliberately coarse. From `partition`'s *code* half (so
 * comments and literal bodies are already blank), a run of text opens at a `>`
 * that is not part of an operator (`=>`, `>=`, `-->`) and closes at the next
 * `<`. A `{` or `(` suspends the run and the matching `}` or `)` resumes it, so
 * `Keys {name} does not recognise` and `the agent ({version}) does not` are
 * both read whole rather than truncated at the first brace.
 *
 * In ordinary code the run is simply never open, because nothing opened it.
 * Anything it does let through that is not text is an identifier, and the check
 * exempts those anyway.
 */
function stringLiteralsAndJsxText(text) {
  const { literals, code } = partition(text);
  const OPENED_BY_OPERATOR = new Set(["=", "<", ">", "-", "+", "|", "&", "!"]);
  const out = [];
  const suspended = [];
  let keeping = false;
  let previous = "";
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "\n") {
      out.push("\n");
      continue;
    }
    let kept = literals[i];
    if (kept === " ") {
      if (ch === ">") {
        keeping = !OPENED_BY_OPERATOR.has(previous);
      } else if (ch === "<" || ch === ";") {
        keeping = false;
      } else if (ch === "{" || ch === "(") {
        suspended.push(keeping);
        keeping = false;
      } else if (ch === "}" || ch === ")") {
        keeping = suspended.pop() ?? false;
      } else if (keeping) {
        kept = ch;
      }
    }
    out.push(kept);
    if (ch.trim() !== "") previous = ch;
  }
  return out.join("");
}

/** `#` comments removed; everything else in a shell or YAML file is a value. */
function withoutHashComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const at = line.search(/(^|\s)#/);
      if (at === -1) return line;
      const cut = line[at] === "#" ? at : at + 1;
      const before = line.slice(0, cut);
      // A `#` inside a quoted string is not a comment.
      if ((before.match(/'/g) ?? []).length % 2 !== 0) return line;
      if ((before.match(/"/g) ?? []).length % 2 !== 0) return line;
      return before;
    })
    .join("\n");
}

/** `<!-- … -->` removed; everything else in markup is content. */
/** `/* … *\/` removed; a stylesheet has no other comment syntax. */
function withoutCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

function withoutXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
}

export function scannable(file, text) {
  if (/\.(tsx|jsx)$/.test(file)) return stringLiteralsAndJsxText(text);
  if (/\.(ts|js|mjs|cjs|cts|mts)$/.test(file)) return stringLiteralsOnly(text);
  if (/\.(sh|tpl|ya?ml|desktop|toml|conf)$/.test(file) || !/\.[a-z]+$/i.test(file)) return withoutHashComments(text);
  // JSON has no comments, so every value — and every key — is a quoted string.
  // Reusing the literal tokenizer means a `description`, a `bin` name or a
  // `$comment` is scanned, and the punctuation between them is not.
  if (/\.json$/.test(file)) return stringLiteralsOnly(text);
  if (/\.css$/.test(file)) return withoutCssComments(text);
  if (/\.(html|xml|svg|plist|webmanifest)$/.test(file)) return withoutXmlComments(text);
  return text;
}
