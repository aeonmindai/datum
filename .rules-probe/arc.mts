import { deriveRules } from "../packages/datum/src/rules/index.js";
const r = await deriveRules({ dir: "/Users/jish/Documents/GitHub/arc", repo: "aeonmindai/arc", scope: "org/aeonmind/proj/arc" });
const binding = r.rules.filter(x => x.binding);
console.log(`RULES total=${r.rules.length} binding=${binding.length} advisory=${r.rules.length - binding.length}`);
console.log(`UNENFORCED ${r.unenforced.length}`);
const bad = r.rules.filter(x => !/^(?:[^\s:][^:]*:\d+|api:[^\s#]+#\S+)$/.test(String(x.evidence.source)));
console.log("rules without file:line locator:", bad.length, bad.slice(0,3).map(b=>b.evidence.source));
console.log("commit:", r.rules[0]?.evidence.commit);
const bySubjPrefix: Record<string, {b:number,a:number}> = {};
for (const x of r.rules) { const p = String(x.subject).split("/").slice(0,2).join("/"); (bySubjPrefix[p] ??= {b:0,a:0})[x.binding?"b":"a"]++; }
console.log("by subject prefix (binding/advisory):");
for (const [k,v] of Object.entries(bySubjPrefix).sort()) console.log(`   ${k}: ${v.b}/${v.a}`);
console.log("\nstrength breakdown:", r.unenforced.reduce((a:any,f)=>{a[f.strength]=(a[f.strength]||0)+1;return a;},{}));
console.log("\nTOP 15 UNENFORCED:");
for (const f of r.unenforced.slice(0,15)) console.log(`  [${f.strength}] ${f.source}\n      heading: ${f.heading}\n      "${f.statement.slice(0,170)}"\n      tokens: ${f.tokens.join(", ")}`);
console.log("\nsources:", r.sources.length);
console.log(r.sources.filter(s=>!s.endsWith(".md")).join("\n"));
