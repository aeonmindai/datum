import { loadSource } from "../packages/datum/src/rules/source.js";
import { parseToml, entriesIn, tablesUnder, entryAt, asStringArray } from "../packages/datum/src/rules/toml.js";
const dir = "/Users/jish/Documents/GitHub/arc";
const c = parseToml(loadSource(dir, "Cargo.toml")!);
console.log("tables:", Object.keys(c.tableLines).join(", "));
console.log("rust-version:", JSON.stringify(entryAt(c, "workspace.package.rust-version")));
for (const t of tablesUnder(c, "profile")) {
  console.log("profile table", t, "@", c.tableLines[t]);
  for (const e of entriesIn(c, t)) console.log("   ", e.key, "=", JSON.stringify(e.value), "@", e.line);
}
const cc = entryAt(c, "workspace.dependencies.candle-core");
console.log("candle-core:", JSON.stringify(cc));
const img = entryAt(c, "workspace.dependencies.image");
console.log("image elementLines:", img?.elementLines.slice(0,5), "value:", JSON.stringify(img?.value).slice(0,120));
const t = parseToml(loadSource(dir, ".typos.toml")!);
const ig = entryAt(t, "default.extend-ignore-re");
console.log("typos ignore count:", asStringArray(ig!.value).length, "line", ig!.line, "elem lines", ig!.elementLines.slice(0,4), "last", ig!.elementLines.at(-1));
console.log("typos tables:", Object.keys(t.tableLines).join(", "));
const py = parseToml(loadSource(dir, "mistralrs-pyo3/pyproject.toml")!);
console.log("pyproject:", py.entries.map(e=>`${e.path}@${e.line}`).join(" | "));
