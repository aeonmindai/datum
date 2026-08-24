import { readdir } from "node:fs/promises";
import { collectProseFiles, readProseFiles } from "./src/prose/walk.js";
import { extractFromDocument, PROSE_EXTRACTOR, type ProposalCandidate } from "./src/prose/extract.js";

const dir = "/Users/jish/Documents/GitHub/arc/memory";

const dedupe = (all: ProposalCandidate[]): ProposalCandidate[] => {
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = `${c.subject}\u0000${c.predicate}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const run = async (label: string, paths: Array<{ path: string; size: number }>) => {
  const docs = await readProseFiles(paths);
  let all: ProposalCandidate[] = [];
  for (const doc of docs) {
    all = all.concat(extractFromDocument(doc.path, doc.lines, "org/acme/proj/arc", PROSE_EXTRACTOR));
  }
  const unique = dedupe(all);
  const byFamily: Record<string, number> = {};
  for (const c of unique) byFamily[c.citation.family] = (byFamily[c.citation.family] ?? 0) + 1;
  console.log(`\n### ${label}: files=${docs.length} raw=${all.length} unique=${unique.length}`, byFamily);
  for (const c of unique) {
    console.log(
      `${c.citation.source}\n  subject=${JSON.stringify(c.subject)} predicate=${c.predicate} object=${JSON.stringify(c.object)} family=${c.citation.family}\n  excerpt=${c.claim}`,
    );
  }
  return unique;
};

const topLevel = (await readdir(dir))
  .filter((n) => n.endsWith(".md"))
  .sort()
  .map((n) => ({ path: `${dir}/${n}`, size: 0 }));
await run("memory/*.md (top level only)", topLevel);

const tree = await collectProseFiles([dir], 64 * 1024 * 1024);
await run("memory/** (whole tree)", tree);
