// ---------------------------------------------------------------------------
// Navigational toolkit (agent-tools-and-mcp.md §4b) — the READ family over
// Loom's LSP providers, addressed BY SYMBOL NAME instead of (line, character).
// An LLM has a symbol name, not an offset, so every entry resolves a dotted
// symbol path against the SAME address space `outline` / diagnostics use
// (`addressOf`), then drives the existing provider at the resolved name token.
//
//   findSymbol(source, symbol, kind?) → NavSymbol | NavError
//   references(source, symbol)        → ReferencesResult
//   hover(source, symbol)             → HoverResult
//
// Pure + browser-safe (EmptyFileSystem, no Node-only imports) — same as the
// rest of `src/api/`.  The REWRITE family (rename / quickfix / unfold_macro,
// returning WorkspaceEdits) is a follow-up slice over this same resolver.
// ---------------------------------------------------------------------------

import { type AstNode, AstUtils, type CstNode, EmptyFileSystem, URI } from "langium";
import type {
  FindSymbolResult,
  HoverResult,
  JsonRange,
  NavError,
  ReferencesResult,
} from "../diagnostics/contract.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { addressOf } from "../language/print/index.js";

type DddServices = ReturnType<typeof createDddServices>["Ddd"];

interface Parsed {
  services: DddServices;
  doc: import("langium").LangiumDocument<Model>;
  model: Model | undefined;
}

/** Parse a `.ddd` source and fully build it (link + validation) so the LSP
 *  providers and the cross-reference index are ready.  Fresh isolated services
 *  per call (no shared mutable state). */
async function parse(source: string): Promise<Parsed> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const doc = factory.fromString<Model>(source, URI.parse("memory://source.ddd"));
  services.shared.workspace.LangiumDocuments.addDocument(doc);
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return { services, doc, model: doc.parseResult.value as Model | undefined };
}

/** A canonical address split into its keyword and dotted name segments —
 *  `"aggregate Sales.Order"` → `{ keyword: "aggregate", segments: ["Sales","Order"] }`. */
function splitAddress(address: string): { keyword: string; segments: string[] } | undefined {
  const space = address.indexOf(" ");
  if (space < 0) return undefined;
  const keyword = address.slice(0, space);
  const segments = address.slice(space + 1).split(".");
  return { keyword, segments };
}

// `addressOf` addresses a plain member (property / containment / derived /
// invariant) under its enclosing ENTITY's keyword, so the address keyword
// alone can't tell a property apart from its aggregate.  `kindOf` recovers the
// node's OWN semantic kind for the `kind` field + the `kind?` filter; it falls
// back to the address keyword for nodes whose keyword already is their kind
// (aggregate / operation / function / event / …).
const MEMBER_KIND: Record<string, string> = {
  Property: "property",
  Containment: "containment",
  DerivedProp: "derived",
  Invariant: "invariant",
  EnumValue: "value",
};

function kindOf(node: AstNode, addressKeyword: string): string {
  return MEMBER_KIND[node.$type] ?? addressKeyword;
}

/** Does the dotted `symbol` match the address `segments` — exact, or as a
 *  trailing suffix (the "short form when unambiguous" rule)?  `Order.customerId`
 *  matches `Sales.Order.customerId`; `customerId` matches it too. */
function matchesSuffix(symbol: string[], segments: string[]): boolean {
  if (symbol.length > segments.length) return false;
  const tail = segments.slice(segments.length - symbol.length);
  return symbol.every((s, i) => s === tail[i]);
}

/** The address of the nearest enclosing declaration with a DIFFERENT address —
 *  a member's owning aggregate, an aggregate's context, etc. */
function parentAddress(node: AstNode, own: string): string | undefined {
  let n: AstNode | undefined = node.$container;
  while (n) {
    const a = addressOf(n);
    if (a && a !== own) return a;
    n = n.$container;
  }
  return undefined;
}

interface ResolvedSymbol {
  node: AstNode;
  address: string;
  kind: string;
}

/** Resolve a dotted `symbol` (optionally filtered by `kind` keyword) to exactly
 *  one node, or a `NavError` carrying the candidate addresses.  Matches against
 *  every node's canonical `addressOf`, so the symbol space is identical to the
 *  outline's. */
function resolveSymbol(model: Model, symbol: string, kind?: string): ResolvedSymbol | NavError {
  const wanted = symbol.split(".").filter((s) => s.length > 0);
  if (wanted.length === 0) return { error: "not-found", candidates: [] };

  const hits: ResolvedSymbol[] = [];
  for (const node of AstUtils.streamAllContents(model)) {
    const address = addressOf(node);
    if (!address) continue;
    const split = splitAddress(address);
    if (!split) continue;
    const nodeKind = kindOf(node, split.keyword);
    if (kind && nodeKind !== kind) continue;
    if (matchesSuffix(wanted, split.segments)) {
      hits.push({ node, address, kind: nodeKind });
    }
  }

  // De-duplicate by address — a node can be streamed once, but a plain member
  // and its entity can share an address (unnamed invariant), so collapse those.
  const byAddress = new Map<string, ResolvedSymbol>();
  for (const h of hits) if (!byAddress.has(h.address)) byAddress.set(h.address, h);
  const unique = [...byAddress.values()];

  if (unique.length === 0) return { error: "not-found", candidates: [] };
  if (unique.length > 1) {
    return { error: "ambiguous", candidates: unique.map((u) => u.address).sort() };
  }
  return unique[0]!;
}

function isError(r: ResolvedSymbol | NavError): r is NavError {
  return "error" in r;
}

/** The name-token CST node of a resolved symbol, via the same `NameProvider`
 *  the references/rename providers use. */
function nameCst(services: DddServices, node: AstNode): CstNode | undefined {
  return services.references.NameProvider.getNameNode(node);
}

/** Copy a CST/LSP range into a plain `JsonRange` (structurally identical, but
 *  decoupled from the langium object). */
function toJsonRange(range: { start: JsonRange["start"]; end: JsonRange["end"] }): JsonRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

/** Locate a symbol — its canonical address, kind, name-token range, and parent
 *  declaration.  `kind` (a keyword like `aggregate` / `operation`) disambiguates
 *  when a name is shared across kinds. */
export async function findSymbol(
  source: string,
  symbol: string,
  kind?: string,
): Promise<FindSymbolResult> {
  const { services, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, symbol, kind);
  if (isError(resolved)) return resolved;
  const cst = nameCst(services, resolved.node);
  if (!cst) return { error: "not-found", candidates: [] };
  const parent = parentAddress(resolved.node, resolved.address);
  return {
    address: resolved.address,
    kind: resolved.kind,
    range: toJsonRange(cst.range),
    ...(parent ? { parent } : {}),
  };
}

/** Every usage site of a symbol (including its declaration) — drives the
 *  references provider at the resolved name token, returning single-document
 *  locations sorted by position. */
export async function references(source: string, symbol: string): Promise<ReferencesResult> {
  const { services, doc, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, symbol);
  if (isError(resolved)) return resolved;
  const cst = nameCst(services, resolved.node);
  if (!cst) return { error: "not-found", candidates: [] };
  const locations = await services.lsp.ReferencesProvider!.findReferences(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position: cst.range.start,
    context: { includeDeclaration: true },
  });
  const sorted = [...locations]
    .map((l) => ({ range: toJsonRange(l.range) }))
    .sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
  return { locations: sorted };
}

/** The hover bubble (markdown) for a symbol — drives the hover provider at the
 *  resolved name token. */
export async function hover(source: string, symbol: string): Promise<HoverResult> {
  const { services, doc, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, symbol);
  if (isError(resolved)) return resolved;
  const cst = nameCst(services, resolved.node);
  if (!cst) return { error: "not-found", candidates: [] };
  const result = await services.lsp.HoverProvider!.getHoverContent(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position: cst.range.start,
  });
  const contents = result?.contents;
  const markdown =
    contents && typeof contents === "object" && "value" in contents
      ? String((contents as { value: unknown }).value)
      : "";
  return { markdown };
}
