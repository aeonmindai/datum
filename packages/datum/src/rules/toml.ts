import { blankHashComments, type SourceFile } from "./source.js";

/**
 * A line-indexed TOML subset parser for `Cargo.toml`, `clippy.toml`, `rustfmt.toml`, `ruff.toml`,
 * `pyproject.toml`, `rust-toolchain.toml` and `deny.toml`.
 *
 * Same reason as the YAML parser: the deliverable is `file:line`, and a conforming TOML parser
 * discards it. Supported: tables, array-of-tables, dotted keys, basic/literal strings (including
 * triple-quoted), integers, floats, booleans, arrays and inline tables, with values allowed to span
 * lines when a bracket or brace is left open. Not supported: dates as typed values (kept as
 * strings) and `\` line continuations inside multi-line basic strings.
 *
 * Array elements carry their own line, because a `disallowed-methods` list is a list of separate
 * bans and each one has to cite the line it is written on.
 */

export type TomlValue = string | number | boolean | TomlArray | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlArray = TomlValue[];

export interface TomlEntry {
  /** Dotted table path, `""` for the document root. */
  table: string;
  /** Dotted key path relative to `table`. */
  key: string;
  /** `table.key`, or just `key` at the root. */
  path: string;
  value: TomlValue;
  /** Line of the `key =` that opens this entry. */
  line: number;
  /** For array values: the line each element is written on, same order as the array. */
  elementLines: number[];
}

export interface TomlDocument {
  entries: TomlEntry[];
  /** Line each `[table]` header appears on. Array-of-table headers keep their first occurrence. */
  tableLines: Record<string, number>;
}

export function parseToml(file: SourceFile): TomlDocument {
  const entries: TomlEntry[] = [];
  const tableLines: Record<string, number> = {};
  let table = "";

  for (let i = 0; i < file.lines.length; i++) {
    const raw = file.lines[i]!;
    const stripped = blankHashComments(raw).trim();
    if (stripped.length === 0) continue;

    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(stripped);
    if (header) {
      table = header[1]!.split(".").map(unquoteKey).join(".");
      if (tableLines[table] === undefined) tableLines[table] = i + 1;
      continue;
    }

    const eq = topLevelEquals(stripped);
    if (eq < 0) continue;
    const key = stripped
      .slice(0, eq)
      .trim()
      .split(".")
      .map(unquoteKey)
      .join(".");
    if (key.length === 0) continue;

    // A value whose brackets are still open continues onto following lines. Cargo.toml's feature
    // lists and .typos.toml's ignore lists are both written that way.
    let text = stripped.slice(eq + 1).trim();
    const startLine = i + 1;
    const elementLines: number[] = [];
    let lineOfOffset: Array<number> = new Array(text.length).fill(startLine);
    while (unbalanced(text) && i + 1 < file.lines.length) {
      i++;
      const more = blankHashComments(file.lines[i]!).trim();
      const joined = `${text}\n${more}`;
      lineOfOffset = lineOfOffset.concat([i + 1], new Array(more.length).fill(i + 1));
      text = joined;
    }
    const value = parseValue(text, lineOfOffset, startLine, elementLines);
    entries.push({
      table,
      key,
      path: table.length > 0 ? `${table}.${key}` : key,
      value,
      line: startLine,
      elementLines,
    });
  }

  return { entries, tableLines };
}

/** Index of the `=` that separates key from value, ignoring any inside quotes or brackets. */
function topLevelEquals(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "=" && depth === 0) return i;
  }
  return -1;
}

function unbalanced(text: string): boolean {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth > 0 || quote !== null;
}

function parseValue(
  text: string,
  lineOfOffset: number[],
  fallbackLine: number,
  elementLines: number[],
): TomlValue {
  const trimmed = text.trim();
  const offset = text.indexOf(trimmed[0] ?? "");
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf("]"));
    const innerOffset = offset + 1;
    const parts = splitToml(inner);
    const out: TomlValue[] = [];
    for (const part of parts) {
      const at = innerOffset + part.start;
      elementLines.push(lineOfOffset[at] ?? fallbackLine);
      out.push(parseValue(part.text, lineOfOffset, fallbackLine, []));
    }
    return out;
  }
  if (trimmed.startsWith("{")) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf("}"));
    const table: TomlTable = {};
    for (const part of splitToml(inner)) {
      const eq = topLevelEquals(part.text);
      if (eq < 0) continue;
      table[part.text.slice(0, eq).trim().split(".").map(unquoteKey).join(".")] = parseValue(
        part.text.slice(eq + 1),
        lineOfOffset,
        fallbackLine,
        [],
      );
    }
    return table;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    const q = trimmed.slice(0, 3);
    const end = trimmed.indexOf(q, 3);
    return end < 0 ? trimmed.slice(3) : trimmed.slice(3, end).replace(/^\n/, "");
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return unquoteKey(trimmed);
  const numeric = trimmed.replace(/_/g, "");
  if (/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(numeric)) {
    return Number(numeric);
  }
  // Dates, `inf`, `nan` and anything unrecognised stay verbatim. No enforcement config we read
  // depends on them being typed, and inventing a coercion would be a silent lie about the file.
  return trimmed;
}

interface TomlPart {
  text: string;
  /** Offset of the part's first character within the string handed to `splitToml`. */
  start: number;
}

function splitToml(text: string): TomlPart[] {
  const out: TomlPart[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  const push = (end: number): void => {
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    if (slice.trim().length > 0) out.push({ text: slice.trim(), start: start + lead });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

function unquoteKey(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

// ---------------------------------------------------------------------------------------

/** Entries directly under a table, e.g. `entriesIn(doc, "profile.release")`. */
export function entriesIn(doc: TomlDocument, table: string): TomlEntry[] {
  return doc.entries.filter((e) => e.table === table);
}

/** Tables whose path starts with `prefix.`, e.g. every `profile.*`. Deduplicated, in file order. */
export function tablesUnder(doc: TomlDocument, prefix: string): string[] {
  const seen = new Set<string>();
  for (const entry of doc.entries) {
    if (entry.table === prefix || entry.table.startsWith(`${prefix}.`)) seen.add(entry.table);
  }
  for (const table of Object.keys(doc.tableLines)) {
    if (table === prefix || table.startsWith(`${prefix}.`)) seen.add(table);
  }
  return [...seen];
}

export function entryAt(doc: TomlDocument, path: string): TomlEntry | null {
  for (const entry of doc.entries) if (entry.path === path) return entry;
  return null;
}

export function asStringArray(value: TomlValue): string[] {
  if (!Array.isArray(value)) return typeof value === "string" ? [value] : [];
  return value.filter((v): v is string => typeof v === "string");
}
