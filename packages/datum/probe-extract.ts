import { collectProseFiles, readProseFiles } from "./src/prose/walk.js";
import { extractFromDocument, PROSE_EXTRACTOR } from "./src/prose/extract.js";
import { searchProse } from "./src/prose/search.js";

const roots = ["/Users/jish/Documents/GitHub/arc/memory"];
const files = await collectProseFiles(roots, 64 * 1024 * 1024);
console.log("files:", files.map((f) => `${f.path} (${f.size})`).join("\n       "));
const docs = await readProseFiles(files);
let all: ReturnType<typeof extractFromDocument> = [];
for (const doc of docs) {
  all = all.concat(extractFromDocument(doc.path, doc.lines, "org/acme/proj/arc", PROSE_EXTRACTOR));
}
const seen = new Set<string>();
const unique = all.filter((c) => {
  const k = `${c.subject}\u0000${c.predicate}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(`\nTOTAL raw=${all.length} unique=${unique.length}`);
const byFamily: Record<string, number> = {};
for (const c of unique) byFamily[c.citation.family] = (byFamily[c.citation.family] ?? 0) + 1;
console.log("by family:", byFamily);
console.log("\n--- all unique candidates ---");
for (const c of unique) {
  console.log(
    `${c.citation.source}\n  subject=${JSON.stringify(c.subject)} predicate=${c.predicate} object=${JSON.stringify(c.object)} conf=${c.extractorConfidence} family=${c.citation.family}\n  excerpt=${c.claim}`,
  );
}

console.log("\n=== prose search smoke ===");
const hits = await searchProse({
  roots: ["/Users/jish/Documents/GitHub/arc/memory"],
  query: "greedy is banned forever",
  limit: 5,
});
for (const h of hits) console.log(`${h.path}:${h.line} score=${h.score.toFixed(3)} ${h.text.slice(0, 90)}`);
