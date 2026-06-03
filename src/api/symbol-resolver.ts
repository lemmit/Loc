// ---------------------------------------------------------------------------
// Shared symbol resolver for the navigational toolkit (agent-tools-and-mcp.md
// §4b).  Both the READ family (`navigate.ts`) and the REWRITE family
// (`refactor.ts`) address nodes BY SYMBOL NAME — a dotted path matched against
// the SAME address space `outline` / diagnostics use (`addressOf`) — instead of
// (line, character) offsets an LLM doesn't have.  This module owns the parse +
// resolve + name-token plumbing they both build on.
//
// Pure + browser-safe (EmptyFileSystem, no Node-only imports).
// ---------------------------------------------------------------------------

import {
  type AstNode,
  AstUtils,
  type CstNode,
  EmptyFileSystem,
  type LangiumDocument,
  URI,
} from "langium";
import type { JsonRange, NavError } from "../diagnostics/contract.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { addressOf } from "../language/print/index.js";

export type DddServices = ReturnType<typeof createDddServices>["Ddd"];

export interface Parsed {
  services: DddServices;
  doc: LangiumDocument<Model>;
  model: Model | undefined;
}

/** Parse a `.ddd` source and fully build it (link + validation) so the LSP
 *  providers and the cross-reference index are ready.  Fresh isolated services
 *  per call (no shared mutable state). */
export async function parse(source: string): Promise<Parsed> {
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
export function parentAddress(node: AstNode, own: string): string | undefined {
  let n: AstNode | undefined = node.$container;
  while (n) {
    const a = addressOf(n);
    if (a && a !== own) return a;
    n = n.$container;
  }
  return undefined;
}

export interface ResolvedSymbol {
  node: AstNode;
  address: string;
  kind: string;
}

/** Resolve a dotted `symbol` (optionally filtered by `kind`) to exactly one
 *  node, or a `NavError` carrying the candidate addresses.  Matches against
 *  every node's canonical `addressOf`, so the symbol space is identical to the
 *  outline's. */
export function resolveSymbol(
  model: Model,
  symbol: string,
  kind?: string,
): ResolvedSymbol | NavError {
  const wanted = symbol.split(".").filter((s) => s.length > 0);
  if (wanted.length === 0) return { error: "not-found", candidates: [] };

  const hits: ResolvedSymbol[] = [];
  for (const node of AstUtils.streamAllContents(model)) {
    // Only nodes with their OWN name are addressable by name — an unnamed
    // member (create / destroy / apply / invariant) takes the enclosing
    // entity's name as its address tail (`create Sales.Order`), which would
    // otherwise collide with the entity itself when resolving `Order`.
    const ownName = (node as { name?: unknown }).name;
    if (typeof ownName !== "string" || ownName.length === 0) continue;
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

  // De-duplicate by address — defensive against two same-named siblings (an
  // invalid model the validator flags) collapsing to one address.
  const byAddress = new Map<string, ResolvedSymbol>();
  for (const h of hits) if (!byAddress.has(h.address)) byAddress.set(h.address, h);
  const unique = [...byAddress.values()];

  if (unique.length === 0) return { error: "not-found", candidates: [] };
  if (unique.length > 1) {
    return { error: "ambiguous", candidates: unique.map((u) => u.address).sort() };
  }
  return unique[0]!;
}

export function isNavError(r: ResolvedSymbol | NavError): r is NavError {
  return "error" in r;
}

/** The name-token CST node of a resolved symbol, via the same `NameProvider`
 *  the references/rename providers use. */
export function nameCst(services: DddServices, node: AstNode): CstNode | undefined {
  return services.references.NameProvider.getNameNode(node);
}

/** Copy a CST/LSP range into a plain `JsonRange` (structurally identical, but
 *  decoupled from the langium object). */
export function toJsonRange(range: {
  start: JsonRange["start"];
  end: JsonRange["end"];
}): JsonRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}
