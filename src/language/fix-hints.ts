// ---------------------------------------------------------------------------
// Fix-hint providers — turn a diagnostic into an applyable model patch
// (docs/old/proposals/ai-diagnostics-contract.md §3.3).  This is what closes the
// validate→repair loop into a *self-suggesting* one: a diagnostic carries a
// `fixHint` whose `patch` the agent (or a human) hands straight to
// `applyPatches`, never reading generated code.
//
// Keyed by the stable `loom.*` code, so adding a fix for a new diagnostic is a
// one-entry change.  Providers run on CST-backed (Langium-phase) diagnostics,
// where the resolved AST node and source offsets are available.
//
// Pure language-layer: AST + CST + addressOf only; no `ir/` edge.
// ---------------------------------------------------------------------------

import type { AstNode, LangiumDocument } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type { JsonFixHint } from "../diagnostics/contract.js";
import { isAggregate } from "./generated/ast.js";
import { addressOf } from "./print/outline.js";

/** The declaration node directly inside an aggregate that encloses `node`
 *  (a property, operation, …) — the unit a member-level patch replaces. */
function enclosingMember(node: AstNode): AstNode | undefined {
  let cur: AstNode | undefined = node;
  while (cur?.$container) {
    if (isAggregate(cur.$container)) return cur;
    cur = cur.$container;
  }
  return undefined;
}

type FixHintProvider = (
  d: Diagnostic,
  doc: LangiumDocument,
  node: AstNode,
) => JsonFixHint | undefined;

const PROVIDERS: Record<string, FixHintProvider> = {
  // `customer: Customer` → `customer: Customer id`
  // `lines: OrderLine[]`  → `lines: OrderLine id[]`
  // The " id" is inserted at the end of the offending type-name range, so the
  // `[]` collection suffix stays in the right place.
  "loom.bare-aggregate-in-type": (d, doc, node) => {
    const member = enclosingMember(node);
    const cst = member?.$cstNode;
    if (!member || !cst) return undefined;
    const target = addressOf(member);
    if (!target) return undefined;
    const insertAt = doc.textDocument.offsetAt(d.range.end) - cst.offset;
    if (insertAt < 0 || insertAt > cst.text.length) return undefined;
    const source = `${cst.text.slice(0, insertAt)} id${cst.text.slice(insertAt)}`;
    return {
      kind: "replace-text",
      summary: "Reference the aggregate by id.",
      patch: { op: "replace", target, source },
    };
  },

  // `derived display: string = …` on a value object → `display: string = …`.
  // `display`/`inspect` are reserved derived names meaningful only on
  // aggregates; on a VO they're rejected.  Dropping `derived` keeps the field
  // as an ordinary value-object property with its default (validates clean).
  "loom.reserved-derived-on-vo": (_d, _doc, node) => {
    const cst = node.$cstNode;
    if (!cst) return undefined;
    const target = addressOf(node);
    if (!target) return undefined;
    const source = cst.text.replace(/^derived\s+/, "");
    if (source === cst.text) return undefined; // no leading `derived` to drop
    return {
      kind: "replace-text",
      summary: "Drop 'derived' — keep it as a value-object field.",
      patch: { op: "replace", target, source },
    };
  },

  // An event-sourced / document concrete of a sharedTable (TPH) base is forced
  // onto its own table → add `inheritanceUsing(ownTable)` to the aggregate
  // header (a position-aware `header-end` insert).  Only the absent-clause case
  // is auto-fixed; when the aggregate already declares `inheritanceUsing` it
  // needs a clause-replace (the clause isn't node-addressable), so skip.
  "loom.es-tph-forced-own-table": (_d, _doc, node) => {
    if (!isAggregate(node) || node.inheritanceUsing) return undefined;
    const target = addressOf(node);
    if (!target) return undefined;
    return {
      kind: "insert-decl",
      summary: "Use inheritanceUsing(ownTable).",
      patch: { op: "insert", target, position: "header-end", source: "inheritanceUsing(ownTable)" },
    };
  },

  // NB: `loom.react-deployable-missing-ui` is intentionally NOT auto-fixed.
  // The fix is `add ui: <Name>`, but the deployable body is a *positional*
  // grammar (the `ui:` binding has a fixed slot), so the generic `add` op
  // (append before `}`) produces invalid source.  It needs a position-aware
  // "insert into a sequenced body" patch kind — tracked in
  // docs/old/proposals/agent-tools-and-mcp.md §4c.
};

/**
 * Build a fix-hint for a CST-backed diagnostic, or `undefined` when no provider
 * is registered for its code (fixHints are optional — contract §3.3).
 */
export function fixHintFor(
  d: Diagnostic,
  doc: LangiumDocument,
  node: AstNode,
): JsonFixHint | undefined {
  const code = typeof d.code === "string" ? d.code : undefined;
  return code ? PROVIDERS[code]?.(d, doc, node) : undefined;
}
