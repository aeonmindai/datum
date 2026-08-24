import { deriveRules } from "../packages/datum/src/rules/index.js";
const r = await deriveRules({ dir: "/Users/jish/Documents/GitHub/arc", repo: "aeonmindai/arc", scope: "org/a/proj/arc" });
const hits = r.unenforced.filter(f => /cudnn/i.test(f.statement) || /w=256|W=256/.test(f.statement) || /greedy/i.test(f.statement));
console.log("target-ish findings:", hits.length);
for (const f of hits) console.log(`  [${f.strength}] ${f.source} | ${f.heading} | "${f.statement.slice(0,150)}" | tok=${f.tokens.join(",")}`);
console.log("\nmemory docs scanned:", r.sources.filter(s=>s.startsWith("memory/")).length);
console.log("findings in memory/DOCTRINE.md:", r.unenforced.filter(f=>f.file==="memory/DOCTRINE.md").length);
console.log("findings in memory/GPU_ACCESS_RULE.md:", r.unenforced.filter(f=>f.file==="memory/GPU_ACCESS_RULE.md").map(f=>`${f.line}:${f.statement.slice(0,90)}`));
