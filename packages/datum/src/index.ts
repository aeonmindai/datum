export { loadConfig, ConfigError, type Config } from "./config.js";
export { Db, type DbRole } from "./db/pool.js";
export { migrate, MIGRATIONS_DIR } from "./db/migrate.js";
export { Rejection, asRejection } from "./domain/errors.js";
export { REASONS, isReason, type Reason } from "./domain/reasons.js";
export {
  assertFact,
  supersede,
  take,
  search,
  lineage,
  byId,
  missions,
  createMission,
  contradictions,
  currentSequence,
  logRejection,
} from "./domain/store.js";
export { ancestors, resolveChain, isDescendantOf } from "./domain/scope.js";
export { assertionHash, newAssertionId, newId, sha256Hex } from "./domain/identity.js";
export * from "./domain/types.js";
export { buildServer, serve, type Server } from "./http/server.js";
export { initInstance } from "./ops/init.js";
export { loadSeed, SEEDS_DIR } from "./ops/seed.js";
export {
  runVerificationPass,
  startVerificationWorker,
  verifyOne,
  type VerificationResult,
} from "./worker/verify.js";
export { compactAssertion, compactState, pack } from "./http/compact.js";
