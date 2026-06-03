// ---------------------------------------------------------------------------
// Navigational toolkit — the REWRITE family (agent-tools-and-mcp.md §4b).
// rename / quickfix / unfold_macro RETURN edits (an `EditResult`), they never
// apply them — the host splices them into the buffer (contract §3: tools are
// pure).  All three address nodes by name via the shared `symbol-resolver`.
//
//   rename(source, symbol, newName)  → EditResult | EditError
//   quickfix(source, code, at?)      → EditResult | EditError
//   unfoldMacro(source, macro, on)   → EditResult | EditError
//
// Pure + browser-safe — same as the read family.
// ---------------------------------------------------------------------------

import { type AstNode, AstUtils } from "langium";
import type { TextEdit } from "vscode-languageserver-types";
import type {
  EditError,
  NavTextEdit,
  QuickfixResult,
  RenameResult,
  UnfoldMacroResult,
} from "../diagnostics/contract.js";
import { isMacroCall, type MacroCall } from "../language/generated/ast.js";
import { unfoldMacro as unfoldMacroCall } from "../language/lsp/unfold-macro.js";
import { resolvePatchEdits } from "../language/model-patch.js";
import { validate } from "./index.js";
import { isNavError, nameCst, parse, resolveSymbol } from "./symbol-resolver.js";

/** Map an LSP / patch text edit (already `{ range, newText }`-shaped) onto the
 *  contract's `NavTextEdit`, copying the range so it's decoupled from langium. */
function toNavEdit(e: { range: NavTextEdit["range"]; newText: string }): NavTextEdit {
  return {
    range: {
      start: { line: e.range.start.line, character: e.range.start.character },
      end: { line: e.range.end.line, character: e.range.end.character },
    },
    newText: e.newText,
  };
}

/** Rename a symbol — drives the rename provider at the resolved name token and
 *  returns the edits (declaration + every use site the providers compute),
 *  without applying them. */
export async function rename(
  source: string,
  symbol: string,
  newName: string,
): Promise<RenameResult> {
  const { services, doc, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, symbol);
  if (isNavError(resolved)) return resolved;
  const cst = nameCst(services, resolved.node);
  if (!cst) return { error: "not-found", candidates: [] };
  const edit = await services.lsp.RenameProvider!.rename(doc, {
    textDocument: { uri: doc.textDocument.uri },
    position: cst.range.start,
    newName,
  });
  const changes = edit?.changes?.[doc.textDocument.uri] ?? [];
  return { edits: (changes as TextEdit[]).map(toNavEdit) };
}

/** Produce the quick-fix edits for a diagnostic `code` — the `fixHint` patch
 *  resolved to text edits, returned (not applied).  `at` (a node address, e.g.
 *  `aggregate Sales.Order.status`) disambiguates when several diagnostics share
 *  the code.  No matching diagnostic → `not-found`; several and no `at` →
 *  `ambiguous`; a match with no fix → `no-fix`. */
export async function quickfix(source: string, code: string, at?: string): Promise<QuickfixResult> {
  const report = await validate(source);
  let matches = report.diagnostics.filter((d) => d.code === code);
  if (at) matches = matches.filter((d) => d.node === at);

  if (matches.length === 0) {
    return {
      error: "not-found",
      candidates: [],
      message: `no '${code}' diagnostic${at ? ` at ${at}` : ""}`,
    };
  }
  if (matches.length > 1) {
    return {
      error: "ambiguous",
      candidates: matches.map((d) => d.node ?? "<unlocated>").sort(),
      message: `${matches.length} '${code}' diagnostics — pass 'at' to pick one`,
    };
  }

  const diag = matches[0]!;
  const patch = diag.fixHint?.patch;
  if (!patch) return { error: "no-fix", message: `'${code}' has no fix-hint` };

  const resolved = await resolvePatchEdits(source, [patch]);
  if (!resolved.ok) {
    return { error: "no-fix", message: resolved.errors.map((e) => e.message).join("; ") };
  }
  return {
    edits: resolved.edits.map(toNavEdit),
    ...(diag.fixHint?.summary ? { title: diag.fixHint.summary } : {}),
  };
}

/** The macro call applied to `on` whose name is `macro`, or `undefined`. */
function findMacroCall(host: AstNode, macro: string): MacroCall | undefined {
  for (const node of AstUtils.streamAllContents(host)) {
    if (isMacroCall(node) && node.name === macro && node.$container.$container === host) {
      return node;
    }
  }
  return undefined;
}

/** Unfold a `with <macro>(...)` clause on host `on` into its expanded source —
 *  returns the edits (the `unfold-macro` refactor), not applied.  Host symbol
 *  unresolved → `not-found`; no such macro on it → `not-found` with the macros
 *  it does carry; un-unfoldable (unknown / kind-mismatch) → `cannot-unfold`. */
export async function unfoldMacro(
  source: string,
  macro: string,
  on: string,
): Promise<UnfoldMacroResult> {
  const { doc, model } = await parse(source);
  if (!model) return { error: "not-found", candidates: [] };
  const resolved = resolveSymbol(model, on);
  if (isNavError(resolved)) return resolved;

  const call = findMacroCall(resolved.node, macro);
  if (!call) {
    const available = [...AstUtils.streamAllContents(resolved.node)]
      .filter((n): n is MacroCall => isMacroCall(n) && n.$container.$container === resolved.node)
      .map((n) => n.name)
      .sort();
    const err: EditError = {
      error: "not-found",
      candidates: available,
      message: `no 'with ${macro}' on ${resolved.address}`,
    };
    return err;
  }

  const result = unfoldMacroCall(doc, call);
  if (!result) {
    return {
      error: "cannot-unfold",
      message: `'${macro}' on ${resolved.address} cannot be unfolded`,
    };
  }
  return { edits: result.edits.map(toNavEdit), title: result.title };
}
