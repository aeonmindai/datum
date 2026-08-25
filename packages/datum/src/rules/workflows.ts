import { loadSource, walk, type SourceFile } from "./source.js";
import { mapEntry, parseYaml, scalarAt, stringList, type YamlMap, type YamlNode } from "./yaml.js";
import { RuleSink } from "./types.js";

/**
 * GitHub Actions is the strongest enforcement source in most repos, for the reason the design doc
 * gives: a failing job is enforcement. So every job becomes a binding rule unless the workflow
 * explicitly declares it cannot fail the run (`continue-on-error: true`), and the specific
 * mechanisms inside a job — `exit 1`, `if: failure()`, a threshold comparison — become rules of
 * their own citing the exact script line they live on.
 *
 * The by-product that the lint deriver depends on: a CI invocation can promote an advisory lint to a
 * binding one. `cargo clippy -- -D warnings` means a warn-level lint now fails a job, and
 * `eslint --max-warnings 0` means the same for JavaScript. Recording those escalations here is what
 * lets `binding` stay mechanical instead of becoming a per-tool guess.
 */

/** A CI invocation that changes what a lint config means. Consumed by the lint deriver. */
export interface CiEscalation {
  /** `clippy`, `rustfmt`, `eslint`, `ruff`, `typos`, `prettier`, `mypy`, `cargo`, `typescript`. */
  tool: string;
  /**
   * `deny-warnings` — warnings become errors.
   * `max-warnings-zero` — warnings fail the run.
   * `check` — the tool runs in verify mode and a diff fails.
   * `run` — the tool runs, so its own error-level findings fail the run.
   * `advisory` — the tool runs but is explicitly prevented from failing.
   */
  mode: "deny-warnings" | "max-warnings-zero" | "check" | "run" | "advisory";
  locator: string;
  /** The command as reconstructed, for evidence. */
  command: string;
  /** Packages or paths the invocation was scoped to; empty means "everything". */
  scoped: string[];
}

export interface WorkflowDerivation {
  escalations: CiEscalation[];
  /** Job ids by display name and by id, so branch protection can resolve a required check to a line. */
  jobLocators: Record<string, string>;
}

interface Command {
  text: string;
  locator: string;
}

/**
 * Shell constructs that make a step fail. A threshold comparison is included because it is how a
 * numeric policy is actually written — `[ "${n}" -ne "${EXPECTED_LANES}" ]` is a rule that the lane
 * count must be exactly nine, and nothing else in the repo says so.
 *
 * `[^\]]` rather than `[^]]`: JavaScript tokenises the latter as "any character" followed by a
 * literal `]`, which silently matches almost everything.
 */
const EXIT_NONZERO = /(?:^\s*|[;&|]\s*|\bthen\s+|\bdo\s+|\belse\s+)exit\s+([1-9]\d*)\b/;
const THRESHOLD = /(?:\[\[?[^\]]*\s(-ne|-eq|-gt|-lt|-ge|-le|!=)\s|\(\(\s*[^)]*(<=|>=|<|>|!=|==))/;

/**
 * The binaries a shell line actually invokes, as opposed to merely mentions.
 *
 * Without this, `rustup component add rustfmt` reads as a formatting gate and the repo acquires a
 * binding rule that does not exist. Leading `VAR=value` assignments are skipped (`RUSTFLAGS=...
 * cargo build`) and runner prefixes are unwrapped (`npx eslint`, `python -m mypy`).
 */
const COMMAND_HEAD =
  /(?:^|[;&|(]|\bthen\b|\bdo\b|\belse\b)\s*((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*)((?:npx|bunx|pnpm(?:\s+exec)?|yarn|uv\s+run|poetry\s+run|python3?\s+-m|sudo)\s+)*([A-Za-z0-9_@./+-]+)/g;

function invokedBinaries(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(COMMAND_HEAD)) {
    const binary = match[3] ?? "";
    const base = binary.slice(binary.lastIndexOf("/") + 1);
    if (base.length > 0) out.push(base);
  }
  return out;
}

export function deriveWorkflowRules(dir: string, sink: RuleSink): WorkflowDerivation {
  const escalations: CiEscalation[] = [];
  const jobLocators: Record<string, string> = {};

  for (const rel of walk(dir, { only: [".github/workflows"], extensions: [".yml", ".yaml"] })) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    sink.read(rel);
    const doc = parseYaml(file);
    const stem = rel.replace(/^.*\//, "").replace(/\.ya?ml$/, "");

    const on = mapEntry(doc, "on") ?? mapEntry(doc, true as unknown as string);
    // YAML 1.1 reads a bare `on` as the boolean true, which is why some tools see `on: true`. This
    // parser keeps keys as written, so only the literal key needs handling.
    const triggers = on ? triggerNames(on.value) : [];
    if (on && triggers.length > 0) {
      sink.add({
        subject: `ci/${stem}`,
        predicate: "triggers",
        object: { workflow: rel, events: triggers },
        claim: `\`${rel}\` runs on ${triggers.join(", ")}`,
        kind: "constraint",
        binding: true,
        locator: `${rel}:${on.line}`,
        enforcerText: file.lines[on.line - 1] ?? "",
      });
    }

    for (const entry of doc.entries) {
      if (entry.key !== "permissions") continue;
      // A workflow-level permission block is enforced by GitHub itself: a step that tries to write
      // where the token is read-only gets a 403. That is a real ceiling, not documentation.
      if (entry.value.kind !== "map") continue;
      for (const perm of entry.value.entries) {
        if (perm.value.kind !== "scalar") continue;
        sink.add({
          subject: `ci/${stem}/permission/${perm.key}`,
          predicate: "granted",
          object: { workflow: rel, permission: perm.key, level: perm.value.value },
          claim: `\`${rel}\` grants its token \`${perm.key}: ${perm.value.value}\``,
          kind: "constraint",
          binding: true,
          locator: `${rel}:${perm.line}`,
          enforcerText: file.lines[perm.line - 1] ?? "",
        });
      }
    }

    const jobsEntry = mapEntry(doc, "jobs");
    if (!jobsEntry || jobsEntry.value.kind !== "map") continue;

    for (const job of jobsEntry.value.entries) {
      const jobNode = job.value;
      const displayName = scalarAt(jobNode, "name")?.value ?? job.key;
      const continueOnError = scalarAt(jobNode, "continue-on-error")?.value === "true";
      const needs = stringList(mapEntry(jobNode, "needs")?.value);
      const runsOn = mapEntry(jobNode, "runs-on");
      const locator = `${rel}:${job.line}`;
      jobLocators[job.key] = locator;
      jobLocators[displayName] = locator;

      sink.add({
        subject: `ci/${stem}/${job.key}`,
        predicate: "must_pass",
        object: {
          workflow: rel,
          job: job.key,
          name: displayName,
          events: triggers,
          needs,
          runs_on: runsOn ? stringList(runsOn.value) : [],
          continue_on_error: continueOnError,
        },
        claim: continueOnError
          ? `CI job \`${displayName}\` (${rel}) runs but is marked continue-on-error, so failing it fails nothing`
          : `CI job \`${displayName}\` (${rel}) must succeed`,
        kind: "rule",
        binding: !continueOnError,
        locator,
        enforcerText: file.lines[job.line - 1] ?? "",
        why: continueOnError
          ? "continue-on-error: true — the workflow declares this job cannot fail the run"
          : undefined,
      });

      if (needs.length > 0) {
        const needsEntry = mapEntry(jobNode, "needs")!;
        sink.add({
          subject: `ci/${stem}/${job.key}`,
          predicate: "requires_jobs",
          object: { workflow: rel, job: job.key, needs, count: needs.length },
          claim: `CI job \`${displayName}\` aggregates ${needs.length} lanes: ${needs.join(", ")}`,
          kind: "constraint",
          binding: !continueOnError,
          locator: `${rel}:${needsEntry.line}`,
          enforcerText: file.lines[needsEntry.line - 1] ?? "",
        });
      }

      const steps = mapEntry(jobNode, "steps");
      if (!steps || steps.value.kind !== "seq") continue;

      let gateIndex = 0;
      for (const [index, step] of steps.value.items.entries()) {
        if (step.kind !== "map") continue;
        const stepName = scalarAt(step, "name")?.value ?? `step ${index + 1}`;
        const stepSkipsFailure = scalarAt(step, "continue-on-error")?.value === "true";

        const condition = scalarAt(step, "if");
        if (condition && /\b(failure|cancelled)\s*\(\s*\)/.test(condition.value)) {
          gateIndex++;
          sink.add({
            subject: `ci/${stem}/${job.key}/gate/${gateIndex}`,
            predicate: "fails_when",
            object: {
              workflow: rel,
              job: job.key,
              step: stepName,
              mechanism: "if-failure",
              expression: condition.value,
            },
            claim: `\`${displayName}\` runs "${stepName}" only when something already failed`,
            kind: "rule",
            binding: !continueOnError && !stepSkipsFailure,
            locator: `${rel}:${condition.line}`,
            enforcerText: file.lines[condition.line - 1] ?? "",
          });
        }

        const run = mapEntry(step, "run");
        // Both forms: a `run: |` block and a one-line `run: test -f x || exit 1`. For the inline
        // form the scalar's line is the key's own line, so the arithmetic below still lands right.
        if (run && run.value.kind === "scalar") {
          const scriptLines = run.value.value.split("\n");
          const errexit = scriptLines.some((l) => /^\s*set\s+-[a-z]*e/.test(l));
          for (const [offset, scriptLine] of scriptLines.entries()) {
            const lineNo = run.value.line + offset;
            const exit = EXIT_NONZERO.exec(scriptLine);
            const threshold = THRESHOLD.exec(scriptLine);
            if (!exit && !threshold) continue;
            gateIndex++;
            sink.add({
              subject: `ci/${stem}/${job.key}/gate/${gateIndex}`,
              predicate: "fails_when",
              object: {
                workflow: rel,
                job: job.key,
                step: stepName,
                mechanism: exit ? "exit-nonzero" : "threshold",
                operator: threshold ? (threshold[1] ?? threshold[2] ?? null) : null,
                exit_code: exit ? Number(exit[1]) : null,
                expression: scriptLine.trim(),
                errexit,
              },
              claim: exit
                ? `\`${displayName}\` exits ${exit[1]} at ${rel}:${lineNo}`
                : `\`${displayName}\` compares against a threshold at ${rel}:${lineNo} and fails if it does not hold`,
              kind: "rule",
              binding: !continueOnError && !stepSkipsFailure,
              locator: `${rel}:${lineNo}`,
              enforcerText: scriptLine.trim(),
            });
          }
        }

        for (const command of commandsIn(step, run?.value, rel)) {
          const escalation = classify(command, !continueOnError && !stepSkipsFailure);
          if (!escalation) continue;
          escalations.push(escalation);
          sink.add({
            subject: `ci/${stem}/${job.key}/tool/${escalation.tool}`,
            predicate: "enforces",
            object: {
              workflow: rel,
              job: job.key,
              step: stepName,
              tool: escalation.tool,
              mode: escalation.mode,
              command: escalation.command,
              scoped: escalation.scoped,
            },
            claim: `\`${displayName}\` runs ${escalation.tool} (${escalation.mode})`,
            kind: "rule",
            binding: escalation.mode !== "advisory" && !continueOnError && !stepSkipsFailure,
            locator: escalation.locator,
            enforcerText: escalation.command,
            why:
              escalation.mode === "advisory"
                ? "the invocation is explicitly prevented from failing the run"
                : undefined,
          });
        }
      }
    }
  }

  return { escalations, jobLocators };
}

function triggerNames(node: YamlNode): string[] {
  if (node.kind === "map") return node.entries.map((e) => e.key);
  return stringList(node);
}

/**
 * Every command a step actually runs, with a line for each.
 *
 * Two shapes matter: a `run:` script, where each line is a command, and an action invocation, where
 * the command is assembled from `with:`. `actions-rs/cargo` is handled explicitly because Arc's CI
 * expresses `cargo clippy -- -D warnings` that way, and a text scan of the YAML would never see it.
 */
function commandsIn(step: YamlMap, run: YamlNode | undefined, rel: string): Command[] {
  const out: Command[] = [];
  if (run && run.kind === "scalar") {
    for (const [offset, line] of run.value.split("\n").entries()) {
      const text = line.trim();
      if (text.length === 0 || text.startsWith("#")) continue;
      out.push({ text, locator: `${rel}:${run.line + offset}` });
    }
  }

  const uses = scalarAt(step, "uses");
  if (!uses) return out;
  const action = uses.value.replace(/@.*$/, "");
  const withEntry = mapEntry(step, "with");
  const withNode = withEntry?.value;

  if (/^actions-rs\/cargo$/.test(action) || /^(taiki-e|clechasseur)\/.*cargo/.test(action)) {
    const command = scalarAt(withNode, "command");
    if (!command) return out;
    const args = scalarAt(withNode, "args");
    out.push({
      text: `cargo ${command.value} ${args?.value ?? ""}`.trim(),
      locator: `${rel}:${args?.line ?? command.line}`,
    });
    return out;
  }

  if (/typos/.test(action)) {
    const config = scalarAt(withNode, "config");
    out.push({
      text: `typos ${config ? `--config ${config.value}` : ""}`.trim(),
      locator: `${rel}:${uses.line}`,
    });
    return out;
  }

  if (/eslint/.test(action)) {
    out.push({ text: `eslint ${scalarAt(withNode, "args")?.value ?? ""}`.trim(), locator: `${rel}:${uses.line}` });
    return out;
  }

  // Any other action: nothing is inferred. Guessing what a third-party action enforces from its
  // name is how a store starts publishing claims it cannot support.
  return out;
}

function classify(command: Command, canFail: boolean): CiEscalation | null {
  const text = command.text;
  const heads = invokedBinaries(text);
  const scoped = [...text.matchAll(/(?:^|\s)-p\s+([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!);
  const explicitlyAdvisory = /(--exit-zero|\|\|\s*true|\|\|\s*:\s*$)/.test(text);
  const mode = (preferred: CiEscalation["mode"]): CiEscalation["mode"] =>
    explicitlyAdvisory || !canFail ? "advisory" : preferred;
  const built = (tool: string, m: CiEscalation["mode"]): CiEscalation => ({
    tool,
    mode: mode(m),
    locator: command.locator,
    command: text,
    scoped,
  });

  if (heads.includes("cargo")) {
    if (/\bcargo\s+clippy\b/.test(text)) {
      // `-D warnings` is the single most consequential flag in this whole subsystem: it converts
      // every warn-level clippy lint in the scoped packages into something that fails a job, which
      // is exactly the line between a rule and advice.
      const denies = /-D\s*warnings|--deny[= ]+warnings|-Dclippy::/.test(text);
      return built("clippy", denies ? "deny-warnings" : "run");
    }
    if (/\bcargo\s+fmt\b/.test(text)) {
      return built("rustfmt", /--check|--emit\s+diff/.test(text) ? "check" : "run");
    }
    if (/\bcargo\s+deny\b/.test(text)) return built("cargo-deny", "run");
    if (/\bcargo\s+(check|build|test|doc|bench)\b/.test(text)) return built("cargo", "run");
    return null;
  }
  if (heads.includes("rustfmt")) {
    return built("rustfmt", /--check|--emit\s+diff/.test(text) ? "check" : "run");
  }
  if (heads.includes("eslint")) {
    // ESLint exits 0 on warnings by default, so a `warn` rule fails nothing — unless the run caps
    // warnings at zero, which promotes every one of them.
    return built("eslint", /--max-warnings[= ]+0\b/.test(text) ? "max-warnings-zero" : "run");
  }
  if (heads.includes("ruff")) {
    if (!/\bruff\s+(check|format)\b/.test(text)) return null;
    return built("ruff", /\bformat\b/.test(text) && /--check|--diff/.test(text) ? "check" : "run");
  }
  if (heads.includes("typos")) return built("typos", "run");
  if (heads.includes("prettier")) {
    if (!/--check|--list-different/.test(text)) return null;
    return built("prettier", "check");
  }
  if (heads.includes("tsc")) return built("typescript", "run");
  if (heads.includes("mypy")) return built("mypy", "run");
  if (heads.includes("black")) {
    if (!/--check/.test(text)) return null;
    return built("black", "check");
  }
  return null;
}
