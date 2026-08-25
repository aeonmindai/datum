import { blankHashComments, type SourceFile } from "./source.js";

/**
 * A line-indexed YAML subset parser, covering exactly what GitHub Actions workflows use:
 * block mappings, block sequences, flow collections, quoted scalars and block scalars (`|`, `>`).
 *
 * Why not a real YAML library: every one of them returns plain JS values, which means the line a
 * value came from is gone by the time you have the value. `evidence.source` must name the enforcing
 * line, so the line is not optional metadata here — it is the point. Anchors, aliases, tags and
 * multi-document streams are not supported; workflows do not use them, and a file that does simply
 * yields fewer rules rather than a wrong one.
 *
 * Nothing here throws. A malformed workflow should cost us that workflow's rules, not the whole
 * derivation.
 */

export interface YamlScalar {
  kind: "scalar";
  line: number;
  value: string;
  /** True for `|`/`>` scalars, where `#` is content and never a comment. */
  block: boolean;
}

export interface YamlEntry {
  key: string;
  /** Line of the key itself — what a rule about this setting cites. */
  line: number;
  value: YamlNode;
}

export interface YamlMap {
  kind: "map";
  line: number;
  entries: YamlEntry[];
}

export interface YamlSeq {
  kind: "seq";
  line: number;
  items: YamlNode[];
}

export type YamlNode = YamlScalar | YamlMap | YamlSeq;

/** One physical line reduced to what the parser cares about. */
interface Line {
  /** 1-based. */
  n: number;
  indent: number;
  /** Comment-blanked and right-trimmed; empty for blank/comment-only lines. */
  content: string;
  /** Verbatim, for block scalars. */
  raw: string;
}

const EMPTY_MAP: YamlMap = { kind: "map", line: 0, entries: [] };

export function parseYaml(file: SourceFile): YamlMap {
  const lines: Line[] = file.lines.map((raw, i) => {
    const stripped = blankHashComments(raw).replace(/\s+$/, "");
    return { n: i + 1, indent: stripped.length - stripped.trimStart().length, content: stripped.trim(), raw };
  });

  const cursor = { i: 0 };
  const advanceToContent = (): Line | null => {
    while (cursor.i < lines.length && lines[cursor.i]!.content.length === 0) cursor.i++;
    return cursor.i < lines.length ? lines[cursor.i]! : null;
  };

  const first = advanceToContent();
  if (!first) return EMPTY_MAP;
  const root = parseBlock(lines, cursor, first.indent, advanceToContent);
  return root.kind === "map" ? root : { kind: "map", line: root.line, entries: [] };
}

function parseBlock(
  lines: Line[],
  cursor: { i: number },
  indent: number,
  advance: () => Line | null,
): YamlNode {
  const head = advance();
  if (!head || head.indent < indent) return { kind: "scalar", line: head?.n ?? 0, value: "", block: false };
  if (head.content === "-" || head.content.startsWith("- ")) {
    return parseSeq(lines, cursor, head.indent, advance);
  }
  if (splitKey(head.content)) return parseMap(lines, cursor, head.indent, advance);
  cursor.i++;
  return { kind: "scalar", line: head.n, value: unquote(head.content), block: false };
}

function parseMap(
  lines: Line[],
  cursor: { i: number },
  indent: number,
  advance: () => Line | null,
): YamlMap {
  const entries: YamlEntry[] = [];
  let startLine = 0;
  for (;;) {
    const line = advance();
    if (!line || line.indent < indent) break;
    // A deeper line here means the previous entry's nested block was not consumed, which only
    // happens on malformed input. Skipping keeps the rest of the file parseable.
    if (line.indent > indent) {
      cursor.i++;
      continue;
    }
    const split = splitKey(line.content);
    if (!split) break;
    if (startLine === 0) startLine = line.n;
    cursor.i++;
    entries.push({ key: split.key, line: line.n, value: valueFor(lines, cursor, line, split.rest, indent, advance) });
  }
  return { kind: "map", line: startLine, entries };
}

function parseSeq(
  lines: Line[],
  cursor: { i: number },
  indent: number,
  advance: () => Line | null,
): YamlSeq {
  const items: YamlNode[] = [];
  let startLine = 0;
  for (;;) {
    const line = advance();
    if (!line || line.indent !== indent) break;
    if (line.content !== "-" && !line.content.startsWith("- ")) break;
    if (startLine === 0) startLine = line.n;
    cursor.i++;
    if (line.content === "-") {
      items.push(parseBlock(lines, cursor, indent + 1, advance));
      continue;
    }
    // `- uses: actions/checkout@v4` — the item's content begins at a virtual indent two columns in,
    // and any following keys indented to that column belong to this item's mapping.
    const inner = line.content.slice(2);
    const innerIndent = indent + 2;
    const split = splitKey(inner);
    if (!split) {
      items.push({ kind: "scalar", line: line.n, value: unquote(inner), block: false });
      continue;
    }
    const virtual: Line = { n: line.n, indent: innerIndent, content: inner, raw: line.raw };
    const firstValue = valueFor(lines, cursor, virtual, split.rest, innerIndent, advance);
    const map: YamlMap = {
      kind: "map",
      line: line.n,
      entries: [{ key: split.key, line: line.n, value: firstValue }],
    };
    for (;;) {
      const next = advance();
      if (!next || next.indent !== innerIndent) break;
      const nextSplit = splitKey(next.content);
      if (!nextSplit) break;
      cursor.i++;
      map.entries.push({
        key: nextSplit.key,
        line: next.n,
        value: valueFor(lines, cursor, next, nextSplit.rest, innerIndent, advance),
      });
    }
    items.push(map);
  }
  return { kind: "seq", line: startLine, items };
}

function valueFor(
  lines: Line[],
  cursor: { i: number },
  keyLine: Line,
  rest: string,
  indent: number,
  advance: () => Line | null,
): YamlNode {
  const trimmed = rest.trim();
  const blockIndicator = /^([|>])([+-]?\d*|\d*[+-]?)$/.exec(trimmed);
  if (blockIndicator) {
    return readBlockScalar(lines, cursor, keyLine, indent, blockIndicator[1] === ">");
  }
  if (trimmed.length > 0) {
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      return parseFlow(trimmed, keyLine.n);
    }
    return { kind: "scalar", line: keyLine.n, value: unquote(trimmed), block: false };
  }
  // Empty after the colon: either a nested block below, or a genuinely null value.
  const next = advance();
  if (!next || next.indent <= indent) return { kind: "scalar", line: keyLine.n, value: "", block: false };
  return parseBlock(lines, cursor, next.indent, advance);
}

/**
 * Block scalars are where CI enforcement actually lives — `run: |` holds the `exit 1`s and the
 * threshold comparisons — so they are captured verbatim with their first line number, and `#`
 * inside them is shell, not a comment.
 */
function readBlockScalar(
  lines: Line[],
  cursor: { i: number },
  keyLine: Line,
  indent: number,
  fold: boolean,
): YamlScalar {
  const collected: string[] = [];
  const startLine = cursor.i < lines.length ? lines[cursor.i]!.n : keyLine.n;
  let bodyIndent = -1;
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]!;
    const rawIndent = line.raw.length - line.raw.trimStart().length;
    const blank = line.raw.trim().length === 0;
    if (!blank && rawIndent <= indent) break;
    if (bodyIndent < 0 && !blank) bodyIndent = rawIndent;
    collected.push(blank ? "" : line.raw.slice(bodyIndent < 0 ? rawIndent : bodyIndent));
    cursor.i++;
  }
  while (collected.length > 0 && collected[collected.length - 1]!.length === 0) collected.pop();
  return {
    kind: "scalar",
    line: collected.length > 0 ? startLine : keyLine.n,
    value: collected.join(fold ? " " : "\n"),
    block: true,
  };
}

/** `[a, b]` and `{a: b}`. Nesting is supported; workflows use `os: [ubuntu-latest, macOS-latest]`. */
function parseFlow(text: string, line: number): YamlNode {
  const close = text.startsWith("[") ? "]" : "}";
  const end = matchingBracket(text);
  const inner = end > 0 ? text.slice(1, end) : text.slice(1).replace(new RegExp(`\\${close}$`), "");
  const parts = splitTopLevel(inner);
  if (close === "]") {
    return {
      kind: "seq",
      line,
      items: parts.map((p) =>
        p.startsWith("[") || p.startsWith("{")
          ? parseFlow(p, line)
          : ({ kind: "scalar", line, value: unquote(p), block: false } as YamlScalar),
      ),
    };
  }
  const entries: YamlEntry[] = [];
  for (const part of parts) {
    const split = splitKey(part);
    if (!split) continue;
    const rest = split.rest.trim();
    entries.push({
      key: split.key,
      line,
      value:
        rest.startsWith("[") || rest.startsWith("{")
          ? parseFlow(rest, line)
          : { kind: "scalar", line, value: unquote(rest), block: false },
    });
  }
  return { kind: "map", line, entries };
}

function matchingBracket(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function splitTopLevel(text: string, separator = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out.filter((s) => s.length > 0);
}

/**
 * Split `key: value`. The colon must be followed by whitespace or end-of-line, which is what keeps
 * `group: ${{ a }}-${{ b }}` and `run: echo "::error::x"` from splitting in the wrong place.
 */
export function splitKey(content: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (i === 0) quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") return null;
    if (ch === ":") {
      const after = content[i + 1];
      if (after === undefined || after === " " || after === "\t") {
        const key = unquote(content.slice(0, i).trim());
        if (key.length === 0) return null;
        return { key, rest: content.slice(i + 1) };
      }
      // `a:b` is a plain scalar, not a mapping — do not split it.
      return null;
    }
  }
  return null;
}

export function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// ---------------------------------------------------------------------------------------
// Accessors. Every one tolerates the wrong shape, because a workflow is user-authored data.

export function mapEntry(node: YamlNode | undefined, key: string): YamlEntry | null {
  if (!node || node.kind !== "map") return null;
  for (const entry of node.entries) if (entry.key === key) return entry;
  return null;
}

export function scalarAt(node: YamlNode | undefined, key: string): { value: string; line: number } | null {
  const entry = mapEntry(node, key);
  if (!entry || entry.value.kind !== "scalar") return null;
  return { value: entry.value.value, line: entry.line };
}

/** A YAML value that may be written as a scalar or a list, flattened to a list of strings. */
export function stringList(node: YamlNode | undefined): string[] {
  if (!node) return [];
  if (node.kind === "scalar") return node.value.length > 0 ? [node.value] : [];
  if (node.kind === "seq") {
    return node.items.flatMap((item) => (item.kind === "scalar" ? [item.value] : []));
  }
  return node.entries.map((e) => e.key);
}
