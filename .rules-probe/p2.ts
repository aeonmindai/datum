import { walk, loadSource } from "../packages/datum/src/rules/source.js";
import { parseYaml, mapEntry, stringList } from "../packages/datum/src/rules/yaml.js";
const dir = "/Users/jish/Documents/GitHub/arc";
for (const rel of walk(dir, { only: [".github/workflows"], extensions: [".yml", ".yaml"] })) {
  const f = loadSource(dir, rel)!;
  const doc = parseYaml(f);
  const jobs = mapEntry(doc, "jobs");
  const n = jobs && jobs.value.kind === "map" ? jobs.value.entries.length : 0;
  console.log(rel, "top:", doc.entries.map(e=>e.key).join(","), "jobs:", n);
  if (jobs && jobs.value.kind === "map") for (const j of jobs.value.entries) {
    const st = mapEntry(j.value, "steps");
    console.log("   ", j.key, "@", j.line, "steps", st && st.value.kind==="seq" ? st.value.items.length : 0, "needs", stringList(mapEntry(j.value,"needs")?.value).join("|"));
  }
}
const f = loadSource(dir, ".github/workflows/ci.yml")!;
const check = mapEntry(mapEntry(parseYaml(f),"jobs")!.value, "check")!.value;
console.log("matrix:", JSON.stringify(mapEntry(mapEntry(check,"strategy")!.value,"matrix")));
