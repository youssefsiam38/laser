/**
 * The smallest template engine that can hold a product's name (MX-T7).
 *
 * `{{path.into.identity}}`, with three filters:
 *
 *   {{keywords|join:;}}      a;b;c
 *   {{categories|yaml}}      [a, b, c]
 *   {{copy.summary|json}}    "…", quoted and escaped
 *
 * An unknown path is a thrown error rather than an empty string, because a
 * silently blank `appId` is exactly the failure this whole task exists to make
 * impossible.
 */

const filters = {
  json: (value) => JSON.stringify(value),
  yaml: (value) => (Array.isArray(value) ? `[${value.join(", ")}]` : String(value)),
  upper: (value) => String(value).toUpperCase(),
  /** `$LASER_ARCH` — a shell variable reference, for files where `${{` means something else. */
  shellvar: (value) => `$${value}`,
  /** A JSON array's contents: `"a", "b"` — for use inside literal brackets. */
  jsonList: (value) => (Array.isArray(value) ? value.map((item) => JSON.stringify(item)).join(", ") : JSON.stringify(value)),
  /** A POSIX-sh word list: `"16 32 48"`, safe to iterate with `for x in $list`. */
  spaced: (value) => (Array.isArray(value) ? value.join(" ") : String(value)),
};

function lookup(values, path) {
  let current = values;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Render `text`, resolving `{{…}}` against `values`.
 *
 * @param {string} text
 * @param {Record<string, unknown>} values
 * @param {string} [origin] the file being rendered, for the error message
 */
export function renderTemplate(text, values, origin = "template") {
  const unknown = [];
  // `(?<!\$)` keeps GitHub Actions' own `${{ … }}` expressions out of this: a
  // workflow template holds both syntaxes, and only the unprefixed one is ours.
  const pattern = /(?<!\$)\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|\s*([a-zA-Z]+)(?::([^}]*))?\s*)?\}\}/g;
  const out = text.replace(pattern, (_, path, filter, arg) => {
    const value = lookup(values, path);
    if (value === undefined) {
      unknown.push(path);
      return "";
    }
    if (filter === "join") return Array.isArray(value) ? value.join(arg ?? "") : String(value);
    if (filter !== undefined) {
      const fn = filters[filter];
      if (!fn) {
        unknown.push(`${path}|${filter}`);
        return "";
      }
      return fn(value);
    }
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
  if (unknown.length > 0) {
    throw new Error(
      `${origin}: ${[...new Set(unknown)].map((p) => `{{${p}}}`).join(", ")} is not in product.json.\n` +
        `Add the field there, or fix the placeholder — a blank identity value is worse than a failed build.`,
    );
  }
  return out;
}

/** Same engine, named for the callers that render `.sh` and `.tpl` files. */
export const renderShellTemplate = renderTemplate;
