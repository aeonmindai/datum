import { BUILTIN_TYPES, LITERAL_RECEIVERS } from "./filters.js";
import { endLineOf, joinFqn, lineOf, type FileContext } from "./context.js";
import { signatureHash, signatureText } from "./signature.js";
import type { Collector } from "./resolve.js";
import type { TsNode } from "./parser.js";

/**
 * C, C++ and CUDA extraction.
 *
 * Three things here are not obvious.
 *
 * **Prototypes are marked as declarations, not definitions.** A header declares and a translation
 * unit defines. Indexing both as peers would give every cross-file function two symbols bearing one
 * fqn, so every call into it would be reported `ambiguous-name` — the resolver drops a declaration
 * once a definition for the same fqn is found anywhere in the index. The survivors are pure-virtual
 * methods and `extern` declarations, where the declaration genuinely is the only symbol.
 *
 * **CUDA execution-space qualifiers are read from the source, not the tree.** tree-sitter-cpp does
 * not know `__global__`, so it parks it in an ERROR node beside a still-recoverable declarator. The
 * declarator survives, so the symbol is found; the qualifier is recovered by looking at the raw
 * text between the definition's start and its declarator.
 *
 * **Kernel launches are rescued by hand.** `kern<<<grid, block>>>(args)` parses as a chain of
 * shift operators, so the call disappears from the tree entirely. A launch is the single most
 * important edge in a CUDA codebase — it is the only thing connecting host code to a kernel — so
 * losing it silently is not acceptable, and a narrow textual rescue is better than a missing edge.
 */

interface Scope {
  prefix: string;
  /** The enclosing class or struct, so `this->m()` resolves to that class's method. */
  selfType: string | null;
  owner: string;
  /** Inside a function body, where a `const` is a local rather than a declared constant. */
  inFunctionBody: boolean;
}

/** Recognises `name<<<` at the head of a shift-operator chain: a CUDA kernel launch. */
const KERNEL_LAUNCH = /^([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:<[^<>]*>\s*)?<<</;

/** Declarator node types that can carry the declared name of a constant. */
const DECLARATOR_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "field_identifier",
  "pointer_declarator",
  "array_declarator",
  "reference_declarator",
  "parenthesized_declarator",
]);

/**
 * Qualifiers stripped before a declaration's leading text is treated as a return type. They are
 * storage and execution-space annotations, not part of the type, and leaving them in would make a
 * signature hash change when someone adds `inline`.
 */
const STRIPPED_SPECIFIERS =
  /\b(?:__global__|__device__|__host__|__forceinline__|__inline__|__restrict__|__launch_bounds__\([^)]*\)|inline|static|extern|constexpr|consteval|virtual|explicit|friend|typename)\b/g;

export function extractCFamily(ctx: FileContext, out: Collector): void {
  const moduleSymbol = out.addSymbol({
    kind: "module",
    name: ctx.unit === "" ? ctx.path : ctx.unit,
    // The path is the only stable identity a translation unit has: C has no module system, so
    // `#include "a/b.cuh"` is resolved by matching the path suffix.
    fqn: ctx.module === "" ? null : ctx.module,
    language: ctx.language,
    path: ctx.path,
    line_start: 1,
    line_end: endLineOf(ctx.root),
  });
  const scope: Scope = { prefix: "", selfType: null, owner: moduleSymbol.key, inFunctionBody: false };
  for (const child of ctx.root.namedChildren) visit(child, scope, ctx, out);
}

function visit(node: TsNode, scope: Scope, ctx: FileContext, out: Collector): void {
  switch (node.type) {
    case "namespace_definition": {
      const name = node.childForFieldName("name");
      const body = node.childForFieldName("body");
      // An anonymous namespace is internal linkage with no name to resolve against, so it
      // contributes no symbol; its contents still belong to the enclosing prefix.
      const fqn = name === null ? scope.prefix : joinFqn(scope.prefix, name.text);
      let owner = scope.owner;
      if (name !== null) {
        owner = out.addSymbol({
          kind: "module",
          name: name.text,
          fqn,
          language: ctx.language,
          path: ctx.path,
          line_start: lineOf(node),
          line_end: endLineOf(node),
        }).key;
      }
      if (body === null) return;
      const inner: Scope = { prefix: fqn, selfType: scope.selfType, owner, inFunctionBody: false };
      for (const child of body.namedChildren) visit(child, inner, ctx, out);
      return;
    }

    case "template_declaration": {
      // The template is a wrapper; the declaration inside it is the symbol. Its parameter list is
      // folded into the signature, because `template<int K>` changing is a contract change.
      const params = node.childForFieldName("parameters");
      for (const child of node.namedChildren) {
        if (child === params) continue;
        visitTemplated(child, scope, ctx, out, params?.text ?? "", lineOf(node));
      }
      return;
    }

    case "struct_specifier":
    case "class_specifier":
    case "union_specifier":
    case "enum_specifier": {
      visitRecord(node, scope, ctx, out, "", lineOf(node));
      return;
    }

    case "function_definition": {
      visitFunction(node, scope, ctx, out, "", lineOf(node), true);
      return;
    }

    case "declaration":
    case "field_declaration": {
      visitDeclaration(node, scope, ctx, out, "", lineOf(node));
      return;
    }

    case "alias_declaration":
    case "type_definition": {
      visitAlias(node, scope, ctx, out);
      return;
    }

    case "preproc_def": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      const value = node.childForFieldName("value");
      const signature = signatureText(value?.text ?? "", null);
      out.addSymbol({
        kind: "constant",
        name: name.text,
        fqn: joinFqn(scope.prefix, name.text),
        language: ctx.language,
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        signature: signature === "" ? null : signature,
        signature_hash: signature === "" ? null : signatureHash(signature),
      });
      return;
    }

    case "preproc_function_def": {
      const name = node.childForFieldName("name");
      if (name === null) return;
      const params = node.childForFieldName("parameters");
      const signature = signatureText(params?.text ?? "()", null);
      out.addSymbol({
        kind: "macro",
        name: name.text,
        fqn: joinFqn(scope.prefix, name.text),
        language: ctx.language,
        path: ctx.path,
        line_start: lineOf(node),
        line_end: endLineOf(node),
        signature,
        signature_hash: signatureHash(signature),
      });
      return;
    }

    case "preproc_include": {
      const target = includeTarget(node);
      if (target === null) return;
      out.addEdge({
        src: scope.owner,
        kind: "imports",
        target,
        lookup: [target, target.split("/").at(-1) ?? target],
        path: ctx.path,
        line: lineOf(node),
      });
      return;
    }

    case "linkage_specification":
    case "declaration_list":
    case "preproc_if":
    case "preproc_ifdef":
    case "preproc_else":
    case "preproc_elif":
    case "ERROR": {
      // ERROR is descended into on purpose: CUDA qualifiers put one in the middle of otherwise
      // perfectly good declarations, and refusing to look inside would lose every kernel.
      for (const child of node.namedChildren) visit(child, scope, ctx, out);
      return;
    }

    default:
      emitCallsIn(node, scope, ctx, out);
      return;
  }
}

function visitTemplated(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
  templateParams: string,
  lineStart: number,
): void {
  switch (node.type) {
    case "function_definition":
      visitFunction(node, scope, ctx, out, templateParams, lineStart, true);
      return;
    case "struct_specifier":
    case "class_specifier":
    case "union_specifier":
      visitRecord(node, scope, ctx, out, templateParams, lineStart);
      return;
    case "declaration":
    case "field_declaration":
      visitDeclaration(node, scope, ctx, out, templateParams, lineStart);
      return;
    case "alias_declaration":
    case "type_definition":
      visitAlias(node, scope, ctx, out);
      return;
    case "template_declaration":
      visit(node, scope, ctx, out);
      return;
    default:
      emitCallsIn(node, scope, ctx, out);
      return;
  }
}

function visitRecord(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
  templateParams: string,
  lineStart: number,
): void {
  const name = node.childForFieldName("name");
  const body = node.childForFieldName("body");
  // A forward declaration (`struct Foo;`) or an elaborated type use (`struct Foo x;`) has no body
  // and defines nothing; emitting a symbol for it would duplicate the real definition.
  if (name === null || body === null) return;
  const fqn = joinFqn(scope.prefix, name.text);
  const signature = signatureText(templateParams, null);
  const symbol = out.addSymbol({
    kind: "type",
    name: name.text,
    fqn,
    language: ctx.language,
    path: ctx.path,
    line_start: lineStart,
    line_end: endLineOf(node),
    signature: signature === "" ? null : signature,
    signature_hash: signature === "" ? null : signatureHash(signature),
  });

  const bases = node.childForFieldName("bases") ?? findChild(node, "base_class_clause");
  if (bases !== null) {
    for (const base of bases.namedChildren) {
      if (base.type === "access_specifier" || base.type === "virtual") continue;
      const baseName = typeNameOf(base);
      if (baseName === null || BUILTIN_TYPES.has(baseName)) continue;
      out.addEdge({
        src: symbol.key,
        kind: "implements",
        target: baseName,
        lookup: [joinFqn(scope.prefix, baseName), baseName, lastSegment(baseName)],
        path: ctx.path,
        line: lineOf(base),
      });
    }
  }

  // Member types are the type's composition, which is what "what breaks if I change this" needs.
  for (const field of body.namedChildren) {
    if (field.type === "field_declaration" && findFunctionDeclarator(field) === null) {
      emitTypeUses(field, symbol.key, ctx, out, scope);
    }
  }

  const inner: Scope = { prefix: fqn, selfType: fqn, owner: symbol.key, inFunctionBody: false };
  for (const child of body.namedChildren) visit(child, inner, ctx, out);
}

function visitFunction(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
  templateParams: string,
  lineStart: number,
  isDefinition: boolean,
): void {
  const declarator = findFunctionDeclarator(node);
  if (declarator === null) {
    // No name to attach anything to — a construct the grammar mangled badly enough that even the
    // declarator is gone. Descend into the CHILDREN, never back into this node: `emitCallsIn`
    // routes a `function_definition` to `visit`, which routes it straight back here, and on the
    // four Arc headers that hit this path the result was an unbounded mutual recursion that
    // surfaced as a bogus "parse failure".
    for (const child of node.namedChildren) emitCallsIn(child, scope, ctx, out);
    return;
  }
  const named = nameOfDeclarator(declarator);
  if (named === null) return;

  // Everything before the declarator is the return type plus its qualifiers, and it is the only
  // place the CUDA execution space appears — the grammar has already given up on it.
  const prefixText = ctx.source.slice(node.startIndex, declarator.startIndex);
  const isKernel = /__global__|__device__/.test(prefixText);
  const params = declarator.childForFieldName("parameters");
  const returns = prefixText.replace(STRIPPED_SPECIFIERS, " ");
  const signature = signatureText(`${templateParams}${params?.text ?? "()"}`, returns);

  const kind = isKernel ? "kernel" : named.qualifier !== null || scope.selfType !== null ? "method" : "function";
  // An out-of-line definition (`void ns::Cls::m()`) already carries its class in the qualifier, so
  // the qualifier is the namespace rather than the enclosing prefix repeated.
  const fqn =
    named.qualifier === null
      ? joinFqn(scope.prefix, named.name)
      : joinFqn(scope.prefix, `${named.qualifier}::${named.name}`);

  const symbol = out.addSymbol({
    kind,
    name: named.name,
    fqn,
    language: ctx.language,
    path: ctx.path,
    line_start: lineStart,
    line_end: endLineOf(node),
    visibility: /\bstatic\b/.test(prefixText) ? "static" : null,
    signature,
    signature_hash: signatureHash(signature),
    definition: isDefinition,
  });

  if (params !== null) emitTypeUses(params, symbol.key, ctx, out, scope);

  const body = node.childForFieldName("body");
  if (body === null) return;
  const selfType = named.qualifier === null ? scope.selfType : joinFqn(scope.prefix, named.qualifier);
  const inner: Scope = { prefix: fqn, selfType, owner: symbol.key, inFunctionBody: true };
  for (const child of body.namedChildren) visit(child, inner, ctx, out);
}

function visitDeclaration(
  node: TsNode,
  scope: Scope,
  ctx: FileContext,
  out: Collector,
  templateParams: string,
  lineStart: number,
): void {
  const declarator = findFunctionDeclarator(node);
  if (declarator !== null) {
    // A prototype: same shape as a definition, but marked as a declaration so the resolver can
    // drop it once the real definition turns up.
    visitFunction(node, scope, ctx, out, templateParams, lineStart, false);
    return;
  }
  // `constexpr int N = 4;` at file, namespace or class scope is a constant in the language's own
  // terms. Inside a function body it is a local, and locals are not symbols: they would outnumber
  // everything else in the index and answer no question anyone asks of it.
  if (scope.inFunctionBody) {
    emitCallsIn(node, scope, ctx, out);
    return;
  }
  const text = ctx.source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 200));
  const isConstant = /\b(?:constexpr|const)\b/.test(text) || /\bstatic\b.*=/.test(text);
  if (!isConstant) {
    emitCallsIn(node, scope, ctx, out);
    return;
  }
  // Only the declarator names the constant. The initialiser is a sibling node in a
  // `field_declaration` (`static constexpr uint32_t K = K_;` puts `K` in `declarator` and `K_` in
  // `default_value`), so scanning every identifier child would invent a second symbol named after
  // whatever the constant was initialised from.
  const valueStart = (node.childForFieldName("default_value") ?? node.childForFieldName("value"))?.startIndex ?? Infinity;
  const typeEnd = node.childForFieldName("type")?.endIndex ?? -1;
  for (const child of node.namedChildren) {
    if (child.startIndex >= valueStart || child.endIndex <= typeEnd) continue;
    const nameNode =
      child.type === "init_declarator"
        ? child.childForFieldName("declarator")
        : DECLARATOR_TYPES.has(child.type)
          ? child
          : null;
    if (nameNode === null) continue;
    const name = nameOfDeclarator(nameNode) ?? { name: nameNode.text, qualifier: null };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.name)) continue;
    const signature = signatureText(typeTextOf(node, ctx), null);
    out.addSymbol({
      kind: "constant",
      name: name.name,
      fqn: joinFqn(scope.prefix, name.name),
      language: ctx.language,
      path: ctx.path,
      line_start: lineStart,
      line_end: endLineOf(node),
      signature: signature === "" ? null : signature,
      signature_hash: signature === "" ? null : signatureHash(signature),
    });
  }
  emitCallsIn(node, scope, ctx, out);
}

function visitAlias(node: TsNode, scope: Scope, ctx: FileContext, out: Collector): void {
  // `using U = V<3>;` puts the new name first; `typedef struct {...} T;` puts it last.
  const name =
    node.type === "alias_declaration"
      ? node.childForFieldName("name")
      : node.childForFieldName("declarator") ?? node.namedChildren.at(-1) ?? null;
  if (name === null) return;
  const bare = nameOfDeclarator(name)?.name ?? name.text;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return;
  const symbol = out.addSymbol({
    kind: "type",
    name: bare,
    fqn: joinFqn(scope.prefix, bare),
    language: ctx.language,
    path: ctx.path,
    line_start: lineOf(node),
    line_end: endLineOf(node),
  });
  emitTypeUses(node, symbol.key, ctx, out, scope);
}

function emitCallsIn(node: TsNode, scope: Scope, ctx: FileContext, out: Collector): void {
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
          retagIfType: "instantiates",
        });
      }
      break;
    }
    case "new_expression": {
      const typeName = typeNameOf(node.childForFieldName("type"));
      if (typeName !== null && !BUILTIN_TYPES.has(typeName)) {
        out.addEdge({
          src: scope.owner,
          kind: "instantiates",
          target: typeName,
          lookup: [joinFqn(scope.prefix, typeName), typeName, lastSegment(typeName)],
          path: ctx.path,
          line: lineOf(node),
        });
      }
      break;
    }
    case "binary_expression": {
      // The kernel-launch rescue. See the note at the top of this file: `kern<<<g,b>>>(args)` is a
      // shift chain to the grammar, and it is the only edge tying host code to a kernel.
      const text = ctx.source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 512));
      const launch = KERNEL_LAUNCH.exec(text);
      if (launch !== null && launch[1] !== undefined) {
        const name = launch[1];
        out.addEdge({
          src: scope.owner,
          kind: "calls",
          target: name,
          lookup: [joinFqn(scope.prefix, name), name, lastSegment(name)],
          path: ctx.path,
          line: lineOf(node),
        });
      }
      break;
    }
    case "function_definition":
    case "struct_specifier":
    case "class_specifier":
    case "union_specifier":
    case "enum_specifier":
    case "namespace_definition":
    case "template_declaration":
    case "alias_declaration":
    case "type_definition":
    case "preproc_include":
    case "preproc_def":
    case "preproc_function_def":
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
      return {
        written: fn.text,
        lookup: [joinFqn(scope.prefix, fn.text), fn.text],
      };
    }
    case "qualified_identifier": {
      const written = stripTemplateArgs(fn.text);
      const bare = lastSegment(written);
      return { written, lookup: [joinFqn(scope.prefix, written), written, bare] };
    }
    case "field_expression": {
      const field = fn.childForFieldName("field");
      const argument = fn.childForFieldName("argument");
      if (field === null) return null;
      if (argument !== null && LITERAL_RECEIVERS.has(argument.type)) return null;
      const lookup: string[] = [];
      if (argument !== null && (argument.type === "this" || argument.text === "this") && scope.selfType !== null) {
        lookup.push(joinFqn(scope.selfType, field.text));
      }
      lookup.push(field.text);
      return { written: field.text, lookup };
    }
    case "template_function": {
      const name = fn.childForFieldName("name");
      return name === null ? null : callTarget(name, scope);
    }
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
  for (const node of container.descendantsOfType(["type_identifier", "qualified_identifier"])) {
    const name = typeNameOf(node);
    if (name === null || BUILTIN_TYPES.has(name) || BUILTIN_TYPES.has(lastSegment(name))) continue;
    // The CUDA qualifiers the grammar mis-parses as type names must not become type edges.
    if (name.startsWith("__") && /^__[a-z_]+__$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.addEdge({
      src,
      kind: "uses_type",
      target: name,
      lookup: [joinFqn(scope.prefix, name), name, lastSegment(name)],
      path: ctx.path,
      line: lineOf(node),
    });
  }
}

/** `#include "a/b.cuh"` and `#include <a/b.h>` both name a file; the extension is dropped. */
function includeTarget(node: TsNode): string | null {
  const path = node.childForFieldName("path");
  if (path === null) return null;
  const raw = path.text.replace(/^[<"]|[>"]$/g, "");
  const dot = raw.lastIndexOf(".");
  const slash = raw.lastIndexOf("/");
  const stripped = dot > slash ? raw.slice(0, dot) : raw;
  return stripped === "" ? null : stripped;
}

/** Unwrap `*`, `&` and `[]` layers to reach the `function_declarator` a definition really has. */
function findFunctionDeclarator(node: TsNode): TsNode | null {
  let current = node.childForFieldName("declarator");
  const guard = 8;
  for (let depth = 0; current !== null && depth < guard; depth++) {
    if (current.type === "function_declarator") return current;
    if (
      current.type === "pointer_declarator" ||
      current.type === "reference_declarator" ||
      current.type === "array_declarator" ||
      current.type === "parenthesized_declarator" ||
      current.type === "init_declarator"
    ) {
      current = current.childForFieldName("declarator") ?? current.namedChildren[0] ?? null;
      continue;
    }
    return null;
  }
  return null;
}

interface DeclaredName {
  name: string;
  /** The `Cls` of an out-of-line `void ns::Cls::m()`, or null for a plain name. */
  qualifier: string | null;
}

function nameOfDeclarator(declarator: TsNode): DeclaredName | null {
  let current: TsNode | null = declarator;
  const guard = 8;
  for (let depth = 0; current !== null && depth < guard; depth++) {
    switch (current.type) {
      case "identifier":
      case "field_identifier":
      case "type_identifier":
      case "primitive_type":
        return { name: current.text, qualifier: null };
      case "destructor_name":
      case "operator_name":
        return { name: stripTemplateArgs(current.text), qualifier: null };
      case "qualified_identifier": {
        const written = stripTemplateArgs(current.text);
        const segments = written.split("::");
        const name = segments.pop();
        if (name === undefined) return null;
        return { name, qualifier: segments.length === 0 ? null : segments.join("::") };
      }
      case "template_function": {
        current = current.childForFieldName("name");
        continue;
      }
      case "function_declarator":
      case "pointer_declarator":
      case "reference_declarator":
      case "array_declarator":
      case "parenthesized_declarator":
      case "init_declarator": {
        current = current.childForFieldName("declarator") ?? current.namedChildren[0] ?? null;
        continue;
      }
      default:
        return null;
    }
  }
  return null;
}

/** The declared type of a `declaration`, for a constant's signature. */
function typeTextOf(node: TsNode, ctx: FileContext): string {
  const type = node.childForFieldName("type");
  if (type !== null) return type.text;
  const first = node.namedChildren[0];
  return first === undefined ? "" : ctx.source.slice(node.startIndex, first.endIndex);
}

function typeNameOf(node: TsNode | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case "template_type":
      return typeNameOf(node.childForFieldName("name"));
    case "type_descriptor":
      return typeNameOf(node.childForFieldName("type"));
    case "sized_type_specifier":
    case "primitive_type":
      return null;
    case "qualified_identifier":
      return stripTemplateArgs(node.text);
    case "type_identifier":
      return node.text;
  }
  const stripped = stripTemplateArgs(node.text).trim();
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(stripped) ? stripped : null;
}

function stripTemplateArgs(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.trim();
}

function lastSegment(name: string): string {
  return name.split("::").at(-1) ?? name;
}

function findChild(node: TsNode, type: string): TsNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}
