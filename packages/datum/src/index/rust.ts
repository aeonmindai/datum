import { BUILTIN_TYPES, LITERAL_RECEIVERS } from "./filters.js";
import { endLineOf, joinFqn, lineOf, type FileContext } from "./context.js";
import { signatureHash, signatureText } from "./signature.js";
import type { Collector } from "./resolve.js";
import type { TsNode } from "./parser.js";

/**
 * Rust extraction.
 *
 * Two decisions worth stating up front.
 *
 * **`impl` blocks get no symbol of their own.** `SYMBOL_KINDS` has no `impl` member, so an impl
 * block would have to be recorded as a `type` — and since a type typically has several impl blocks,
 * that would give every type two to five symbols bearing its fqn, turning every call into it
 * `ambiguous-name`. That trade is unacceptable: resolution quality is the product. Impl blocks
 * instead contribute what they actually mean — an `implements` edge, and the namespace their
 * methods live in.
 *
 * **`uses_type` comes from signatures and field declarations, not from bodies.** A local `let x: T`
 * is a use, but harvesting bodies would make type edges an order of magnitude more numerous than
 * call edges while telling us nothing a signature does not. The public shape of a type is what
 * impact analysis needs.
 */

interface Scope {
  /** Namespace new symbols are declared in. No trailing separator. */
  prefix: string;
  /** The enclosing module's fqn, used to prefer a module-local target for a bare call. */
  modFqn: string;
  /** The `impl`/`trait` type in scope, so `self.foo()` and `Self::foo()` resolve precisely. */
  selfType: string | null;
  /** The symbol a call found here belongs to. */
  owner: string;
  /** Inside a `#[cfg(test)]` module: a plain `fn` here is a test helper, not production code. */
  inTestModule: boolean;
}

/**
 * Attribute names that mark a test. `#[test]` and `#[tokio::test]` are the required pair; the rest
 * are the harnesses common enough that omitting them would misclassify real test coverage as
 * production code, which is the direction of error that matters for "what tests cover this".
 */
const TEST_ATTRIBUTES: ReadonlySet<string> = new Set([
  "test",
  "bench",
  "rstest",
  "test_case",
  "proptest",
  "wasm_bindgen_test",
  "quickcheck",
]);

export function extractRust(ctx: FileContext, out: Collector): void {
  const moduleSymbol = out.addSymbol({
    kind: "module",
    name: ctx.unit === "" ? ctx.path : ctx.unit,
    fqn: ctx.module === "" ? null : ctx.module,
    language: "rust",
    path: ctx.path,
    line_start: 1,
    line_end: endLineOf(ctx.root),
  });
  const scope: Scope = {
    prefix: ctx.module,
    modFqn: ctx.module,
    selfType: null,
    owner: moduleSymbol.key,
    inTestModule: false,
  };
  for (const child of ctx.root.namedChildren) visit(child, scope, ctx, out);
}

function visit(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
): void {
  switch (node.type) {
    case "mod_item": {
      const body = node.childForFieldName("body");
      const name = node.childForFieldName("name");
      if (name === null) return;
      // `mod foo;` declares that `foo.rs` exists; that file emits its own module symbol, so
      // emitting one here too would duplicate it and make every reference to it ambiguous.
      if (body === null) return;
      const fqn = joinFqn(scope.prefix, name.text);
      const symbol = out.addSymbol({
        kind: "module",
        name: name.text,
        fqn,
        language: "rust",
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        visibility: visibilityOf(node),
      });
      const attrs = precedingAttributes(node);
      const inTest = scope.inTestModule || attrs.some((a) => a === "cfg(test)");
      const inner: Scope = {
        prefix: fqn,
        modFqn: fqn,
        selfType: null,
        owner: symbol.key,
        inTestModule: inTest,
      };
      for (const child of body.namedChildren) visit(child, inner, ctx, out);
      return;
    }

    case "struct_item":
    case "enum_item":
    case "union_item":
    case "type_item": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      const fqn = joinFqn(scope.prefix, name.text);
      const generics = node.childForFieldName("type_parameters");
      const signature = signatureText(generics?.text ?? "", null);
      const symbol = out.addSymbol({
        kind: "type",
        name: name.text,
        fqn,
        language: "rust",
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        visibility: visibilityOf(node),
        signature: signature === "" ? null : signature,
        signature_hash: signature === "" ? null : signatureHash(signature),
      });
      // A type's fields and variants are its composition, and composition is what a "what breaks if
      // I change this type" question is really asking about.
      for (const container of ["field_declaration_list", "enum_variant_list", "ordered_field_declaration_list"]) {
        for (const list of node.descendantsOfType(container)) {
          emitTypeUses(list, symbol.key, ctx, out, scope);
        }
      }
      const alias = node.childForFieldName("type");
      if (alias !== null) emitTypeUses(alias, symbol.key, ctx, out, scope);
      return;
    }

    case "trait_item": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      const fqn = joinFqn(scope.prefix, name.text);
      const symbol = out.addSymbol({
        kind: "trait",
        name: name.text,
        fqn,
        language: "rust",
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        visibility: visibilityOf(node),
      });
      // A supertrait bound is an `implements` relation with the same meaning as `impl A for B`:
      // anything satisfying this trait must satisfy that one.
      const bounds = node.childForFieldName("bounds");
      if (bounds !== null) {
        for (const bound of bounds.namedChildren) {
          const traitName = typeNameOf(bound);
          if (traitName === null || BUILTIN_TYPES.has(traitName)) continue;
          out.addEdge({
            src: symbol.key,
            kind: "implements",
            target: traitName,
            lookup: lookupsFor(traitName, scope),
            path: ctx.path,
            line: lineOf(bound),
          });
        }
      }
      const body = node.childForFieldName("body");
      if (body === null) return;
      const inner: Scope = { ...scope, prefix: fqn, selfType: fqn, owner: symbol.key };
      for (const child of body.namedChildren) visit(child, inner, ctx, out);
      return;
    }

    case "impl_item": {
      const typeName = typeNameOf(node.childForFieldName("type"));
      // `impl Trait for (A, B)` has no nameable target, so there is no type to scope its methods
      // under and no subject for an `implements` edge. The methods are still real, so they are
      // indexed at module scope rather than dropped — under-claiming the fqn is right, losing the
      // symbol is not.
      const implFqn = typeName === null ? scope.prefix : joinFqn(scope.prefix, typeName);
      const traitNode = node.childForFieldName("trait");
      if (traitNode !== null && typeName !== null) {
        const traitName = typeNameOf(traitNode);
        if (traitName !== null) {
          out.addEdge({
            // The impl block may live in a different file from `struct Foo`, so the source of this
            // edge is only knowable once the whole index exists.
            src: null,
            srcLookup: [implFqn, typeName],
            kind: "implements",
            target: traitName,
            lookup: lookupsFor(traitName, scope),
            path: ctx.path,
            line: lineOf(node),
          });
        }
      }
      const body = node.childForFieldName("body");
      if (body === null) return;
      const inner: Scope = { ...scope, prefix: implFqn, selfType: typeName === null ? null : implFqn };
      for (const child of body.namedChildren) visit(child, inner, ctx, out);
      return;
    }

    case "function_item":
    case "function_signature_item": {
      emitFunction(node, scope, ctx, out);
      return;
    }

    case "const_item":
    case "static_item": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      const typeNode = node.childForFieldName("type");
      const signature = signatureText(typeNode?.text ?? "", null);
      out.addSymbol({
        kind: "constant",
        name: name.text,
        fqn: joinFqn(scope.prefix, name.text),
        language: "rust",
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        visibility: visibilityOf(node),
        signature: signature === "" ? null : signature,
        signature_hash: signature === "" ? null : signatureHash(signature),
      });
      return;
    }

    case "macro_definition": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      out.addSymbol({
        kind: "macro",
        name: name.text,
        fqn: joinFqn(scope.prefix, name.text),
        language: "rust",
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        visibility: visibilityOf(node),
      });
      return;
    }

    case "use_declaration": {
      const argument = node.childForFieldName("argument");
      if (argument === null) return;
      const targets: string[] = [];
      expandUse(argument, "", targets);
      for (const target of targets) {
        out.addEdge({
          src: scope.owner,
          kind: "imports",
          target,
          lookup: lookupsFor(target, scope),
          path: ctx.path,
          line: lineOf(node),
        });
      }
      return;
    }

    case "foreign_mod_item":
    case "declaration_list":
    case "block": {
      for (const child of node.namedChildren) visit(child, scope, ctx, out);
      return;
    }

    default: {
      emitCallsIn(node, scope, ctx, out);
      return;
    }
  }
}

function emitFunction(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
): void {
  const name = node.childForFieldName("name");
  if (name === null) return;
  const attrs = precedingAttributes(node);
  const isTest = attrs.some(isTestAttribute);
  const params = node.childForFieldName("parameters");
  const returns = node.childForFieldName("return_type");
  const generics = node.childForFieldName("type_parameters");
  const signature = signatureText(`${generics?.text ?? ""}${params?.text ?? "()"}`, returns?.text ?? null);
  // A `fn` inside an `impl` or `trait` is a method; the same `fn` at module level is a function.
  // The distinction is what lets an impact answer say "this method" rather than "this name".
  const kind = isTest ? "test" : scope.selfType === null ? "function" : "method";
  const symbol = out.addSymbol({
    kind,
    name: name.text,
    fqn: joinFqn(scope.prefix, name.text),
    language: "rust",
    path: ctx.path,
    line_start: lineOf(node),
    line_end: endLineOf(node),
    visibility: visibilityOf(node),
    signature,
    signature_hash: signatureHash(signature),
  });

  if (params !== null) emitTypeUses(params, symbol.key, ctx, out, scope);
  if (returns !== null) emitTypeUses(returns, symbol.key, ctx, out, scope);

  // The `test_<thing>` convention, and nothing beyond it. A test named `roundtrip_is_stable` says
  // nothing mechanical about what it covers, so no edge is invented for it — the call edges out of
  // the test body already carry that, honestly labelled.
  if (isTest && name.text.startsWith("test_") && name.text.length > 5) {
    const subject = name.text.slice(5);
    out.addEdge({
      src: symbol.key,
      kind: "tests",
      target: subject,
      lookup: lookupsFor(subject, scope),
      path: ctx.path,
      line: lineOf(node),
    });
  }

  const body = node.childForFieldName("body");
  if (body === null) return;
  const inner: Scope = { ...scope, prefix: symbol.fqn ?? scope.prefix, owner: symbol.key };
  for (const child of body.namedChildren) visit(child, inner, ctx, out);
}

/** Walk an expression subtree, emitting call-shaped edges and recursing into nested definitions. */
function emitCallsIn(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
): void {
  switch (node.type) {
    case "call_expression": {
      const target = callTarget(node.childForFieldName("function"), scope);
      if (target !== null) {
        out.addEdge({
          src: scope.owner,
          kind: "calls",
          target: target.written,
          lookup: target.lookup,
          path: ctx.path,
          line: lineOf(node),
          // `Foo::new()` reads as a call and means construction. If the name resolves to a type
          // rather than a function, say so.
          retagIfType: "instantiates",
        });
      }
      break;
    }
    case "macro_invocation": {
      const macro = node.childForFieldName("macro");
      if (macro !== null) {
        const written = stripGenerics(macro.text);
        out.addEdge({
          src: scope.owner,
          kind: "calls",
          target: written,
          lookup: lookupsFor(written, scope),
          path: ctx.path,
          line: lineOf(node),
        });
      }
      break;
    }
    case "struct_expression": {
      const name = typeNameOf(node.childForFieldName("name"));
      if (name !== null && !BUILTIN_TYPES.has(name)) {
        out.addEdge({
          src: scope.owner,
          kind: "instantiates",
          target: name,
          lookup: lookupsFor(name, scope),
          path: ctx.path,
          line: lineOf(node),
        });
      }
      break;
    }
    // A nested definition inside a body is still a definition; hand it back to the main visitor.
    case "function_item":
    case "struct_item":
    case "enum_item":
    case "trait_item":
    case "impl_item":
    case "mod_item":
    case "const_item":
    case "static_item":
    case "macro_definition":
    case "use_declaration":
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
    case "identifier": {
      // A bare call prefers a target in the same module before anything else with that name.
      return { written: fn.text, lookup: [joinFqn(scope.modFqn, fn.text), fn.text] };
    }
    case "scoped_identifier": {
      const path = fn.childForFieldName("path");
      const name = fn.childForFieldName("name");
      if (name === null) return null;
      const rawPath = path === null ? "" : stripGenerics(path.text);
      const written = rawPath === "" ? name.text : `${rawPath}::${name.text}`;
      const lookup: string[] = [];
      // `Self::helper` is the most precise form there is: we know the concrete type.
      if ((rawPath === "Self" || rawPath === "self") && scope.selfType !== null) {
        lookup.push(joinFqn(scope.selfType, name.text));
      }
      const resolved = resolvePathPrefixes(written, scope);
      if (resolved !== null) lookup.push(resolved);
      lookup.push(written, name.text);
      return { written, lookup };
    }
    case "field_expression": {
      const field = fn.childForFieldName("field");
      const value = fn.childForFieldName("value");
      if (field === null) return null;
      // `1.max(x)` and `"s".len()` are std methods on literals, never anything local.
      if (value !== null && LITERAL_RECEIVERS.has(value.type)) return null;
      const lookup: string[] = [];
      if (value !== null && value.type === "self" && scope.selfType !== null) {
        lookup.push(joinFqn(scope.selfType, field.text));
      }
      lookup.push(field.text);
      return { written: field.text, lookup };
    }
    case "generic_function":
      return callTarget(fn.childForFieldName("function"), scope);
    case "parenthesized_expression":
      return callTarget(fn.namedChildren[0] ?? null, scope);
    default:
      return null;
  }
}

function emitTypeUses(
  container: TsNode,
  src: string,
  ctx: FileContext,
  out: Collector,
  scope: Scope,
): void {
  const seen = new Set<string>();
  for (const node of container.descendantsOfType(["type_identifier", "scoped_type_identifier"])) {
    const name = typeNameOf(node);
    if (name === null || BUILTIN_TYPES.has(name) || BUILTIN_TYPES.has(lastRustSegment(name))) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.addEdge({
      src,
      kind: "uses_type",
      target: name,
      lookup: lookupsFor(name, scope),
      path: ctx.path,
      line: lineOf(node),
    });
  }
}

/** Lookup keys for a written name, most specific first. */
function lookupsFor(written: string, scope: Scope): string[] {
  const keys: string[] = [];
  const resolved = resolvePathPrefixes(written, scope);
  if (resolved !== null) keys.push(resolved);
  if (!written.includes("::")) keys.push(joinFqn(scope.modFqn, written));
  keys.push(written);
  const last = lastRustSegment(written);
  if (last !== written) keys.push(last);
  return keys;
}

/**
 * Rewrite the path prefixes that only mean something relative to where they were written.
 *
 * `crate::` is the crate name, `Self::` is the concrete type. `super::` and `self::` are dropped
 * rather than resolved, because the remainder is then a namespace suffix and the resolver's suffix
 * index will find it — which is both simpler and less likely to be wrong than counting directory
 * levels.
 */
function resolvePathPrefixes(written: string, scope: Scope): string | null {
  let path = written;
  let changed = false;
  if (path === "crate" || path.startsWith("crate::")) {
    const crate = scope.modFqn.split("::")[0] ?? "";
    if (crate === "") return null;
    path = crate + path.slice("crate".length);
    changed = true;
  }
  if (path === "Self" || path.startsWith("Self::")) {
    if (scope.selfType === null) return null;
    path = scope.selfType + path.slice("Self".length);
    changed = true;
  }
  while (path.startsWith("super::") || path.startsWith("self::")) {
    path = path.slice(path.indexOf("::") + 2);
    changed = true;
  }
  return changed && path !== "" ? path : null;
}


/** Flatten a `use` tree into the full paths it brings into scope. */
function expandUse(node: TsNode, prefix: string, out: string[]): void {
  switch (node.type) {
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      const next = path === null ? prefix : joinFqn(prefix, path.text);
      if (list === null) out.push(next);
      else expandUse(list, next, out);
      return;
    }
    case "use_list": {
      for (const child of node.namedChildren) expandUse(child, prefix, out);
      return;
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      if (path !== null) expandUse(path, prefix, out);
      return;
    }
    case "use_wildcard": {
      const path = node.namedChildren[0];
      // `use a::b::*;` imports the module, and the module is the only thing we can name.
      out.push(path === undefined ? prefix : joinFqn(prefix, path.text));
      return;
    }
    default:
      out.push(joinFqn(prefix, node.text));
      return;
  }
}

function precedingAttributes(node: TsNode): string[] {
  const attrs: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev !== null && (prev.type === "attribute_item" || prev.type === "inner_attribute_item")) {
    const attr = prev.namedChildren[0];
    attrs.push((attr ?? prev).text);
    prev = prev.previousNamedSibling;
  }
  return attrs;
}

function isTestAttribute(attr: string): boolean {
  const head = attr.split("(")[0]?.trim() ?? "";
  const last = head.split("::").at(-1) ?? head;
  return TEST_ATTRIBUTES.has(last);
}

function visibilityOf(node: TsNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "visibility_modifier") return child.text;
  }
  return null;
}

/** A Rust path: identifiers joined by `::`, and nothing else. */
const RUST_PATH = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The name of a type, with generic arguments and reference sigils removed. */
function typeNameOf(node: TsNode | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "generic_type":
      return typeNameOf(node.childForFieldName("type"));
    case "reference_type":
    case "pointer_type":
    case "array_type":
    case "slice_type":
      return typeNameOf(node.childForFieldName("type"));
    case "scoped_type_identifier": {
      const path = node.childForFieldName("path");
      const name = node.childForFieldName("name");
      if (name === null) break;
      return path === null ? name.text : `${stripGenerics(path.text)}::${name.text}`;
    }
    case "type_identifier":
    case "identifier":
      return node.text;
  }
  // Anything that is not shaped like a path is not a name we can resolve against. `impl TryInto<X>
  // for (TomlSelector, TomlLoaderArgs)` is the real case: a tuple type has no name, and inventing
  // `(TomlSelector, TomlLoaderArgs)::try_into` produces an fqn containing a space and a comma that
  // no call site can ever match, so the method reads as unreferenced. Returning null instead
  // scopes those methods under the module and emits no `implements` edge, which is the honest
  // answer: there is nothing there to name.
  const stripped = stripGenerics(node.text).trim();
  return RUST_PATH.test(stripped) ? stripped : null;
}

function stripGenerics(text: string): string {
  const angle = text.indexOf("<");
  return (angle < 0 ? text : text.slice(0, angle)).trim();
}

function lastRustSegment(name: string): string {
  return name.split("::").at(-1) ?? name;
}
