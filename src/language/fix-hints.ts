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

import { type AstNode, AstUtils, type LangiumDocument } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type { JsonFixHint } from "../diagnostics/contract.js";
import {
  isAggregate,
  isDeployable,
  isProperty,
  isSystem,
  isUi,
  type Property,
} from "./generated/ast.js";
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

/** Fix a frontend deployable missing its `ui:` binding by appending
 *  `ui: <UiName>` to the (order-independent) deployable body.  With exactly one
 *  system-scope `ui { … }` block the binding is unambiguous (a single `add`);
 *  with several, offer each as a `choose` option; with none there's nothing to
 *  bind, so no fix is offered (the author must declare a `ui` block first). */
function missingUiFix(
  _d: Diagnostic,
  _doc: LangiumDocument,
  node: AstNode,
): JsonFixHint | undefined {
  if (!isDeployable(node)) return undefined;
  const target = addressOf(node);
  const system = AstUtils.getContainerOfType(node, isSystem);
  if (!target || !system) return undefined;
  const uis = system.members.filter(isUi);
  if (uis.length === 0) return undefined;
  if (uis.length === 1) {
    return {
      kind: "insert-decl",
      summary: `Bind ui: ${uis[0].name}.`,
      patch: { op: "add", target, source: `ui: ${uis[0].name}` },
    };
  }
  return {
    kind: "choose",
    summary: "Bind one of the declared ui blocks.",
    options: uis.map((u) => ({
      summary: `ui: ${u.name}`,
      patch: { op: "add", target, source: `ui: ${u.name}` },
    })),
  };
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
  // onto its own table → add `inheritanceUsing: ownTable` to the aggregate
  // header (a position-aware `header-end` insert).  Only the absent-clause case
  // is auto-fixed; when the aggregate already declares `inheritanceUsing` it
  // needs a clause-replace (the clause isn't node-addressable), so skip.
  "loom.es-tph-forced-own-table": (_d, _doc, node) => {
    if (!isAggregate(node) || node.inheritanceUsing) return undefined;
    const target = addressOf(node);
    if (!target) return undefined;
    return {
      kind: "insert-decl",
      summary: "Use inheritanceUsing: ownTable.",
      patch: { op: "insert", target, position: "header-end", source: "inheritanceUsing: ownTable" },
    };
  },

  // `token status: Status?` → `token status: Status`.  A `token` field is
  // echoed by the client on every update to identify the target / detect
  // concurrency conflicts; a nullable token can't serve that role.  The repair
  // is unambiguous — drop the optional `?` — so it's the same "remove the
  // rejected marker" shape as `reserved-derived-on-vo`.  The `?` is the trailing
  // marker of the type's CST, sliced out while the rest of the member (incl. any
  // `= default`) is preserved verbatim.
  "loom.token-nullable": (_d, _doc, node) => {
    if (!isProperty(node)) return undefined;
    const prop = node as Property;
    const memberCst = prop.$cstNode;
    const typeCst = prop.type?.$cstNode;
    if (!prop.type?.optional || !memberCst || !typeCst) return undefined;
    const target = addressOf(prop);
    if (!target) return undefined;
    const relStart = typeCst.offset - memberCst.offset;
    const relEnd = relStart + typeCst.text.length;
    if (relStart < 0 || relEnd > memberCst.text.length) return undefined;
    const typeText = memberCst.text.slice(relStart, relEnd);
    const fixedType = typeText.replace(/\?(\s*)$/, "$1"); // drop the trailing `?`
    if (fixedType === typeText) return undefined;
    const source = memberCst.text.slice(0, relStart) + fixedType + memberCst.text.slice(relEnd);
    return {
      kind: "replace-text",
      summary: "Drop '?' — a token field must be non-optional.",
      patch: { op: "replace", target, source },
    };
  },

  // A frontend deployable (react/svelte/vue/angular) with no `ui:` binding →
  // append `ui: <UiName>`.  The deployable body's post-`platform` clauses are
  // order-independent, so the generic `add` op (append before `}`) is valid —
  // the previous "positional, can't auto-fix" note was stale.  One provider,
  // shared across the four per-platform codes.
  "loom.react-deployable-missing-ui": missingUiFix,
  "loom.svelte-deployable-missing-ui": missingUiFix,
  "loom.vue-deployable-missing-ui": missingUiFix,
  "loom.angular-deployable-missing-ui": missingUiFix,
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
