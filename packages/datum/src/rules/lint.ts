import { loadSource, walk, type SourceFile } from "./source.js";
import { asStringArray, parseToml, type TomlValue } from "./toml.js";
import { mapEntry, parseYaml, type YamlNode } from "./yaml.js";
import { RuleSink, type RuleCandidate } from "./types.js";
import type { CiEscalation } from "./workflows.js";

/**
 * Lint and format configuration.
 *
 * The crux of this file is severity, and severity does not mean the same thing in any two tools.
 * Getting it wrong in either direction is a real failure: calling advice binding makes the store
 * lie, and calling a hard gate advice makes it useless.
 *
 *   * **ESLint** grades per rule: `off`/`0` is not a rule at all, `warn`/`1` exits zero and so fails
 *     nothing, `error`/`2` exits non-zero. So `error` binds and `warn` does not — *unless* CI runs
 *     with `--max-warnings 0`, which makes every warning fail. That escalation is read from the
 *     workflow deriver rather than assumed.
 *   * **Clippy** has no severities in `clippy.toml`; that file only *configures* lints. Severity
 *     lives in `[lints.clippy]` tables, in crate-level `#![deny(...)]` attributes, and on the
 *     command line as `-D warnings`. `deny`/`forbid` bind, `warn` does not, `allow` is not a rule.
 *   * **rustfmt** has no severities either: the config is a specification, and it binds exactly when
 *     something runs `cargo fmt --check`. Two settings are the exception — `error_on_line_overflow`
 *     and `error_on_unformatted` make rustfmt itself fail, so they bind on their own terms.
 *   * **Ruff** has no warn level: a selected rule is a diagnostic and `ruff check` exits non-zero on
 *     any diagnostic. Selection therefore is the severity, and `--exit-zero` is the only way out.
 *   * **mypy/pytest/coverage** are settings, binding when the tool runs and the setting is one that
 *     causes a non-zero exit (`strict`, `-W error`, `fail_under`).
 */

const SEVERITY_PRIORITY: Record<CiEscalation["mode"], number> = {
  "deny-warnings": 5,
  "max-warnings-zero": 4,
  check: 3,
  run: 2,
  advisory: 1,
};

export interface ToolEnforcement {
  mode: CiEscalation["mode"];
  locator: string;
  command: string;
  scoped: string[];
}

/** The strongest CI invocation of a tool, or null when nothing in CI runs it. */
export function strongestEnforcement(
  escalations: readonly CiEscalation[],
  tool: string,
): ToolEnforcement | null {
  let best: CiEscalation | null = null;
  for (const escalation of escalations) {
    if (escalation.tool !== tool) continue;
    if (!best || SEVERITY_PRIORITY[escalation.mode] > SEVERITY_PRIORITY[best.mode]) best = escalation;
  }
  return best
    ? { mode: best.mode, locator: best.locator, command: best.command, scoped: best.scoped }
    : null;
}

export function deriveLintRules(
  dir: string,
  sink: RuleSink,
  escalations: readonly CiEscalation[],
): void {
  deriveEslint(dir, sink, escalations);
  deriveClippy(dir, sink, escalations);
  deriveRustfmt(dir, sink, escalations);
  deriveRuff(dir, sink, escalations);
  derivePythonTools(dir, sink, escalations);
  deriveTypos(dir, sink, escalations);
}

// ---------------------------------------------------------------------------------------
// ESLint

const ESLINT_SEVERITY: Record<string, "off" | "warn" | "error"> = {
  off: "off",
  "0": "off",
  warn: "warn",
  "1": "warn",
  error: "error",
  "2": "error",
};

/** A rule name followed by a severity literal. The severity keyword set is what keeps this from
 *  matching ordinary config keys — `sourceType: "module"` has no severity to find. */
const ESLINT_RULE_LINE =
  /^\s*["']?([@a-zA-Z][\w@/.-]*)["']?\s*:\s*(?:\[\s*)?["']?(off|warn|error|0|1|2)["']?(?=["'\s,\]}]|$)/;

const ESLINT_FILES = [
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
];

function deriveEslint(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  const ci = strongestEnforcement(escalations, "eslint");
  // ESLint's own exit code is the mechanism, so a `warn` binds only when the run caps warnings.
  const warningsBind = ci?.mode === "max-warnings-zero";

  for (const rel of ESLINT_FILES) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    const found = rel.endsWith(".yml") || rel.endsWith(".yaml")
      ? eslintFromYaml(file)
      : eslintFromLines(file);
    for (const rule of found) emitEslintRule(sink, rel, rule, warningsBind, ci);
  }

  const pkg = loadSource(dir, "package.json");
  if (pkg && /"eslintConfig"/.test(pkg.text)) {
    sink.read("package.json");
    // Scoped to the eslintConfig block so `"dependencies": { "eslint": "9" }` is not read as a rule.
    const start = pkg.lines.findIndex((l) => /"eslintConfig"\s*:/.test(l));
    if (start >= 0) {
      for (const rule of eslintFromLines(pkg, start + 1)) {
        emitEslintRule(sink, "package.json", rule, warningsBind, ci);
      }
    }
  }
}

interface EslintRule {
  name: string;
  severity: "off" | "warn" | "error";
  line: number;
  text: string;
}

function eslintFromLines(file: SourceFile, fromLine = 1): EslintRule[] {
  const out: EslintRule[] = [];
  for (let i = fromLine - 1; i < file.lines.length; i++) {
    const raw = file.lines[i]!;
    const match = ESLINT_RULE_LINE.exec(raw);
    if (!match) continue;
    const severity = ESLINT_SEVERITY[match[2]!];
    if (!severity) continue;
    // A bare identifier with no `/`, `@` or `-` is far more likely to be an ordinary option than a
    // rule name; requiring one of those keeps `strict: "error"`-shaped options out. `strict` itself
    // is a real ESLint rule, so it is allowed through explicitly.
    const name = match[1]!;
    if (!/[-/@.]/.test(name) && name !== "strict" && name !== "eqeqeq" && name !== "curly") continue;
    out.push({ name, severity, line: i + 1, text: raw.trim() });
  }
  return out;
}

function eslintFromYaml(file: SourceFile): EslintRule[] {
  const rules = mapEntry(parseYaml(file), "rules");
  if (!rules || rules.value.kind !== "map") return [];
  const out: EslintRule[] = [];
  for (const entry of rules.value.entries) {
    const raw = severityOf(entry.value);
    const severity = raw ? ESLINT_SEVERITY[raw] : undefined;
    if (!severity) continue;
    out.push({ name: entry.key, severity, line: entry.line, text: (file.lines[entry.line - 1] ?? "").trim() });
  }
  return out;
}

function severityOf(node: YamlNode): string | null {
  if (node.kind === "scalar") return node.value;
  if (node.kind === "seq" && node.items[0]?.kind === "scalar") return node.items[0].value;
  return null;
}

function emitEslintRule(
  sink: RuleSink,
  rel: string,
  rule: EslintRule,
  warningsBind: boolean,
  ci: ToolEnforcement | null,
): void {
  // `off` is the absence of a rule. Emitting it would fill the store with non-rules and, worse,
  // make "we have a rule about this" true for something deliberately disabled.
  if (rule.severity === "off") return;
  const binding = rule.severity === "error" || warningsBind;
  const candidate: RuleCandidate = {
    subject: `lint/eslint/${rule.name}`,
    predicate: "severity",
    object: {
      tool: "eslint",
      rule: rule.name,
      severity: rule.severity,
      config: rel,
      ci_command: ci?.command ?? null,
    },
    claim: `ESLint rule \`${rule.name}\` is set to ${rule.severity} in \`${rel}\``,
    kind: "rule",
    binding,
    locator: `${rel}:${rule.line}`,
    enforcerText: rule.text,
    why: binding
      ? undefined
      : "eslint exits 0 on warnings, and no CI invocation passes --max-warnings 0",
  };
  if (binding && rule.severity === "warn" && ci) candidate.enforcedBy = ci.locator;
  sink.add(candidate);
}

// ---------------------------------------------------------------------------------------
// Clippy and Rust lint levels

const RUST_LEVELS: Record<string, "allow" | "warn" | "deny" | "forbid"> = {
  allow: "allow",
  warn: "warn",
  deny: "deny",
  forbid: "forbid",
};

/** `clippy.toml` keys that are themselves a ban list rather than a threshold. */
const CLIPPY_BAN_KEYS: Record<string, true> = {
  "disallowed-methods": true,
  "disallowed-types": true,
  "disallowed-macros": true,
  "disallowed-names": true,
};

function deriveClippy(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  const ci = strongestEnforcement(escalations, "clippy");
  const denyWarnings = ci?.mode === "deny-warnings";

  for (const rel of ["clippy.toml", ".clippy.toml"]) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    const doc = parseToml(file);
    for (const entry of doc.entries) {
      if (CLIPPY_BAN_KEYS[entry.key]) {
        // Each entry of a `disallowed-*` list is a separate ban and is written on its own line, so
        // each one can cite that line. This is the only list in the whole subsystem that is
        // expanded per element, because each element genuinely is its own rule.
        const items = asStringArray(entry.value);
        for (const [index, item] of items.entries()) {
          const target = typeof item === "string" ? item : String(item);
          const line = entry.elementLines[index] ?? entry.line;
          sink.add({
            subject: `lint/clippy/${entry.key}/${target}`,
            predicate: "disallowed",
            object: { tool: "clippy", list: entry.key, target, config: rel },
            claim: `clippy \`${entry.key}\` bans \`${target}\``,
            kind: "rule",
            // `clippy::disallowed_methods` is warn-by-default, so the ban only fails a build when
            // warnings are denied. Saying otherwise would be the exact overclaim this file guards.
            binding: denyWarnings,
            locator: `${rel}:${line}`,
            enforcerText: (file.lines[line - 1] ?? "").trim(),
            why: denyWarnings
              ? undefined
              : "clippy::disallowed_* is warn-by-default and nothing in CI denies warnings",
            enforcedBy: denyWarnings ? ci?.locator : undefined,
          });
        }
        continue;
      }
      sink.add({
        subject: `lint/clippy/${entry.key}`,
        predicate: "configured",
        object: { tool: "clippy", setting: entry.key, value: entry.value, config: rel },
        claim: `clippy is configured with \`${entry.key} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        binding: denyWarnings,
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why: denyWarnings ? undefined : "the lints this configures are warn-by-default and CI does not deny warnings",
        enforcedBy: denyWarnings ? ci?.locator : undefined,
      });
    }
  }

  // `[lints]` tables: the declarative, per-crate way to set a level. This is where a real `deny`
  // lives, and unlike a command-line flag it is committed and reviewable.
  for (const rel of walk(dir, { basenames: ["Cargo.toml"], maxDepth: 3 })) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    const doc = parseToml(file);
    let touched = false;
    for (const entry of doc.entries) {
      const table = /^(?:workspace\.)?lints(?:\.(rust|clippy|rustdoc))?$/.exec(entry.table);
      if (!table) continue;
      const namespace = table[1] ?? (entry.key.includes("::") ? entry.key.split("::")[0]! : "rust");
      const lint = entry.key.replace(/^(?:clippy|rustdoc|rust)::/, "");
      const level = levelOf(entry.value);
      if (!level) continue;
      touched = true;
      emitRustLevel(sink, rel, file, namespace, lint, level, entry.line, ci, denyWarnings);
    }
    if (touched) sink.read(rel);
  }

  // Crate-level attributes. `#![deny(clippy::unwrap_used)]` fails the build, full stop — no CI
  // invocation needed, which makes it the strongest form of lint enforcement in a Rust repo.
  for (const rel of walk(dir, { basenames: ["lib.rs", "main.rs"], maxDepth: 4 })) {
    if (!/(^|\/)src\/(lib|main)\.rs$/.test(rel)) continue;
    const file = loadSource(dir, rel);
    if (!file) continue;
    let touched = false;
    for (let i = 0; i < file.lines.length; i++) {
      const raw = file.lines[i]!;
      // Inner attributes only appear at the top of a crate root; stopping at the first item keeps
      // this from scanning entire files and from picking up per-function `#[allow]`.
      if (/^\s*(pub\s+)?(fn|struct|enum|impl|trait|mod|use)\b/.test(raw)) break;
      const attr = /^\s*#!\[(deny|warn|forbid|allow)\(([^)]*)\)\]/.exec(raw);
      if (!attr) continue;
      const level = RUST_LEVELS[attr[1]!]!;
      for (const lint of attr[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        const namespace = lint.includes("::") ? lint.split("::")[0]! : "rust";
        touched = true;
        emitRustLevel(
          sink,
          rel,
          file,
          namespace,
          lint.replace(/^(?:clippy|rustdoc|rust)::/, ""),
          level,
          i + 1,
          ci,
          denyWarnings,
        );
      }
    }
    if (touched) sink.read(rel);
  }
}

function levelOf(value: TomlValue): "allow" | "warn" | "deny" | "forbid" | null {
  if (typeof value === "string") return RUST_LEVELS[value] ?? null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const level = (value as Record<string, TomlValue>).level;
    if (typeof level === "string") return RUST_LEVELS[level] ?? null;
  }
  return null;
}

function emitRustLevel(
  sink: RuleSink,
  rel: string,
  file: SourceFile,
  namespace: string,
  lint: string,
  level: "allow" | "warn" | "deny" | "forbid",
  line: number,
  ci: ToolEnforcement | null,
  denyWarnings: boolean,
): void {
  if (level === "allow") return;
  const binding = level === "deny" || level === "forbid" || denyWarnings;
  sink.add({
    subject: `lint/${namespace === "rust" ? "rustc" : namespace}/${lint}`,
    predicate: "severity",
    object: { tool: namespace, rule: lint, severity: level, config: rel },
    claim: `\`${namespace}::${lint}\` is set to ${level} in \`${rel}\``,
    kind: "rule",
    binding,
    locator: `${rel}:${line}`,
    enforcerText: (file.lines[line - 1] ?? "").trim(),
    why: binding ? undefined : "a warn-level lint prints and exits zero; nothing in CI denies warnings",
    enforcedBy: binding && level === "warn" ? ci?.locator : undefined,
  });
}

// ---------------------------------------------------------------------------------------
// rustfmt

/** Settings that make rustfmt itself exit non-zero, independent of how it is invoked. */
const RUSTFMT_SELF_FAILING: Record<string, true> = {
  error_on_line_overflow: true,
  error_on_unformatted: true,
  required_version: true,
};

function deriveRustfmt(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  const ci = strongestEnforcement(escalations, "rustfmt");
  const checked = ci?.mode === "check";
  for (const rel of ["rustfmt.toml", ".rustfmt.toml"]) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    for (const entry of parseToml(file).entries) {
      const selfFailing = RUSTFMT_SELF_FAILING[entry.key] === true && entry.value !== false;
      const binding = selfFailing || checked;
      sink.add({
        subject: `format/rustfmt/${entry.key}`,
        predicate: "configured",
        object: {
          tool: "rustfmt",
          setting: entry.key,
          value: entry.value,
          config: rel,
          ci_command: ci?.command ?? null,
          scoped: ci?.scoped ?? [],
        },
        claim: `rustfmt is configured with \`${entry.key} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        binding,
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why: binding
          ? undefined
          : "rustfmt rewrites rather than fails; nothing in CI runs `cargo fmt --check`",
        enforcedBy: checked ? ci?.locator : undefined,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------
// Ruff

const RUFF_SELECT_KEYS: Record<string, true> = { select: true, "extend-select": true };

function deriveRuff(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  const ci = strongestEnforcement(escalations, "ruff");
  const files: Array<{ rel: string; prefix: string }> = [
    { rel: "ruff.toml", prefix: "" },
    { rel: ".ruff.toml", prefix: "" },
  ];
  for (const rel of walk(dir, { basenames: ["pyproject.toml"], maxDepth: 3 })) {
    files.push({ rel, prefix: "tool.ruff" });
  }

  for (const { rel, prefix } of files) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    const doc = parseToml(file);
    const scope = prefix.length > 0 ? prefix : null;
    let touched = false;

    for (const entry of doc.entries) {
      const table = scope
        ? entry.table === scope || entry.table.startsWith(`${scope}.`)
          ? entry.table.slice(scope.length).replace(/^\./, "")
          : null
        : entry.table;
      if (table === null) continue;
      // Only `lint.*` and the root carry rule selection; `format.*` is style, handled as settings.
      const inLintTable = table === "" || table === "lint";
      touched = true;

      if (inLintTable && RUFF_SELECT_KEYS[entry.key]) {
        for (const [index, code] of asStringArray(entry.value).entries()) {
          const line = entry.elementLines[index] ?? entry.line;
          sink.add({
            subject: `lint/ruff/${code}`,
            predicate: "severity",
            object: { tool: "ruff", rule: code, severity: "error", config: rel, selected_by: entry.key },
            claim: `ruff rule set \`${code}\` is selected in \`${rel}\``,
            kind: "rule",
            // Ruff has no warn level: a selected rule that fires is a diagnostic and `ruff check`
            // exits 1. Selection is the severity. `--exit-zero` is the only escape, and the
            // workflow deriver reports that as `advisory`.
            binding: ci?.mode !== "advisory",
            locator: `${rel}:${line}`,
            enforcerText: (file.lines[line - 1] ?? "").trim(),
            why: ci?.mode === "advisory" ? "the CI invocation passes --exit-zero" : undefined,
            enforcedBy: ci?.locator,
          });
        }
        continue;
      }
      if (inLintTable && (entry.key === "ignore" || entry.key === "extend-ignore")) continue;

      sink.add({
        subject: `lint/ruff/${table.length > 0 ? `${table}.` : ""}${entry.key}`,
        predicate: "configured",
        object: { tool: "ruff", setting: entry.key, value: entry.value, config: rel },
        claim: `ruff is configured with \`${entry.key} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        binding: ci !== null && ci.mode !== "advisory",
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why: ci ? undefined : "nothing in CI runs ruff, so violating this configuration fails nothing",
        enforcedBy: ci?.locator,
      });
    }
    if (touched) sink.read(rel);
  }
}

// ---------------------------------------------------------------------------------------
// pyproject: mypy, pytest, coverage

/**
 * `[tool.X]` settings that cause a non-zero exit when violated. Anything not on this list is
 * configuration rather than a gate, and is emitted as advisory with that stated.
 */
const PY_FAILING_SETTINGS: Record<string, true> = {
  "mypy.strict": true,
  "mypy.disallow_untyped_defs": true,
  "mypy.disallow_any_generics": true,
  "mypy.warn_unused_ignores": true,
  "mypy.warn_return_any": true,
  "mypy.no_implicit_optional": true,
  "coverage.report.fail_under": true,
  "pytest.ini_options.addopts": true,
  "pytest.ini_options.filterwarnings": true,
  "pytest.ini_options.required_plugins": true,
  "pytest.ini_options.minversion": true,
};

const PY_TOOLS: Record<string, string> = {
  mypy: "mypy",
  pytest: "pytest",
  coverage: "coverage",
  black: "black",
  isort: "isort",
  pyright: "pyright",
};

function derivePythonTools(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  for (const rel of walk(dir, { basenames: ["pyproject.toml", "setup.cfg", "mypy.ini"], maxDepth: 3 })) {
    if (!rel.endsWith("pyproject.toml")) continue;
    const file = loadSource(dir, rel);
    if (!file) continue;
    const doc = parseToml(file);
    let touched = false;
    for (const entry of doc.entries) {
      const match = /^tool\.([A-Za-z0-9_-]+)(?:\.(.+))?$/.exec(entry.table);
      if (!match) continue;
      const tool = PY_TOOLS[match[1]!];
      if (!tool) continue;
      const suffix = match[2] ? `${match[2]}.${entry.key}` : entry.key;
      const ci = strongestEnforcement(escalations, tool);
      const failing = PY_FAILING_SETTINGS[`${tool}.${suffix}`] === true;
      const binding = failing && ci !== null && ci.mode !== "advisory";
      touched = true;
      sink.add({
        subject: `lint/${tool}/${suffix}`,
        predicate: "configured",
        object: { tool, setting: suffix, value: entry.value, config: rel, ci_command: ci?.command ?? null },
        claim: `${tool} is configured with \`${suffix} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        binding,
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why: binding
          ? undefined
          : ci
            ? "this setting configures the tool rather than causing it to exit non-zero"
            : `nothing in CI runs ${tool}, so violating this fails nothing`,
        enforcedBy: binding ? ci?.locator : undefined,
      });
    }
    if (touched) sink.read(rel);
  }
}

// ---------------------------------------------------------------------------------------
// typos

function deriveTypos(dir: string, sink: RuleSink, escalations: readonly CiEscalation[]): void {
  const ci = strongestEnforcement(escalations, "typos");
  for (const rel of [".typos.toml", "typos.toml", "_typos.toml"]) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    const doc = parseToml(file);
    for (const entry of doc.entries) {
      const values = asStringArray(entry.value);
      sink.add({
        subject: `lint/typos/${entry.table.length > 0 ? `${entry.table}.` : ""}${entry.key}`,
        predicate: "configured",
        object: {
          tool: "typos",
          setting: entry.key,
          table: entry.table,
          value: entry.value,
          entries: values.length > 1 ? values.length : undefined,
          config: rel,
        },
        claim:
          values.length > 1
            ? `typos \`${entry.key}\` carries ${values.length} entries in \`${rel}\``
            : `typos is configured with \`${entry.key} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        binding: ci !== null && ci.mode !== "advisory",
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why: ci ? undefined : "nothing in CI runs typos, so this waiver list gates nothing",
        enforcedBy: ci?.locator,
      });
    }
  }
}
