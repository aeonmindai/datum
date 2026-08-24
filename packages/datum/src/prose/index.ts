/**
 * Subsystems 3 and 4: the prose channel.
 *
 * They are one module because they are one argument. Prose is genuinely useful and genuinely
 * untrustworthy, so it gets exactly two ways in and no third:
 *
 * 1. `searchProse` — read it at query time, cite it, return it beside the record under
 *    `from_prose`, and **never persist it**. Coverage without rot.
 * 2. `extractProposals` — write candidates to `datum.proposals`, where a human confirms the
 *    citation before anything reaches `datum.assertions`. Contribution without an extractor
 *    getting write access to the record.
 *
 * Neither path can put prose into `assertions` by machine. That is the whole point, and it is
 * why the confidence taxonomy is still four earned classes after coverage went up.
 */

export { searchProse, tokenize, DEFAULT_PROSE_MAX_BYTES } from "./search.js";
export type { ProseHit, ProseSearchOptions } from "./search.js";

export {
  extractProposals,
  extractFromDocument,
  insertProposals,
  PROSE_EXTRACTOR,
  PROPOSAL_STATUSES,
  DEFAULT_EXTRACT_MAX_BYTES,
} from "./extract.js";
export type {
  ExtractOptions,
  ExtractResult,
  ProposalCandidate,
  ProposalCitation,
  ProposalStatus,
  ProseFamily,
} from "./extract.js";

export { registerProposalRoutes } from "./routes.js";
export type { ProposalRoutesDeps, ProposalRow } from "./routes.js";

export { collectProseFiles, readProseFiles, PROSE_EXTENSIONS } from "./walk.js";
export type { ProseFile, ProseDocument } from "./walk.js";
