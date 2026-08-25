import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A real Postgres container is started once and shared. Nothing here is stubbed, so
    // the suite is bounded by container startup rather than by assertion count.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // The invariant suite mutates schema (dropping constraints to prove they bite), so it
    // must never share a database with a concurrently running file.
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
