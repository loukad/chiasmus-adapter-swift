/**
 * chiasmus-adapter-swift
 *
 * Swift language adapter for chiasmus, built on tree-sitter-swift
 * (alex-pinkus/tree-sitter-swift). Walks the parsed AST and emits the
 * CodeGraph fact set: defines, calls, imports, exports, contains.
 */

// Structural mirror of chiasmus's CodeGraph types. Re-declared locally so
// the adapter has no runtime dependency on the chiasmus package; field
// shapes must match `chiasmus/dist/graph/types.d.ts`.
type SymbolKind = "function" | "method" | "class" | "interface" | "variable";

interface DefinesFact {
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
  signature?: string;
}
interface CallsFact { caller: string; callee: string; calleeQN?: string }
interface ImportsFact { file: string; name: string; source: string; resolved?: string }
interface ExportsFact { file: string; name: string }
interface ContainsFact { parent: string; child: string }
interface CodeGraph {
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
}

interface LanguageAdapter {
  language: string;
  extensions: string[];
  grammar: { package: string; moduleExport?: string; wasm?: false }
         | { package: string; wasmFile: string; wasm: true };
  extract(rootNode: any, filePath: string): CodeGraph;
  searchPaths?: string[];
}

// ── Walker state ────────────────────────────────────────────────────

interface State {
  filePath: string;
  defines: DefinesFact[];
  calls: CallsFact[];
  imports: ImportsFact[];
  exports: ExportsFact[];
  contains: ContainsFact[];
  callSet: Set<string>;
  defineKeySet: Set<string>;
}

function newState(filePath: string): State {
  return {
    filePath,
    defines: [],
    calls: [],
    imports: [],
    exports: [],
    contains: [],
    callSet: new Set(),
    defineKeySet: new Set(),
  };
}

function pushDefine(s: State, def: DefinesFact): void {
  // Dedup on (name, kind, line) — tree-sitter occasionally re-yields the
  // same node under error recovery; the suffix-index downstream prefers
  // unique entries.
  const key = `${def.name}|${def.kind}|${def.line}`;
  if (s.defineKeySet.has(key)) return;
  s.defineKeySet.add(key);
  s.defines.push(def);
}

function pushCall(s: State, caller: string, callee: string): void {
  const key = `${caller}->${callee}`;
  if (s.callSet.has(key)) return;
  s.callSet.add(key);
  s.calls.push({ caller, callee });
}

// ── Node helpers ────────────────────────────────────────────────────

function namedChildren(node: any): any[] {
  const out: any[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i));
  return out;
}

function firstChildOfType(node: any, type: string): any | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function findDescendantOfType(node: any, type: string): any | null {
  if (!node) return null;
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const hit = findDescendantOfType(node.namedChild(i), type);
    if (hit) return hit;
  }
  return null;
}

// ── Top-level dispatch ──────────────────────────────────────────────

export function extractSwift(rootNode: any, filePath: string): CodeGraph {
  const s = newState(filePath);

  for (const child of namedChildren(rootNode)) {
    walkTopLevel(child, s);
  }

  return {
    defines: s.defines,
    calls: s.calls,
    imports: s.imports,
    exports: s.exports,
    contains: s.contains,
  };
}

function walkTopLevel(node: any, s: State): void {
  switch (node.type) {
    case "import_declaration":
      handleImport(node, s);
      return;

    case "function_declaration": {
      // Free function at module scope.
      const name = simpleNameOf(node);
      if (!name) return;
      pushDefine(s, {
        file: s.filePath, name, kind: "function",
        line: node.startPosition.row + 1,
        signature: signatureOf(node),
      });
      walkCalls(firstChildOfType(node, "function_body"), name, s);
      return;
    }

    case "protocol_declaration":
      handleProtocol(node, s);
      return;

    case "class_declaration":
      handleClassLike(node, s);
      return;

    // Other top-level shapes (typealias, property, operator, etc.) are
    // ignored — they don't contribute callable defines or calls.
  }
}

// ── Imports ─────────────────────────────────────────────────────────

function handleImport(node: any, s: State): void {
  // import_declaration → identifier → simple_identifier ("Foundation")
  // For dotted imports like `import Foo.Bar`, the identifier child has
  // multiple simple_identifier children — join with "." for the source,
  // use the leaf name as the binding name.
  const ident = firstChildOfType(node, "identifier");
  if (!ident) return;
  const parts: string[] = [];
  for (let i = 0; i < ident.namedChildCount; i++) {
    const c = ident.namedChild(i);
    if (c.type === "simple_identifier") parts.push(c.text);
  }
  if (parts.length === 0) return;
  const source = parts.join(".");
  const name = parts[parts.length - 1]!;
  s.imports.push({ file: s.filePath, name, source });
}

// ── Protocols ───────────────────────────────────────────────────────

function handleProtocol(node: any, s: State): void {
  const nameNode = firstChildOfType(node, "type_identifier");
  if (!nameNode) return;
  const name = nameNode.text;
  pushDefine(s, {
    file: s.filePath, name, kind: "interface",
    line: node.startPosition.row + 1,
  });
  s.exports.push({ file: s.filePath, name });

  const body = firstChildOfType(node, "protocol_body");
  if (!body) return;
  for (const member of namedChildren(body)) {
    if (member.type === "protocol_function_declaration") {
      const mName = simpleNameOf(member);
      if (!mName) continue;
      pushDefine(s, {
        file: s.filePath, name: mName, kind: "method",
        line: member.startPosition.row + 1,
        signature: signatureOf(member),
      });
      s.contains.push({ parent: name, child: mName });
    }
  }
}

// ── Classes / structs / enums / extensions ──────────────────────────

function handleClassLike(node: any, s: State): void {
  // tree-sitter-swift uses `class_declaration` for class, struct, enum,
  // and extension. Disambiguate by:
  //   - first named child shape: `type_identifier` (class/struct/enum)
  //     or `user_type` (extension — name lives one level deeper)
  //   - body type: `class_body` (class/struct/extension) or
  //     `enum_class_body` (enum)
  let isExtension = false;
  let typeName: string | null = null;

  const first = node.namedChild(0);
  if (!first) return;
  if (first.type === "type_identifier") {
    typeName = first.text;
  } else if (first.type === "user_type") {
    isExtension = true;
    const id = findDescendantOfType(first, "type_identifier");
    typeName = id?.text ?? null;
  }
  if (!typeName) return;

  const body =
    firstChildOfType(node, "class_body") ??
    firstChildOfType(node, "enum_class_body");

  // Emit a define for the type itself only on the original declaration,
  // not on extensions — extensions augment an already-defined type.
  if (!isExtension) {
    pushDefine(s, {
      file: s.filePath, name: typeName, kind: "class",
      line: node.startPosition.row + 1,
    });
    s.exports.push({ file: s.filePath, name: typeName });
  }

  if (!body) return;
  for (const member of namedChildren(body)) {
    handleMember(member, typeName, s);
  }
}

function handleMember(member: any, parentType: string, s: State): void {
  switch (member.type) {
    case "function_declaration": {
      const name = simpleNameOf(member);
      if (!name) return;
      pushDefine(s, {
        file: s.filePath, name, kind: "method",
        line: member.startPosition.row + 1,
        signature: signatureOf(member),
      });
      s.contains.push({ parent: parentType, child: name });
      walkCalls(firstChildOfType(member, "function_body"), name, s);
      return;
    }

    case "init_declaration":
    case "deinit_declaration": {
      const name = member.type === "init_declaration" ? "init" : "deinit";
      pushDefine(s, {
        file: s.filePath, name, kind: "method",
        line: member.startPosition.row + 1,
        signature: signatureOf(member),
      });
      s.contains.push({ parent: parentType, child: name });
      walkCalls(firstChildOfType(member, "function_body"), name, s);
      return;
    }

    case "subscript_declaration": {
      pushDefine(s, {
        file: s.filePath, name: "subscript", kind: "method",
        line: member.startPosition.row + 1,
      });
      s.contains.push({ parent: parentType, child: "subscript" });
      // Subscript bodies are getter/setter blocks; recurse for nested calls
      // attributed to the parent method label "subscript".
      for (const c of namedChildren(member)) walkCalls(c, "subscript", s);
      return;
    }

    // property_declaration, enum_entry, type_alias, etc. — no callable
    // defines. We deliberately skip them in the MVP.
  }
}

// ── Names and signatures ────────────────────────────────────────────

function simpleNameOf(declNode: any): string | null {
  // function_declaration / protocol_function_declaration: first
  // simple_identifier child (after optional `modifiers`).
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const c = declNode.namedChild(i);
    if (c.type === "simple_identifier") return c.text;
  }
  return null;
}

function signatureOf(declNode: any): string | undefined {
  // Cheap: the source slice from the start of the declaration up to (but
  // not including) the function_body / protocol body / next sibling. For
  // protocol methods there's no body, so use the full node text.
  const body = firstChildOfType(declNode, "function_body");
  if (!body) return declNode.text.replace(/\s+/g, " ").trim();
  const start = declNode.startIndex;
  const end = body.startIndex;
  // Some tree-sitter bindings don't expose startIndex; guard by feature.
  if (typeof start === "number" && typeof end === "number" && end > start) {
    const buf = (declNode.tree?.input ?? declNode.text);
    if (typeof buf === "string") {
      return buf.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return declNode.text.replace(/\s+/g, " ").trim();
}

// ── Calls ───────────────────────────────────────────────────────────

function walkCalls(node: any, caller: string, s: State): void {
  if (!node) return;
  if (node.type === "call_expression") {
    const callee = resolveCallee(node);
    if (callee) pushCall(s, caller, callee);
    // Continue descent — nested calls are separate call_expression nodes.
  }

  // Don't descend into nested function/closure bodies; their calls
  // belong to the inner scope, not `caller`. tree-sitter-swift uses
  // `function_declaration` (nested) and `lambda_literal` for closures.
  if (node.type === "function_declaration" || node.type === "lambda_literal") {
    // Recurse into nested function bodies under their own caller name
    // when we can; otherwise skip. For an MVP we attribute closure calls
    // to the enclosing function — that overcounts, but never undercounts.
    if (node.type === "function_declaration") {
      const innerName = simpleNameOf(node);
      if (innerName) {
        pushDefine(s, {
          file: s.filePath, name: innerName, kind: "function",
          line: node.startPosition.row + 1,
        });
        walkCalls(firstChildOfType(node, "function_body"), innerName, s);
        return;
      }
    }
    // Lambda: keep ascribing calls to the outer caller.
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    walkCalls(node.namedChild(i), caller, s);
  }
}

function resolveCallee(callNode: any): string | null {
  // call_expression first named child is the callee expression.
  const head = callNode.namedChild(0);
  if (!head) return null;

  if (head.type === "simple_identifier") return head.text;

  if (head.type === "navigation_expression") {
    // Take the rightmost navigation_suffix > simple_identifier.
    let suffix: any = null;
    for (let i = head.namedChildCount - 1; i >= 0; i--) {
      const c = head.namedChild(i);
      if (c.type === "navigation_suffix") { suffix = c; break; }
    }
    if (suffix) {
      const id = findDescendantOfType(suffix, "simple_identifier");
      return id?.text ?? null;
    }
  }

  // Fallback: deepest leading simple_identifier.
  const id = findDescendantOfType(head, "simple_identifier");
  return id?.text ?? null;
}

// ── Adapter export ──────────────────────────────────────────────────

const adapter: LanguageAdapter = {
  language: "swift",
  extensions: [".swift"],
  grammar: { package: "tree-sitter-swift" },
  extract: extractSwift,
};

export default adapter;
