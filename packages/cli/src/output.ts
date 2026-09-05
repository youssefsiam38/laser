/**
 * Terminal output: colors that disappear when nobody can see them, a table
 * renderer that measures visible width, and one place that decides stdout vs
 * stderr.
 *
 * The contract for every command: **data to stdout, everything else to
 * stderr**. `laser sessions --json | jq` must never see a progress line.
 */

/** Colour codes only, for measuring the visible width of a rendered cell. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Everything a terminal would act on rather than show: CSI sequences, OSC
 * strings (window title, hyperlinks), two-character escapes, and the C0/C1
 * control ranges. Tab, newline and carriage return are deliberately kept.
 */
const CONTROL =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export type Paint = (text: string) => string;

export interface Painter {
  readonly enabled: boolean;
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  cyan: Paint;
  magenta: Paint;
  underline: Paint;
}

const identity: Paint = (text) => text;

function wrap(open: number, close: number): Paint {
  return (text) => `\u001b[${open}m${text}\u001b[${close}m`;
}

const PLAIN: Painter = {
  enabled: false,
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  cyan: identity,
  magenta: identity,
  underline: identity,
};

const COLOR: Painter = {
  enabled: true,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  underline: wrap(4, 24),
};

export type ColorMode = "auto" | "always" | "never";

/**
 * Colour rules, in order: an explicit `--color`/`--no-color` wins, then
 * `NO_COLOR` (any value, per no-color.org), then `FORCE_COLOR`, then "is this
 * stream a TTY that understands colour".
 */
export function painterFor(stream: NodeJS.WriteStream, mode: ColorMode, env: NodeJS.ProcessEnv = process.env): Painter {
  if (mode === "never") return PLAIN;
  if (mode === "always") return COLOR;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return PLAIN;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return COLOR;
  if (env["TERM"] === "dumb") return PLAIN;
  return stream.isTTY ? COLOR : PLAIN;
}

/** Visible width, ignoring colour codes. Good enough for ASCII table columns. */
export function width(text: string): number {
  return text.replace(ANSI, "").length;
}

/**
 * Strip escape sequences and control characters from text that came from an
 * agent, a tool result, or a session file. The terminal equivalent of
 * AGENTS.md invariant 9: agent output is data, never markup. Tabs and newlines
 * survive.
 */
export function sanitize(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * The same rule, applied to a whole structure.
 *
 * Panels are agent-authored all the way down — a run's title, a plan step's
 * label, a mission's ledger — and sanitizing them one field at a time at the
 * point of printing is a rule that holds only until the next column is added.
 * One pass at the boundary is the version that stays true: `\u001b]0;…\u0007`
 * in a subagent's task string retitles the terminal, `\u001b]52;c;…\u0007`
 * writes the clipboard, and `laser runs` is the command people put in a
 * loop.
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitize(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item: unknown) => sanitizeDeep(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[sanitize(key)] = sanitizeDeep(item);
    return out as T;
  }
  return value;
}

export interface Column<Row> {
  header: string;
  get: (row: Row) => string;
  align?: "left" | "right";
}

/** Two-space-separated columns, padded to the widest visible cell. */
export function table<Row>(rows: readonly Row[], columns: readonly Column<Row>[], paint: Painter): string[] {
  if (rows.length === 0) return [];
  const cells = rows.map((row) => columns.map((column) => column.get(row)));
  const widths = columns.map((column, i) =>
    Math.max(width(column.header), ...cells.map((row) => width(row[i] ?? ""))),
  );
  const pad = (text: string, i: number, align: "left" | "right") => {
    const fill = " ".repeat(Math.max(0, (widths[i] ?? 0) - width(text)));
    return align === "right" ? fill + text : text + fill;
  };
  const line = (values: string[]) =>
    values
      .map((value, i) => pad(value, i, columns[i]?.align ?? "left"))
      .join("  ")
      .trimEnd();
  return [
    paint.dim(line(columns.map((column) => column.header.toUpperCase()))),
    ...cells.map((row) => line(row.map((value) => value ?? ""))),
  ];
}

export interface TerminalOptions {
  json: boolean;
  color: ColorMode;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

/**
 * The output surface handed to every command. `print`/`data` write the answer;
 * `note`/`warn` write everything a human wants but a pipe does not.
 */
export class Terminal {
  readonly json: boolean;
  readonly out: Painter;
  readonly err: Painter;
  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;

  constructor(options: TerminalOptions) {
    this.json = options.json;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.out = painterFor(this.stdout, options.color);
    this.err = painterFor(this.stderr, options.color);
  }

  /** Data. Suppressed in `--json` mode so a command can call both freely. */
  print(line = ""): void {
    if (!this.json) this.stdout.write(`${line}\n`);
  }

  /** Data, unconditionally (raw streams: `tail`, `completions`). */
  write(text: string): void {
    this.stdout.write(text);
  }

  /** The `--json` answer. Exactly one per command, pretty-printed for humans. */
  data(value: unknown): void {
    if (this.json) this.stdout.write(`${JSON.stringify(value, null, this.stdout.isTTY ? 2 : 0)}\n`);
  }

  /** One NDJSON record (streaming commands in `--json` mode). */
  record(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  /** Human context. Never stdout, so it cannot corrupt a pipe. */
  note(line = ""): void {
    if (!this.json) this.stderr.write(`${line}\n`);
  }

  warn(line: string): void {
    this.stderr.write(`${this.err.yellow("warning")} ${line}\n`);
  }
}
