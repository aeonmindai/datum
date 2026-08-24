import { loadSource, walk, type SourceFile } from "./source.js";
import { asStringArray, parseToml, tablesUnder, type TomlValue } from "./toml.js";
import { RuleSink } from "./types.js";

/**
 * Cargo, npm and toolchain manifests.
 *
 * The distinction this file has to keep straight is between a *setting* and a *rule*. `opt-level = 3`
 * configures a build; nothing can violate it. `overflow-checks = true` makes arithmetic overflow
 * panic at runtime, `rust-version` makes cargo refuse to build on an older toolchain, and a pinned
 * `rev` makes a moving upstream branch unable to change what compiles. Those fail something, so they
 * bind; the rest are emitted as constraints that say plainly they configure rather than enforce.
 */

/** `[profile.*]` keys whose violation is a runtime or build failure rather than a preference. */
const FAILING_PROFILE_KEYS: Record<string, true> = {
  "overflow-checks": true,
  "debug-assertions": true,
  panic: true,
};

const PROFILE_ENFORCEMENT: Record<string, string> = {
  "overflow-checks": "arithmetic overflow panics at runtime instead of wrapping",
  "debug-assertions": "debug_assert! fires at runtime",
  panic: "the panic strategy is compiled in and cannot be overridden downstream",
};

export function deriveManifestRules(dir: string, sink: RuleSink): void {
  deriveCargo(dir, sink);
  deriveToolchain(dir, sink);
  deriveCargoDeny(dir, sink);
  deriveNpm(dir, sink);
}

function deriveCargo(dir: string, sink: RuleSink): void {
  for (const rel of walk(dir, { basenames: ["Cargo.toml"], maxDepth: 3 })) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    const doc = parseToml(file);
    let touched = false;

    for (const table of tablesUnder(doc, "profile")) {
      const profile = table.slice("profile.".length);
      if (profile.length === 0) continue;
      for (const entry of doc.entries) {
        if (entry.table !== table) continue;
        const failing = FAILING_PROFILE_KEYS[entry.key] === true && entry.value !== false;
        touched = true;
        sink.add({
          subject: `cargo/profile/${profile}/${entry.key}`,
          predicate: "set_to",
          object: { manifest: rel, profile, key: entry.key, value: entry.value },
          claim: `cargo profile \`${profile}\` sets \`${entry.key} = ${JSON.stringify(entry.value)}\``,
          kind: "constraint",
          binding: failing,
          locator: `${rel}:${entry.line}`,
          enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
          why: failing ? PROFILE_ENFORCEMENT[entry.key] : "this configures the build; nothing can violate it",
        });
      }
    }

    for (const entry of doc.entries) {
      if (entry.key === "rust-version" && typeof entry.value === "string") {
        touched = true;
        sink.add({
          subject: `cargo/msrv${entry.table.startsWith("workspace") ? "" : `/${rel}`}`,
          predicate: "minimum_rust_version",
          object: { manifest: rel, version: entry.value, table: entry.table },
          claim: `the minimum supported Rust version is ${entry.value}`,
          kind: "constraint",
          // cargo refuses to build a package whose `rust-version` exceeds the active toolchain.
          binding: true,
          locator: `${rel}:${entry.line}`,
          enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        });
        continue;
      }

      // Git dependencies pinned to an explicit rev. Arc's own manifest says why this is a rule and
      // not a detail: a branch pointer that advances under a merged PR turns a green build red with
      // no commit in this repo to blame.
      if (!/^(?:workspace\.)?dependencies$|^(?:target\..+\.)?dependencies$|^build-dependencies$/.test(entry.table)) {
        continue;
      }
      if (!entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) continue;
      const spec = entry.value as Record<string, TomlValue>;
      const git = typeof spec.git === "string" ? spec.git : null;
      if (!git) continue;
      const rev = typeof spec.rev === "string" ? spec.rev : null;
      const branch = typeof spec.branch === "string" ? spec.branch : null;
      const tag = typeof spec.tag === "string" ? spec.tag : null;
      touched = true;
      sink.add({
        subject: `cargo/dependency/${entry.key}`,
        predicate: "pinned_to",
        object: { manifest: rel, dependency: entry.key, git, rev, branch, tag },
        claim: rev
          ? `\`${entry.key}\` is pinned to ${git} at rev ${rev}`
          : `\`${entry.key}\` tracks ${git} at ${branch ?? tag ?? "the default branch"}`,
        kind: "constraint",
        // A rev or tag is immutable, so what compiles cannot change under you. A branch can, which
        // is the failure mode being described, so it is recorded but does not bind.
        binding: rev !== null || tag !== null,
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
        why:
          rev || tag
            ? undefined
            : "a branch pointer can advance under a merged commit, so this pins nothing",
      });
    }

    if (touched) sink.read(rel);
  }
}

function deriveToolchain(dir: string, sink: RuleSink): void {
  for (const rel of ["rust-toolchain.toml", "rust-toolchain"]) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    if (rel === "rust-toolchain") {
      // The legacy form is a bare channel name on the first non-empty line.
      const index = file.lines.findIndex((l) => l.trim().length > 0);
      if (index < 0) continue;
      sink.add({
        subject: "toolchain/rust/channel",
        predicate: "pinned_to",
        object: { manifest: rel, channel: file.lines[index]!.trim() },
        claim: `the Rust toolchain is pinned to ${file.lines[index]!.trim()}`,
        kind: "constraint",
        binding: true,
        locator: `${rel}:${index + 1}`,
        enforcerText: file.lines[index]!.trim(),
      });
      continue;
    }
    for (const entry of parseToml(file).entries) {
      if (entry.table !== "toolchain") continue;
      sink.add({
        subject: `toolchain/rust/${entry.key}`,
        predicate: entry.key === "channel" ? "pinned_to" : "requires",
        object: { manifest: rel, key: entry.key, value: entry.value },
        claim: `rustup is directed to use \`${entry.key} = ${JSON.stringify(entry.value)}\``,
        kind: "constraint",
        // rustup honours this file for every invocation in the tree; a different toolchain is not
        // merely discouraged, it is not what runs.
        binding: true,
        locator: `${rel}:${entry.line}`,
        enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
      });
    }
  }
}

function deriveCargoDeny(dir: string, sink: RuleSink): void {
  const file = loadSource(dir, "deny.toml");
  if (!file) return;
  sink.read("deny.toml");
  const doc = parseToml(file);
  for (const entry of doc.entries) {
    const section = entry.table;
    if (!/^(bans|licenses|advisories|sources)$/.test(section)) continue;

    if (entry.key === "deny" || entry.key === "allow" || entry.key === "skip") {
      const items = asStringArray(entry.value);
      for (const [index, item] of items.entries()) {
        const line = entry.elementLines[index] ?? entry.line;
        sink.add({
          subject: `supply-chain/${section}/${entry.key}/${item}`,
          predicate: entry.key === "deny" ? "denied" : entry.key === "allow" ? "allowed" : "waived",
          object: { config: "deny.toml", section, list: entry.key, target: item },
          claim: `cargo-deny ${entry.key}s \`${item}\` under [${section}]`,
          kind: "rule",
          binding: entry.key === "deny",
          locator: `deny.toml:${line}`,
          enforcerText: (file.lines[line - 1] ?? "").trim(),
          why: entry.key === "deny" ? undefined : "an allow or skip entry removes a check rather than adding one",
        });
      }
      continue;
    }

    if (typeof entry.value !== "string") continue;
    sink.add({
      subject: `supply-chain/${section}/${entry.key}`,
      predicate: "set_to",
      object: { config: "deny.toml", section, key: entry.key, value: entry.value },
      claim: `cargo-deny [${section}] sets \`${entry.key} = ${JSON.stringify(entry.value)}\``,
      kind: "constraint",
      // cargo-deny's own severity vocabulary: `deny` fails, `warn` and `allow` do not.
      binding: entry.value === "deny",
      locator: `deny.toml:${entry.line}`,
      enforcerText: (file.lines[entry.line - 1] ?? "").trim(),
      why: entry.value === "deny" ? undefined : `severity is ${entry.value}, which does not fail the check`,
    });
  }
}

function deriveNpm(dir: string, sink: RuleSink): void {
  const pkg = loadSource(dir, "package.json");
  if (pkg) {
    sink.read("package.json");
    const parsed = readJson(pkg);
    const engines = parsed?.engines;
    if (engines && typeof engines === "object" && !Array.isArray(engines)) {
      const strict = loadSource(dir, ".npmrc")?.text.includes("engine-strict=true") === true;
      for (const [name, range] of Object.entries(engines as Record<string, unknown>)) {
        if (typeof range !== "string") continue;
        const line = findKeyLine(pkg, name, findKeyLine(pkg, "engines", 1));
        if (line === 0) continue;
        sink.add({
          subject: `npm/engines/${name}`,
          predicate: "requires",
          object: { manifest: "package.json", engine: name, range, engine_strict: strict },
          claim: `\`${name}\` must satisfy ${range}`,
          kind: "constraint",
          // npm only warns about engines unless `engine-strict=true` turns the warning into a
          // refusal to install. That flag is the whole difference between rule and advice here.
          binding: strict,
          locator: `package.json:${line}`,
          enforcerText: (pkg.lines[line - 1] ?? "").trim(),
          why: strict ? undefined : "npm warns rather than fails unless .npmrc sets engine-strict=true",
          enforcedBy: strict ? ".npmrc" : undefined,
        });
      }
    }

    if (typeof parsed?.packageManager === "string") {
      const line = findKeyLine(pkg, "packageManager", 1);
      if (line > 0) {
        sink.add({
          subject: "npm/packageManager",
          predicate: "pinned_to",
          object: { manifest: "package.json", value: parsed.packageManager },
          claim: `the package manager is pinned to ${parsed.packageManager}`,
          kind: "constraint",
          // Corepack refuses to run a different manager version once this field is set.
          binding: true,
          locator: `package.json:${line}`,
          enforcerText: (pkg.lines[line - 1] ?? "").trim(),
        });
      }
    }

    const overrides = parsed?.overrides;
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      const from = findKeyLine(pkg, "overrides", 1);
      for (const [name, version] of Object.entries(overrides as Record<string, unknown>)) {
        if (typeof version !== "string") continue;
        const line = findKeyLine(pkg, name, from);
        if (line === 0) continue;
        sink.add({
          subject: `npm/override/${name}`,
          predicate: "forced_to",
          object: { manifest: "package.json", dependency: name, version },
          claim: `every transitive \`${name}\` is forced to ${version}`,
          kind: "rule",
          // The resolver applies an override unconditionally; a transitive dependency asking for
          // something else does not get it.
          binding: true,
          locator: `package.json:${line}`,
          enforcerText: (pkg.lines[line - 1] ?? "").trim(),
        });
      }
    }
  }

  const npmrc = loadSource(dir, ".npmrc");
  if (!npmrc) return;
  sink.read(".npmrc");
  for (const [index, raw] of npmrc.lines.entries()) {
    const line = raw.replace(/[;#].*$/, "").trim();
    const match = /^([A-Za-z0-9_@/.:-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    // Only settings that change whether an install can succeed. A registry URL or a cache path is
    // configuration, and emitting it as a rule would dilute the answer to "what are our rules".
    if (!/^(engine-strict|save-exact|package-lock|legacy-peer-deps|strict-peer-dependencies|audit-level|ignore-scripts)$/.test(key)) {
      continue;
    }
    sink.add({
      subject: `npm/config/${key}`,
      predicate: "set_to",
      object: { config: ".npmrc", key, value },
      claim: `npm is configured with \`${key}=${value}\``,
      kind: "constraint",
      binding: value === "true" || key === "audit-level",
      locator: `.npmrc:${index + 1}`,
      enforcerText: raw.trim(),
      why: value === "true" || key === "audit-level" ? undefined : "the setting is off",
    });
  }
}

function readJson(file: SourceFile): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(file.text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The 1-based line a JSON key is written on, at or after `from`, or 0 when it cannot be found.
 *
 * Locating the key by scanning rather than tracking offsets during a parse is deliberate: the value
 * comes from `JSON.parse`, so correctness of the data never depends on this scan, and a key whose
 * line cannot be found simply yields no rule instead of a rule with a guessed citation.
 */
export function findKeyLine(file: SourceFile, key: string, from: number): number {
  const needle = new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
  for (let i = Math.max(from - 1, 0); i < file.lines.length; i++) {
    if (needle.test(file.lines[i]!)) return i + 1;
  }
  return 0;
}
