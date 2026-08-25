import { BUILTIN_TYPES, LITERAL_RECEIVERS } from "./filters.js";
import { endLineOf, joinFqn, lineOf, type FileContext } from "./context.js";
import { signatureHash, signatureText } from "./signature.js";
import type { Collector } from "./resolve.js";
import type { TsNode } from "./parser.js";

/**
 * Python extraction.
 *
 * Python has no declarations, so everything here comes from a definition site, which makes the
 * symbol table cleaner than the C++ one. The interesting judgement is in what counts as a test:
 * pytest's contract is literally the `test_` prefix, so that prefix is a mechanical fact and not a
 * guess — which is exactly the kind of fact this store is allowed to hold.
 */

interface Scope {
  /** Namespace new symbols are declared in, dot-separated. No trailing separator. */
  prefix: string;
  /** The enclosing module's dotted path, used to prefer a module-local target for a bare call. */
  modFqn: string;
  /** The enclosing class, so `self.method()` resolves to that class's method. */
  selfType: string | null;
  owner: string;
}

export function extractPython(ctx: FileContext, out: Collector): void {
  const moduleSymbol = out.addSymbol({
    kind: "module",
    name: ctx.unit === "" ? ctx.path : ctx.unit,
    fqn: ctx.module === "" ? null : ctx.module,
    language: "python",
    path: ctx.path,
    line_start: 1,
    line_end: endLineOf(ctx.root),
  });
  const scope: Scope = {
    prefix: ctx.module,
    modFqn: ctx.module,
    selfType: null,
    owner: moduleSymbol.key,
  };
  // A `test_*.py` module tests the module named without the prefix. That is the pytest discovery
  // convention, so it is derivable rather than inferred, and it is the cheapest useful answer to
  // "what covers this file".
  if (ctx.unit.startsWith("test_") && ctx.unit.length > 5) {
    const subject = ctx.unit.slice(5);
    out.addEdge({
      src: moduleSymbol.key,
      kind: "tests",
      target: subject,
      lookup: [subject],
      path: ctx.path,
      line: 1,
    });
  }
  for (const child of ctx.root.namedChildren) visit(child, scope, ctx, out);
}

function visit(node: TsNode, scope: Scope, ctx: FileContext, out: Collector): void {
  switch (node.type) {
    case "decorated_definition": {
      const definition = node.childForFieldName("definition");
      if (definition === null) return;
      // Decorators are attributed to the definition's line span, which starts at the decorator, so
      // the reported span covers what a reader would call the whole declaration.
      visitDefinition(definition, scope, ctx, out, lineOf(node), decoratorNames(node));
      return;
    }
    case "function_definition":
      visitDefinition(node, scope, ctx, out, lineOf(node), []);
      return;
    case "class_definition":
      visitDefinition(node, scope, ctx, out, lineOf(node), []);
      return;

    case "import_statement":
    case "import_from_statement": {
      for (const target of importTargets(node)) {
        out.addEdge({
          src: scope.owner,
          kind: "imports",
          target,
          lookup: [target, target.split(".").at(-1) ?? target],
          path: ctx.path,
          line: lineOf(node),
        });
      }
      return;
    }

    case "expression_statement": {
      // Module- and class-level `NAME = value` with a screaming-snake name is a constant in every
      // Python codebase's own terms; a lowercase binding is a variable and not worth a symbol.
      for (const child of node.namedChildren) {
        if (child.type !== "assignment") continue;
        const left = child.childForFieldName("left");
        if (left === null || left.type !== "identifier") continue;
        const name = left.text;
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        const annotation = child.childForFieldName("type");
        const signature = signatureText(annotation?.text ?? "", null);
        out.addSymbol({
          kind: "constant",
          name,
          fqn: joinFqn(scope.prefix, name, "."),
          language: "python",
          path: ctx.path,
          line_start: lineOf(child),
          line_end: endLineOf(child),
          signature: signature === "" ? null : signature,
          signature_hash: signature === "" ? null : signatureHash(signature),
        });
      }
      emitCallsIn(node, scope, ctx, out);
      return;
    }

    case "block":
    case "if_statement":
    case "try_statement":
    case "with_statement":
    case "for_statement":
    case "while_statement": {
      // Conditional definitions are ordinary in Python (`if TYPE_CHECKING`, platform branches), so
      // these bodies are descended into rather than treated as opaque expressions.
      for (const child of node.namedChildren) visit(child, scope, ctx, out);
      return;
    }

    default:
      emitCallsIn(node, scope, ctx, out);
      return;
  }
}

function visitDefinition(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
  lineStart: number,
  decorators: readonly string[],
): void {
  const name = node.childForFieldName("name");
  if (name === null) return;
  const fqn = joinFqn(scope.prefix, name.text, ".");

  if (node.type === "class_definition") {
    const symbol = out.addSymbol({
      kind: "type",
      name: name.text,
      fqn,
      language: "python",
      path: ctx.path,
      line_start: lineStart,
      line_end: endLineOf(node),
    });
    const bases = node.childForFieldName("superclasses");
    if (bases !== null) {
      for (const base of bases.namedChildren) {
        const baseName = base.type === "keyword_argument" ? null : base.text;
        if (baseName === null || BUILTIN_TYPES.has(baseName)) continue;
        out.addEdge({
          src: symbol.key,
          kind: "implements",
          target: baseName,
          lookup: [baseName, baseName.split(".").at(-1) ?? baseName],
          path: ctx.path,
          line: lineOf(base),
        });
      }
    }
    const body = node.childForFieldName("body");
    if (body === null) return;
    const inner: Scope = { prefix: fqn, modFqn: scope.modFqn, selfType: fqn, owner: symbol.key };
    for (const child of body.namedChildren) visit(child, inner, ctx, out);
    return;
  }

  const params = node.childForFieldName("parameters");
  const returns = node.childForFieldName("return_type");
  const signature = signatureText(params?.text ?? "()", returns?.text ?? null);
  // pytest's discovery contract is the `test_` prefix. `@pytest.fixture` is test infrastructure but
  // is not itself a test, so it stays a function — calling it a test would overstate coverage.
  const isTest = name.text.startsWith("test_");
  const kind = isTest ? "test" : scope.selfType === null ? "function" : "method";
  const symbol = out.addSymbol({
    kind,
    name: name.text,
    fqn,
    language: "python",
    path: ctx.path,
    line_start: lineStart,
    line_end: endLineOf(node),
    signature,
    signature_hash: signatureHash(signature),
  });

  if (params !== null) emitTypeUses(params, symbol.key, ctx, out);
  if (returns !== null) emitTypeUses(returns, symbol.key, ctx, out);

  for (const decorator of decorators) {
    out.addEdge({
      src: symbol.key,
      kind: "calls",
      target: decorator,
      lookup: [decorator, decorator.split(".").at(-1) ?? decorator],
      path: ctx.path,
      line: lineStart,
    });
  }

  if (isTest && name.text.length > 5) {
    const subject = name.text.slice(5);
    out.addEdge({
      src: symbol.key,
      kind: "tests",
      target: subject,
      lookup: [joinFqn(scope.modFqn, subject, "."), subject],
      path: ctx.path,
      line: lineStart,
    });
  }

  const body = node.childForFieldName("body");
  if (body === null) return;
  const inner: Scope = { ...scope, prefix: fqn, owner: symbol.key };
  for (const child of body.namedChildren) visit(child, inner, ctx, out);
}

function emitCallsIn(node: TsNode, scope: Scope, ctx: FileContext, out: Collector): void {
  if (node.type === "call") {
    const target = callTarget(node.childForFieldName("function"), scope);
    if (target !== null) {
      out.addEdge({
        src: scope.owner,
        kind: "calls",
        target: target.written,
        lookup: target.lookup,
        path: ctx.path,
        line: lineOf(node),
        // `Foo()` is written as a call and means construction. Only the resolved target can tell
        // which, so the decision is deferred to the resolver rather than guessed from capitalisation.
        retagIfType: "instantiates",
      });
    }
  } else if (
    node.type === "function_definition" ||
    node.type === "class_definition" ||
    node.type === "decorated_definition" ||
    node.type === "import_statement" ||
    node.type === "import_from_statement"
  ) {
    visit(node, scope, ctx, out);
    return;
  }
  for (const child of node.namedChildren) emitCallsIn(child, scope, ctx, out);
}

interface CallTarget {
  written: string;
  lookup: string[];
}

function callTarget(fn: TsNode | null, scope: Scope): CallTarget | null {
  if (fn === null) return null;
  switch (fn.type) {
    case "identifier":
      return { written: fn.text, lookup: [joinFqn(scope.modFqn, fn.text, "."), fn.text] };
    case "attribute": {
      const attribute = fn.childForFieldName("attribute");
      const object = fn.childForFieldName("object");
      if (attribute === null) return null;
      if (object !== null && LITERAL_RECEIVERS.has(object.type)) return null;
      const lookup: string[] = [];
      if (object !== null && object.type === "identifier" && object.text === "self" && scope.selfType !== null) {
        lookup.push(joinFqn(scope.selfType, attribute.text, "."));
      }
      // `a.b.c()` written in full is a better lookup key than the bare method name, when it parses
      // as a dotted path rather than an expression.
      const dotted = fn.text;
      if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(dotted)) lookup.push(dotted);
      lookup.push(attribute.text);
      return { written: attribute.text, lookup };
    }
    case "subscript":
      return callTarget(fn.childForFieldName("value"), scope);
    case "parenthesized_expression":
      return callTarget(fn.namedChildren[0] ?? null, scope);
    default:
      return null;
  }
}

function emitTypeUses(container: TsNode, src: string, ctx: FileContext, out: Collector): void {
  const seen = new Set<string>();
  for (const node of container.descendantsOfType(["type", "identifier"])) {
    const name = node.type === "type" ? node.namedChildren[0]?.text ?? node.text : node.text;
    if (name === undefined) continue;
    // Annotations are the only reliable type information Python offers; parameter names appear as
    // identifiers too, so anything that is not a plain dotted name is skipped rather than guessed.
    if (!/^[A-Z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(name)) continue;
    const bare = name.split(".").at(-1) ?? name;
    if (BUILTIN_TYPES.has(name) || BUILTIN_TYPES.has(bare)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.addEdge({
      src,
      kind: "uses_type",
      target: name,
      lookup: [name, bare],
      path: ctx.path,
      line: lineOf(node),
    });
  }
}

/** `import a.b`, `import a as b`, `from a.b import c` — the full dotted path in every case. */
function importTargets(node: TsNode): string[] {
  const out: string[] = [];
  if (node.type === "import_statement") {
    for (const child of node.namedChildren) {
      if (child.type === "aliased_import") {
        const name = child.childForFieldName("name");
        if (name !== null) out.push(name.text);
      } else if (child.type === "dotted_name") {
        out.push(child.text);
      }
    }
    return out;
  }
  const moduleName = node.childForFieldName("module_name");
  // `from . import x` gives a relative_import with no resolvable base; the imported names are still
  // recorded, and the resolver's suffix index is what finds them.
  const base = moduleName === null || moduleName.type === "relative_import" ? "" : moduleName.text;
  let sawModule = false;
  for (const child of node.namedChildren) {
    if (child === moduleName) {
      sawModule = true;
      continue;
    }
    if (!sawModule && moduleName !== null) continue;
    if (child.type === "wildcard_import") {
      if (base !== "") out.push(base);
      continue;
    }
    const named = child.type === "aliased_import" ? child.childForFieldName("name") : child;
    if (named === null) continue;
    if (named.type !== "dotted_name" && named.type !== "identifier") continue;
    out.push(base === "" ? named.text : `${base}.${named.text}`);
  }
  if (out.length === 0 && base !== "") out.push(base);
  return out;
}

function decoratorNames(node: TsNode): string[] {
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "decorator") continue;
    const inner = child.namedChildren[0];
    if (inner === undefined) continue;
    const target = inner.type === "call" ? inner.childForFieldName("function") : inner;
    if (target === null) continue;
    const text = target.text;
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(text)) names.push(text);
  }
  return names;
}
