import { blankHashComments, loadSource, walk, type SourceFile } from "../rules/source.js";
import type { FactCandidate } from "./types.js";

/**
 * Values a program pins, read off the line that pins them.
 *
 * `src/rules` reads config and asks "is this binding?". Nothing reads *source*, and source is
 * where the tunables that decide behaviour actually live — a `page_size` that a backend refuses
 * to run without, a `CACHE_GROW_SIZE` that quantises every cache allocation. Those are facts
 * about the system, they are machine-checkable, and until now the only route into the store was
 * for a person to notice one and type it in.
 *
 * Three constructs, and nothing else, because these three are the ones whose meaning is
 * unambiguous without evaluating the program:
 *
 * - `static_assert(X == N)`  — C/C++/CUDA. Fails the build. `constraint`.
 * - `assert X == N, "msg"`   — Python. Fails the run. `constraint`.
 * - `const NAME: T = N;`     — Rust. Fails nothing; records the value. `state`.
 *
 * Anything whose right-hand side is not a literal is skipped rather than guessed at. `const
 * DEFAULT_MAX_BODY_LIMIT: usize = N_INPUT_SIZE * MB_TO_B;` has a value this reader cannot know
 * without becoming a compiler, and a store that writes `N_INPUT_SIZE * MB_TO_B` into an `object`
 * as if it were a number is worse than one that stays quiet.
 */

const RUST_EXTS = [".rs"] as const;
const CFAMILY_EXTS = [".c", ".cc", ".cpp", ".cu", ".cuh", ".h", ".hpp", ".hxx"] as const;
const PYTHON_EXTS = [".py"] as const;

/**
 * A numeric or boolean literal, with the suffixes and separators each language allows.
 *
 * Anchored whole-string by the callers: a partial match would turn `1_000_000 / RATE` into the
 * fact "this is 1000000", which is the specific kind of confidently-wrong row this project
 * exists to refuse.
 */
const LITERAL = /^(?:0[xX][0-9a-fA-F_]+|[-+]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?)(?:[iuf](?:8|16|32|64|128|size)|[uU][lL]{0,2}|[lL]{1,2}[uU]?|[fF])?$/;

/**
 * Names that denote a bound rather than a value.
 *
 * The filter is not decoration. Arc's tree holds 856 Rust consts and the overwhelming majority
 * are string tables, kernel names and format strings — real, and not knowledge anybody would ask
 * a store about. A name ending `_SIZE`, `_LIMIT`, `_STEPS` or `_WINDOW` is a tunable by
 * construction: whoever wrote it was naming a quantity that bounds something. The brief for this
 * subsystem asked for "const limits", and this is the mechanical reading of *limit*.
 */
const BOUND_NAME =
  /_(?:MAX|MIN|SIZE|LIMIT|LEN|CAP|CAPACITY|BUDGET|THRESHOLD|STEPS|WINDOW|COUNT|BYTES|WIDTH|DEPTH|TIMEOUT|INTERVAL|STRIDE|ALIGN|RATIO|DIM)$|^(?:MAX|MIN|DEFAULT)_/;

const RUST_CONST =
  /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z][A-Z0-9_]*)\s*:\s*([^=;]+?)\s*=\s*([^;]+);/;

/** `IDENT == LITERAL`, where IDENT may be scoped or attribute-qualified. */
const PIN_EQUALITY = /^([A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*)\s*==\s*(\S+)$/;

/** `IDENT % LITERAL == 0` — a divisibility floor, which is a constraint of a different shape. */
const PIN_DIVISIBILITY =
  /^([A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*)\s*%\s*(\S+)\s*==\s*0$/;

export function readPinnedFacts(dir: string): FactCandidate[] {
  const out: FactCandidate[] = [];
  for (const rel of walk(dir, { extensions: RUST_EXTS })) {
    const file = loadSource(dir, rel);
    if (file) readRustConsts(file, out);
  }
  for (const rel of walk(dir, { extensions: CFAMILY_EXTS })) {
    const file = loadSource(dir, rel);
    if (file) readStaticAsserts(file, out);
  }
  for (const rel of walk(dir, { extensions: PYTHON_EXTS })) {
    const file = loadSource(dir, rel);
    if (file) readPythonPins(file, out);
  }
  return out;
}

function numberOf(literal: string): number | null {
  const cleaned = literal.replace(/_/g, "").replace(/(?:[iuf](?:8|16|32|64|128|size)|[uUlL]+|[fF])$/, "");
  const value = cleaned.startsWith("0x") || cleaned.startsWith("0X") ? Number.parseInt(cleaned, 16) : Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function readRustConsts(file: SourceFile, out: FactCandidate[]): void {
  for (const [index, raw] of file.lines.entries()) {
    // `//` comments, which `blankHashComments` does not know about. A commented-out const is not
    // a fact about the program.
    const line = raw.replace(/\/\/.*$/, "");
    const m = RUST_CONST.exec(line);
    if (!m) continue;
    const [, name, type, rhs] = m as unknown as [string, string, string, string];
    if (!BOUND_NAME.test(name)) continue;
    const literal = rhs.trim();
    if (!LITERAL.test(literal)) continue;
    const value = numberOf(literal);
    if (value === null) continue;

    out.push({
      subject: `pin/${file.rel}/${name}`,
      predicate: "set_to",
      object: { file: file.rel, name, value, literal, type: type.trim(), language: "rust" },
      claim: `\`${name}\` is ${value} in ${file.rel} (\`${literal}\`, type \`${type.trim()}\`)`,
      // A `const` is what the value IS at this commit. Nothing refuses a different one, so this
      // is `state` and it does not bind — see `INSTRUMENT_KINDS`.
      kind: "state",
      binding: false,
      locator: `${file.rel}:${index + 1}`,
    });
  }
}

/**
 * `static_assert` needs paren balancing, not a regex: `static_assert(sizeof(T) == 4)` closes twice
 * and `[^)]+` would stop at the wrong one, silently truncating the expression under test.
 */
function readStaticAsserts(file: SourceFile, out: FactCandidate[]): void {
  const text = file.text;
  const keyword = /\bstatic_assert\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    const line = text.slice(0, match.index).split("\n").length;
    const args = splitTopLevelComma(text.slice(open + 1, close));
    const expr = (args[0] ?? "").replace(/\s+/g, " ").trim();
    const message = unquote((args[1] ?? "").trim());
    const pin = pinFromExpression(expr);
    if (!pin) continue;

    out.push({
      subject: `pin/${file.rel}/${pin.name}`,
      predicate: pin.predicate,
      object: {
        file: file.rel,
        name: pin.name,
        value: pin.value,
        expression: expr,
        message: message.length > 0 ? message : null,
        mechanism: "static_assert",
        language: "c-family",
      },
      claim:
        `\`${pin.name}\` ${pin.phrase} ${pin.value} in ${file.rel} — a \`static_assert\`, so the ` +
        `build fails on any other value${message.length > 0 ? ` ("${message}")` : ""}`,
      // The compiler refuses to produce a binary if this is false. Violating it fails something,
      // which is the whole test for `constraint`.
      kind: "constraint",
      binding: true,
      locator: `${file.rel}:${line}`,
    });
  }
}

/**
 * Python `assert X == N, "msg"`.
 *
 * The message is required. A bare `assert x == 1` is as likely to be a test fixture's arithmetic
 * as a statement about the system, whereas an author who wrote a message was explaining a
 * constraint to whoever trips it — which is exactly the case where the extracted fact is worth
 * having. SGLang's `assert self.page_size == 256, "the system hardcodes page_size=256"` is the
 * shape this reads, and the message is the sentence that makes it legible.
 */
function readPythonPins(file: SourceFile, out: FactCandidate[]): void {
  for (const statement of logicalLines(file)) {
    if (!/^assert\b/.test(statement.text)) continue;
    const args = splitTopLevelComma(statement.text.replace(/^assert\b/, ""));
    if (args.length < 2) continue;
    const message = unquote((args[1] ?? "").trim());
    if (message.length === 0) continue;
    const expr = stripOuterParens((args[0] ?? "").trim()).replace(/\s+/g, " ");
    const pin = pinFromExpression(expr);
    if (!pin) continue;

    out.push({
      subject: `pin/${file.rel}/${pin.name}`,
      predicate: pin.predicate,
      object: {
        file: file.rel,
        name: pin.name,
        value: pin.value,
        expression: expr,
        message,
        mechanism: "assert",
        language: "python",
      },
      claim:
        `\`${pin.name}\` ${pin.phrase} ${pin.value} in ${file.rel} — asserted at runtime, so the ` +
        `program refuses any other value ("${message}")`,
      kind: "constraint",
      binding: true,
      locator: `${file.rel}:${statement.line}`,
    });
  }
}

interface Pin {
  name: string;
  value: number;
  predicate: "pinned_to" | "divisible_by";
  phrase: string;
}

function pinFromExpression(expr: string): Pin | null {
  const divisible = PIN_DIVISIBILITY.exec(expr);
  const equality = divisible ? null : PIN_EQUALITY.exec(expr);
  const matched = divisible ?? equality;
  if (matched) {
    const value = LITERAL.test(matched[2]!) ? numberOf(matched[2]!) : null;
    if (value === null) return null;
    // `self.page_size` is a fact about `page_size`: the receiver is the site, which the subject
    // already carries as a path, and repeating it in the name would make every fact unfindable
    // under the word a person would search for.
    const segments = matched[1]!.split(/::|\./);
    const name = segments[segments.length - 1] ?? matched[1]!;
    return divisible
      ? { name, value, predicate: "divisible_by", phrase: "must be a multiple of" }
      : { name, value, predicate: "pinned_to", phrase: "is pinned to" };
  }
  // Disjunctions (`n == 128 || n == 256 || n == 512`), comparisons against other identifiers, and
  // template arithmetic all land here and produce nothing. A pin with three permitted values is a
  // real constraint, but it is not the fact "the value is N", and flattening it to one would be a
  // fabrication.
  return null;
}

interface LogicalLine {
  /** 1-based line the statement starts on. */
  line: number;
  /** Comment-stripped, bracket-joined, whitespace-collapsed. */
  text: string;
}

/**
 * Python statements, joined across the bracket continuations SGLang writes its asserts with:
 *
 *     assert (
 *         self.page_size == 256
 *     ), "the system hardcodes page_size=256"
 *
 * Read line-at-a-time that is three fragments and none of them is a fact.
 */
function logicalLines(file: SourceFile): LogicalLine[] {
  const out: LogicalLine[] = [];
  for (let i = 0; i < file.lines.length; i++) {
    const first = blankHashComments(file.lines[i] ?? "").trim();
    if (first.length === 0) continue;
    let text = first;
    const start = i + 1;
    while (unbalanced(text) && i + 1 < file.lines.length) {
      i++;
      text = `${text} ${blankHashComments(file.lines[i] ?? "").trim()}`;
    }
    out.push({ line: start, text: text.replace(/\s+/g, " ").trim() });
  }
  return out;
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/** Quote-aware bracket depth: positive means the statement continues onto the next line. */
function unbalanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth--;
  }
  return depth > 0;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function stripOuterParens(text: string): string {
  let out = text.trim();
  while (out.startsWith("(") && matchParen(out, 0) === out.length - 1) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** `f"msg"`, `"msg"` and `'msg'` all reduce to `msg`; anything else is returned unchanged. */
function unquote(text: string): string {
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(text.trim());
  return m ? (m[2] ?? "") : text.trim();
}
