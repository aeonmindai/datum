import type { TsNode } from "./parser.js";
import type { LanguageId } from "./parser.js";

/** One parsed file, everything an extractor needs and nothing it does not. */
export interface FileContext {
  /** Repo-relative, forward slashes, no leading `./`. */
  path: string;
  language: LanguageId;
  /** The namespace this file contributes, e.g. `mistralrs_quant::qtip` or `pkg.mod`. May be empty. */
  module: string;
  /** The last component of `module`, used as the module symbol's short name. */
  unit: string;
  source: string;
  root: TsNode;
}

/** Join a namespace prefix and a name with the separator the language actually writes. */
export function joinFqn(prefix: string, name: string, sep: "::" | "." = "::"): string {
  return prefix === "" ? name : `${prefix}${sep}${name}`;
}

/** One-based line of a node's first character, which is what humans and `code_symbols` both use. */
export function lineOf(node: TsNode): number {
  return node.startPosition.row + 1;
}

export function endLineOf(node: TsNode): number {
  return node.endPosition.row + 1;
}
