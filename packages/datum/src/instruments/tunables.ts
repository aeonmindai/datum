import { loadSource, walk } from "../rules/source.js";
import { entriesIn, parseToml, tablesUnder } from "../rules/toml.js";
import { mapEntry, parseYaml, scalarAt } from "../rules/yaml.js";
import type { FactCandidate } from "./types.js";

/**
 * Config tunables `src/rules` deliberately leaves on the floor.
 *
 * `src/rules/manifests.ts` already claims `Cargo.toml`'s `[profile.*]`, `rust-version` and pinned
 * git revs; `src/rules/workflows.ts` already claims CI jobs, permissions and gates. None of that
 * is re-derived here — two subsystems asserting the same `(subject, predicate)` from the same file
 * is the second convention this repo forbids, and it would make the coverage delta a fiction.
 *
 * What is genuinely unclaimed, and is knowledge somebody would ask about:
 *
 * - `.cargo/config.toml` — the flags every compilation actually runs with. Arc's says
 *   `target-cpu=native`, which is why a binary built on the rental does not necessarily run on
 *   the box, and nothing in the repo records that as a fact.
 * - `timeout-minutes` — a hard wall on a CI job. `src/rules` records that a job must pass; it
 *   does not record that the job is killed at 20 minutes, which is the number a person asks for.
 */

/** Where cargo's own build configuration lives, in precedence order as cargo reads them. */
const CARGO_CONFIGS = [".cargo/config.toml", ".cargo/config"] as const;

export function readTunableFacts(dir: string): FactCandidate[] {
  const out: FactCandidate[] = [];
  readCargoConfig(dir, out);
  readWorkflowTimeouts(dir, out);
  return out;
}

function readCargoConfig(dir: string, out: FactCandidate[]): void {
  for (const rel of CARGO_CONFIGS) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    const doc = parseToml(file);

    // `[build]` plus every `[target.<triple>]`. Other tables (`[alias]`, `[registries]`) describe
    // convenience and credentials, not what the compiler does, so they are not facts about the
    // artifact and are skipped.
    const tables = ["build", ...tablesUnder(doc, "target")];
    for (const table of tables) {
      for (const entry of entriesIn(doc, table)) {
        const value = entry.value;
        const rendered = Array.isArray(value) ? value.map(String).join(" ") : String(value);
        if (rendered.trim().length === 0) continue;
        const target = table === "build" ? "every target" : table.slice("target.".length);
        out.push({
          subject: `cargo/config/${table}/${entry.key}`,
          predicate: "set_to",
          object: {
            file: rel,
            table,
            key: entry.key,
            target,
            value: Array.isArray(value) ? value.map(String) : value,
          },
          claim: `cargo builds ${target} with \`${entry.key} = ${rendered}\` (${rel})`,
          // A compiler flag configures the build. Setting it differently produces a different
          // binary; it does not fail anything. `state`, on the same test `[profile.*]` gets in
          // `src/rules/manifests.ts`.
          kind: "state",
          binding: false,
          locator: `${rel}:${entry.line}`,
        });
      }
    }
  }
}

function readWorkflowTimeouts(dir: string, out: FactCandidate[]): void {
  for (const rel of walk(dir, { extensions: [".yml", ".yaml"], only: [".github/workflows"] })) {
    const file = loadSource(dir, rel);
    if (!file) continue;
    const stem = rel.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
    const jobs = mapEntry(parseYaml(file), "jobs");
    if (!jobs || jobs.value.kind !== "map") continue;

    for (const job of jobs.value.entries) {
      const displayName = scalarAt(job.value, "name")?.value ?? job.key;
      const jobTimeout = scalarAt(job.value, "timeout-minutes");
      if (jobTimeout) {
        emitTimeout(out, {
          subject: `ci/${stem}/${job.key}`,
          rel,
          stem,
          job: job.key,
          step: null,
          label: `CI job \`${displayName}\``,
          minutes: jobTimeout.value,
          line: jobTimeout.line,
        });
      }

      const steps = mapEntry(job.value, "steps");
      if (!steps || steps.value.kind !== "seq") continue;
      for (const [index, step] of steps.value.items.entries()) {
        if (step.kind !== "map") continue;
        const stepTimeout = scalarAt(step, "timeout-minutes");
        if (!stepTimeout) continue;
        const stepName = scalarAt(step, "name")?.value ?? `step ${index + 1}`;
        emitTimeout(out, {
          subject: `ci/${stem}/${job.key}/step/${index + 1}`,
          rel,
          stem,
          job: job.key,
          step: stepName,
          label: `\`${displayName}\` step "${stepName}"`,
          minutes: stepTimeout.value,
          line: stepTimeout.line,
        });
      }
    }
  }
}

function emitTimeout(
  out: FactCandidate[],
  args: {
    subject: string;
    rel: string;
    stem: string;
    job: string;
    step: string | null;
    label: string;
    minutes: string;
    line: number;
  },
): void {
  const minutes = Number(args.minutes);
  // `timeout-minutes: ${{ inputs.t }}` is a real workflow line and an unknowable number. Recording
  // the expression as if it were a limit would put a string where a bound belongs.
  if (!Number.isFinite(minutes)) return;

  out.push({
    subject: args.subject,
    predicate: "timeout_minutes",
    object: {
      workflow: args.rel,
      job: args.job,
      step: args.step,
      minutes,
    },
    claim: `${args.label} is killed after ${minutes} minutes (${args.rel})`,
    // GitHub cancels the job at the limit and the run fails. Violating it fails something, so it
    // binds — the same mechanical test `src/rules` applies.
    kind: "constraint",
    binding: true,
    locator: `${args.rel}:${args.line}`,
  });
}
