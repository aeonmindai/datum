import { loadSource } from "../packages/datum/src/rules/source.js";
import { parseYaml, mapEntry, scalarAt, stringList } from "../packages/datum/src/rules/yaml.js";
const f = loadSource("/Users/jish/Documents/GitHub/arc", ".github/workflows/ci.yml")!;
const doc = parseYaml(f);
console.log("top keys:", doc.entries.map(e => `${e.key}@${e.line}`).join(", "));
const jobs = mapEntry(doc, "jobs")!.value;
if (jobs.kind !== "map") throw new Error("jobs not a map");
for (const j of jobs.entries) {
  const name = scalarAt(j.value, "name");
  const steps = mapEntry(j.value, "steps");
  const nsteps = steps && steps.value.kind === "seq" ? steps.value.items.length : 0;
  const needs = mapEntry(j.value, "needs");
  console.log(`  job ${j.key}@${j.line} name=${name?.value ?? "-"} steps=${nsteps} needs=${stringList(needs?.value).length}`);
}
const cc = mapEntry(jobs, "ci-complete")!.value;
const steps = mapEntry(cc, "steps")!;
if (steps.value.kind === "seq") {
  const s0 = steps.value.items[0]!;
  const run = mapEntry(s0, "run")!;
  console.log("run line:", run.value.kind === "scalar" ? run.value.line : "?");
  console.log((run.value as any).value.split("\n").map((l:string,i:number)=>`${i}|${l}`).join("\n"));
}
const on = mapEntry(doc, "on")!;
console.log("on:", JSON.stringify(on.value).slice(0,400));
