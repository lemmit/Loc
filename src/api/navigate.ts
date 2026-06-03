// ---------------------------------------------------------------------------
// Navigational toolkit — the READ family (agent-tools-and-mcp.md §4b).
// Addresses nodes BY SYMBOL NAME via the shared `symbol-resolver`, then drives
// the existing references / hover LSP providers at the resolved name token.
//
//   findSymbol(source, symbol, kind?) → NavSymbol | NavError
//   references(source, symbol)        → ReferencesResult
//   hover(source, symbol)             → HoverResult
//
// Pure + browser-safe.  The REWRITE family (rename / quickfix / unfold_macro,
// returning WorkspaceEdits) lives in `refactor.ts` over the same resolver.
// ---------------------------------------------------------------------------

import type { FindSymbolResult, HoverResult, ReferencesResult } from "../diagnostics/contract.js";
import {
  isNavError,
  nameCst,
  parentAddress,
  parse,
  resolveSymbol,
  toJsonRange,
} from "./symbol-resolver.js";

/** Locate a symbol — its canonical address, kind, name-token range, and parent
 *  declaration.  `kind` (e.g. `aggregate` / `operation` / `property`)
 *  disambiguates when a name is shared across kinds. */
export async function findSymbol(
  source: string,
  symbol: string,
  kind?: string,
): Promise<FindSymbolResult> {
  const { services, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, symbol, kind);
  if (isNavError(resolved)) return resolved;
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
  if (isNavError(resolved)) return resolved;
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
  if (isNavError(resolved)) return resolved;
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
