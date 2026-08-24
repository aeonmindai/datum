import { indexRepo } from "./packages/datum/src/index/index.js";
const dir = process.argv[2] ?? "/Users/jish/Documents/GitHub/arc";
const t0 = Date.now();
const art = await indexRepo({
  dir,
  repo: "aeonmind/arc",
  commitSha: process.argv[3] ?? "0000000",
  onProgress: (m) => console.error("[progress]", m),
});
console.error("wall", Date.now() - t0, "ms");
const { symbols, edges, ...rest } = art;
console.log(JSON.stringify(rest, null, 2));
const fs = await import("node:fs");
fs.writeFileSync("/tmp/arc-graph.json", JSON.stringify(art));
console.error("artifact bytes", fs.statSync("/tmp/arc-graph.json").size);
