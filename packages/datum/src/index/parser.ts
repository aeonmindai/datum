/**
 * Lazy, optional access to the tree-sitter grammars.
 *
 * The parser is a build-time concern: `datum index` runs where the code is, `datum ingest-graph`
 * runs in the server and needs nothing. That split is the reason the grammars live in
 * `optionalDependencies` — the runtime image must be buildable without a native toolchain.
 */

import { createRequire } from "node:module";

/**
 * `createRequire`, not `await import()`, and this is load-bearing.
 *
 * TypeScript module-resolves the specifier of a *dynamic* import exactly as it does a static one,
 * so `await import("tree-sitter")` fails `tsc --noEmit` on every machine where the optional
 * grammars are absent — which is CI and the server image, i.e. precisely the configuration this
 * indirection exists to protect. `createRequire` takes a plain string the compiler never resolves.
 * Do not "simplify" this back to a dynamic import; it silently breaks the no-optional-deps build.
 */
const requireOptional = createRequire(import.meta.url);

/**
 * The slice of the tree-sitter Node API this indexer uses, hand-written.
 *
 * We cannot depend on `@types/*` for these either: a type-only dependency the server cannot
 * install breaks `tsc` there just as surely as a runtime one would.
 */
export interface TsPoint {
  readonly row: number;
  readonly column: number;
}

export interface TsNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: TsPoint;
  readonly endPosition: TsPoint;
  readonly namedChildren: readonly TsNode[];
  readonly previousNamedSibling: TsNode | null;
  readonly hasError: boolean;
  childForFieldName(field: string): TsNode | null;
  descendantsOfType(type: string | readonly string[]): readonly TsNode[];
}

export interface TsTree {
  readonly rootNode: TsNode;
}

export interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree;
}

/**
 * `.cu`/`.cuh` deliberately parse with the C++ grammar. CUDA is C++ plus execution-space
 * qualifiers, and tree-sitter-cpp handles all of it except those qualifiers, which it parks in an
 * ERROR node beside a still-recoverable declarator. We read `__global__`/`__device__` out of the
 * raw source instead, so kernels are identified even though the grammar does not know the keyword.
 */
const GRAMMAR_PACKAGES = {
  rust: "tree-sitter-rust",
  python: "tree-sitter-python",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  cuda: "tree-sitter-cpp",
} as const;

export type LanguageId = keyof typeof GRAMMAR_PACKAGES;

/** The exact command that fixes a missing-parser failure. Kept next to the names it installs. */
const INSTALL_HINT =
  "npm i -O tree-sitter@0.25.1 tree-sitter-rust@0.24.0 tree-sitter-c@0.24.1 " +
  "tree-sitter-cpp@0.23.4 tree-sitter-python@0.25.0";

export class MissingParserError extends Error {
  constructor(pkg: string, cause: unknown) {
    super(
      `datum index needs the optional tree-sitter grammars, and "${pkg}" could not be loaded. ` +
        `They are optionalDependencies so the server image can be built without a native ` +
        `toolchain, which means an install may legitimately have skipped them. Install them where ` +
        `you run the indexer:\n\n    ${INSTALL_HINT}\n\n` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MissingParserError";
  }
}

/** One parser per grammar, reused across files: constructing a parser is far from free. */
export class ParserSet {
  private readonly parsers = new Map<string, TsParser>();

  private constructor(private readonly ParserCtor: new () => TsParser) {}

  static load(): ParserSet {
    let mod: unknown;
    try {
      mod = requireOptional("tree-sitter");
    } catch (cause) {
      throw new MissingParserError("tree-sitter", cause);
    }
    // Interop shim, not a shape assumption: `tree-sitter` is CJS, so depending on how it was
    // transpiled the constructor is either the export itself or hiding under `.default`.
    const exported =
      typeof mod === "object" && mod !== null && "default" in mod ? mod.default : mod;
    if (typeof exported !== "function") {
      throw new MissingParserError(
        "tree-sitter",
        new Error(`expected a Parser constructor, got ${typeof exported}`),
      );
    }
    // The compiler cannot know a `function` is this constructor, and no runtime check would tell
    // us more than the `setLanguage`/`parse` calls that follow will.
    const ParserCtor = exported as new () => TsParser;
    return new ParserSet(ParserCtor);
  }

  parserFor(language: LanguageId): TsParser {
    const pkg = GRAMMAR_PACKAGES[language];
    const cached = this.parsers.get(pkg);
    if (cached) return cached;
    let grammar: unknown;
    try {
      grammar = requireOptional(pkg);
    } catch (cause) {
      throw new MissingParserError(pkg, cause);
    }
    const parser = new this.ParserCtor();
    parser.setLanguage(grammar);
    this.parsers.set(pkg, parser);
    return parser;
  }
}
