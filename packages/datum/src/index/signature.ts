import { createHash } from "node:crypto";

/**
 * The change detector for "the name did not move but the shape did".
 *
 * A rename is easy to notice; a signature change under a stable name is the one that silently
 * breaks callers, and it is invisible to a name-keyed index. So every symbol carries a hash of its
 * normalised parameter and return text, and a diff between two `code_index` rows can point at
 * exactly the symbols whose contract moved while their identity did not.
 *
 * Normalisation has to ignore everything a formatter can change and nothing a compiler can see.
 */

/** Whitespace inside a signature is a formatting artefact, so it must not enter the hash. */
function normalise(text: string): string {
  return (
    text
      // Comments first: a doc comment inside a parameter list is not part of the contract.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/#[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      // `Vec< u32 >` and `Vec<u32>` are the same type; a line break after a comma is the same
      // parameter list. Collapsing space adjacent to punctuation makes reflowing a long signature
      // a no-op, while a genuine token change still moves the hash.
      .replace(/\s*([(),<>&*:;=[\]{}])\s*/g, "$1")
      .trim()
  );
}

/**
 * `params` and `returns` are joined with a separator that cannot occur in either, so that moving
 * text across the boundary (a return type becoming a trailing out-parameter, say) changes the hash.
 */
export function signatureText(params: string, returns: string | null): string {
  const p = normalise(params);
  const r = returns === null ? "" : normalise(returns);
  return r === "" ? p : `${p}->${r}`;
}

/**
 * First 16 hex of sha256. Truncated on purpose: this is a change detector, not a security
 * primitive, and 64 bits is far past the collision budget of one repository's symbol table.
 */
export function signatureHash(signature: string): string {
  return createHash("sha256").update(signature, "utf8").digest("hex").slice(0, 16);
}
