// ---------------------------------------------------------------------------
// Fix-hint providers — turn a diagnostic into an applyable model patch
// (docs/old/proposals/ai-diagnostics-contract.md §3.3).  This is what closes the
// validate→repair loop into a *self-suggesting* one: a diagnostic carries a
// `fixHint` whose `patch` the agent (or a human) hands straight to
// `applyPatches`, never reading generated code.
//
// Keyed by the stable `loom.*` code, so adding a fix for a new diagnostic is a
// one-entry change.  Providers run on CST-backed (Langium-phase) diagnostics,
// where the resolved AST node and source offsets are available.  (IR-phase
// diagnostics never reach here — `irDiagnosticToJson` has no CST to splice
// against — so a repair stated by an IR check is not expressible as a hint.)
//
// THREE SHAPES, reused by every provider below:
//   • replace-text via a CST slice — take the enclosing addressable node's
//     `$cstNode.text`, splice the repair into it, emit `{op:"replace"}`.
//   • drop the rejected marker — the same splice, but the spliced region is
//     the flagged one (the diagnostic's own range) rather than an insertion.
//   • insert a header clause — `{op:"insert", position:"header-end"}`.
//
// ADDRESSABILITY IS THE BINDING CONSTRAINT.  A `replace` patch resolves its
// `target` through `indexTargets` (src/language/model-patch.ts), which indexes
// declarations + the DIRECT members of an aggregate / value object — nothing
// deeper.  So a provider must hand back a patch addressed at a node that index
// contains, or none at all; a hint whose target doesn't resolve is worse than
// no hint (`applyPatches` rejects the whole batch).  Every provider therefore
// guards its container shape and returns `undefined` rather than guessing.
//
// Pure language-layer: AST + CST + addressOf only; no `ir/` edge.
// ---------------------------------------------------------------------------

import { type AstNode, AstUtils, type LangiumDocument } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type { JsonFixHint } from "../diagnostics/contract.js";
import {
  type Aggregate,
  isAggregate,
  isDeployable,
  isProperty,
  isSystem,
  isTestBlock,
  isUi,
  isValueObject,
  isWorkflow,
  type Property,
  type Workflow,
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

/** A member-level `replace` patch: swap the addressable node's whole source
 *  slice for `source` (the untouched bytes are copied verbatim, so the diff is
 *  exactly the repair).  `undefined` when the node has no canonical address. */
function replaceNode(node: AstNode, source: string, summary: string): JsonFixHint | undefined {
  const target = addressOf(node);
  if (!target) return undefined;
  return { kind: "replace-text", summary, patch: { op: "replace", target, source } };
}

/** A `header-end` insert: put `source` just before the declaration's opening
 *  `{` — the slot every header clause lives in (`persistedAs: eventLog`,
 *  `inheritanceUsing: ownTable`, `eventSourced`). */
function headerInsert(node: AstNode, source: string, summary: string): JsonFixHint | undefined {
  const target = addressOf(node);
  if (!target) return undefined;
  return {
    kind: "insert-decl",
    summary,
    patch: { op: "insert", target, position: "header-end", source },
  };
}

/** The flagged region, expressed as offsets into `host`'s CST text — the
 *  splice window every replace-text provider works in.  `undefined` when the
 *  diagnostic range doesn't land inside `host` (a defensive guard: the range
 *  and the node come from the same document, so it should always). */
function flagged(
  d: Diagnostic,
  doc: LangiumDocument,
  host: AstNode,
): { text: string; start: number; end: number } | undefined {
  const cst = host.$cstNode;
  if (!cst) return undefined;
  const start = doc.textDocument.offsetAt(d.range.start) - cst.offset;
  const end = doc.textDocument.offsetAt(d.range.end) - cst.offset;
  if (start < 0 || end > cst.text.length || start > end) return undefined;
  return { text: cst.text, start, end };
}

/** Cut `[from, to)` out of `text`, tidying the seam so the removal doesn't
 *  leave a doubled or leading/trailing space behind. */
function cutOut(text: string, from: number, to: number): string {
  let left = text.slice(0, from);
  let right = text.slice(to);
  if (left === "" || /[ \t]$/.test(left)) right = right.replace(/^[ \t]+/, "");
  if (right === "") left = left.replace(/[ \t]+$/, "");
  return left + right;
}

/** Drop the trailing `?` from a property's TYPE, returning the property's new
 *  source text.  Shared by the two "an optional marker was rejected here"
 *  providers (`token-nullable`, `entity-field-optional-collection`): both keep
 *  the rest of the member (`token`, `[]`, `= default`, …) verbatim and remove
 *  only the marker at the end of the type. */
function withoutTypeOptional(prop: Property): string | undefined {
  const memberCst = prop.$cstNode;
  const typeCst = prop.type?.$cstNode;
  if (!prop.type?.optional || !memberCst || !typeCst) return undefined;
  const relStart = typeCst.offset - memberCst.offset;
  const relEnd = relStart + typeCst.text.length;
  if (relStart < 0 || relEnd > memberCst.text.length) return undefined;
  const typeText = memberCst.text.slice(relStart, relEnd);
  const fixedType = typeText.replace(/\?(\s*)$/, "$1"); // drop the trailing `?`
  if (fixedType === typeText) return undefined;
  return memberCst.text.slice(0, relStart) + fixedType + memberCst.text.slice(relEnd);
}

/** The property a property-level diagnostic was raised on, but ONLY when it is
 *  a direct member of an aggregate / value object — the address space
 *  `indexTargets` covers.  A property inside an `entity` part addresses as
 *  `aggregate <Ctx>.<Agg>.<field>` too, which the index does NOT hold (and
 *  which could collide with a root field of the same name), so it is rejected
 *  rather than mis-targeted. */
function addressableProperty(node: AstNode): Property | undefined {
  const prop = AstUtils.getContainerOfType(node, isProperty);
  if (!prop) return undefined;
  const owner = prop.$container;
  return isAggregate(owner) || isValueObject(owner) ? prop : undefined;
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

/** True when a `header-end` insert is safe on this declaration.  The applier
 *  splices just before the opening `{`, and both aggregate and workflow put a
 *  TRAILING clause there that must stay last — the aggregate's `with …` macro
 *  clause, the workflow's `transactional` / `requires <expr>`.  With one of
 *  those present the insert would land after it and no longer parse, so no fix
 *  is offered. */
function headerInsertSafe(decl: Aggregate | Workflow): boolean {
  if (isAggregate(decl)) return decl.withClause === undefined;
  return !decl.transactional && decl.gate === undefined;
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

  // NOT PROVIDED — `loom.cross-aggregate-entity-part` (`line: Line` where the
  // part belongs to another aggregate → `line: <Owner> id`).  The diagnostic is
  // UNREACHABLE: `DddScopeProvider.localTypeScope` keeps a bare name in a type
  // position from resolving to an entity part of any OTHER aggregate (the
  // identity check `getContainerOfType(node, isAggregate) === aggregate`), so
  // such a reference fails LINKING and `checkTypeReferences` never sees a
  // resolved foreign part.  (The repo's own firing census agrees — the code sits
  // in `UNCOVERED` in test/system/diagnostic-firing-census.data.ts.)  A fix-hint
  // for a diagnostic nothing can raise is untestable, so it isn't written.

  // `derived display: string = …` on a value object → `display: string = …`.
  // `display`/`inspect` are reserved derived names meaningful only on
  // aggregates; on a VO they're rejected.  Dropping `derived` keeps the field
  // as an ordinary value-object property with its default (validates clean).
  "loom.reserved-derived-on-vo": (_d, _doc, node) => {
    const cst = node.$cstNode;
    if (!cst) return undefined;
    const source = cst.text.replace(/^derived\s+/, "");
    if (source === cst.text) return undefined; // no leading `derived` to drop
    return replaceNode(node, source, "Drop 'derived' — keep it as a value-object field.");
  },

  // An event-sourced / document concrete of a sharedTable (TPH) base is forced
  // onto its own table → add `inheritanceUsing: ownTable` to the aggregate
  // header (a position-aware `header-end` insert).  Only the absent-clause case
  // is auto-fixed; when the aggregate already declares `inheritanceUsing` it
  // needs a clause-replace (the clause isn't node-addressable), so skip.
  "loom.es-tph-forced-own-table": (_d, _doc, node) => {
    if (!isAggregate(node) || node.inheritanceUsing || !headerInsertSafe(node)) return undefined;
    return headerInsert(node, "inheritanceUsing: ownTable", "Use inheritanceUsing: ownTable.");
  },

  // `apply(e: Placed) { … }` on a state-truth aggregate → add `persistedAs:
  // eventLog` to the header, the repair the message states.  Only when the
  // aggregate declares no `persistedAs` of its own (otherwise the clause would
  // be duplicated rather than corrected).  NOTE the `#ir` twin of this code is
  // raised by the IR validator, which never reaches a fix-hint provider.
  "loom.applier-on-non-event-sourced": (_d, _doc, node) => {
    const agg = AstUtils.getContainerOfType(node, isAggregate);
    if (!agg || agg.persistedAs || !headerInsertSafe(agg)) return undefined;
    return headerInsert(agg, "persistedAs: eventLog", "Make the aggregate event-sourced.");
  },

  // The workflow twin: `apply(...)` in a workflow that isn't `eventSourced` →
  // add the marker to the workflow header.
  "loom.workflow-applier-on-non-event-sourced": (_d, _doc, node) => {
    const wf = AstUtils.getContainerOfType(node, isWorkflow);
    if (!wf || wf.eventSourced || !headerInsertSafe(wf)) return undefined;
    return headerInsert(wf, "eventSourced", "Make the workflow event-sourced.");
  },

  // `token status: Status?` → `token status: Status`.  A `token` field is
  // echoed by the client on every update to identify the target / detect
  // concurrency conflicts; a nullable token can't serve that role.  The repair
  // is unambiguous — drop the optional `?` — so it's the same "remove the
  // rejected marker" shape as `reserved-derived-on-vo`.
  "loom.token-nullable": (_d, _doc, node) => {
    const prop = addressableProperty(node);
    const source = prop ? withoutTypeOptional(prop) : undefined;
    if (!prop || source === undefined) return undefined;
    return replaceNode(prop, source, "Drop '?' — a token field must be non-optional.");
  },

  // `lines: Line[]?` on an entity-containing field → `lines: Line[]`.  An
  // empty collection already encodes absence, so the `?` is the rejected
  // marker; identical splice to `token-nullable`.
  "loom.entity-field-optional-collection": (_d, _doc, node) => {
    const prop = addressableProperty(node);
    const source = prop ? withoutTypeOptional(prop) : undefined;
    if (!prop || source === undefined) return undefined;
    return replaceNode(prop, source, "Drop '?' — an empty collection already encodes absence.");
  },

  // A value-property modifier on an entity-containing field (`provenanced
  // line: Line`, `line: Line = …`, `line: Line check …`) doesn't apply → drop
  // it.  The diagnostic's range is the offending modifier, so the splice window
  // is the flagged region itself — EXCEPT for the two clauses whose range covers
  // only their expression: `= <default>` and `check <expr> [message "…"]`, where
  // the leading keyword (and the check's trailing `message`) must go too or the
  // remainder doesn't parse.
  "loom.entity-field-modifier": (d, doc, node) => {
    const prop = addressableProperty(node);
    const base = prop?.$cstNode?.offset;
    if (!prop || base === undefined) return undefined;
    const r = flagged(d, doc, prop);
    if (!r || r.start === r.end) return undefined;
    let { start, end } = r;
    const before = r.text.slice(0, start);
    const relOf = (n: { $cstNode?: { offset: number } } | undefined): number | undefined =>
      n?.$cstNode ? n.$cstNode.offset - base : undefined;
    if (relOf(prop.check) === start) {
      const kw = /\bcheck\s*$/.exec(before);
      if (!kw) return undefined;
      start = kw.index;
      if (prop.message !== undefined) {
        // `message "…"` only parses attached to a `check`, so it goes with it.
        const msg = /^\s*message\s*"(?:[^"\\]|\\.)*"/.exec(r.text.slice(end));
        if (!msg) return undefined;
        end += msg[0].length;
      }
    } else if (relOf(prop.default) === start) {
      const eq = /=\s*$/.exec(before);
      if (!eq) return undefined;
      start = eq.index;
    }
    return replaceNode(
      prop,
      cutOut(r.text, start, end),
      "Drop the modifier — it doesn't apply to an entity-containing field.",
    );
  },

  // A `test` nested in its subject already targets it, so the `for <X>` head is
  // redundant → drop it.  The diagnostic's range is the `for` TARGET (the ref
  // text), so the cut extends back over the `for` keyword.  One provider for
  // both message variants (they attach to the same node + property) — but only
  // the subject-nested variant is addressable: a context-nested `test` is not in
  // `indexTargets`' address space, so no hint is offered there.
  "loom.test-redundant-for": (d, doc, node) => {
    const test = AstUtils.getContainerOfType(node, isTestBlock);
    if (!test) return undefined;
    const owner = test.$container;
    if (!isAggregate(owner) && !isValueObject(owner)) return undefined;
    const r = flagged(d, doc, test);
    if (!r || r.start === r.end) return undefined;
    const kw = /\bfor\s+$/.exec(r.text.slice(0, r.start));
    if (!kw) return undefined;
    return replaceNode(
      test,
      cutOut(r.text, kw.index, r.end),
      "Drop the redundant 'for' head — the test already belongs to its subject.",
    );
  },

  // NOT PROVIDED — `loom.tenancy-registry-marked` (the tenancy registry must not
  // carry `tenantOwned` → drop the marker).  It is raised by an IR check
  // (src/ir/validate/checks/tenancy-checks.ts) and IR diagnostics never reach a
  // provider: `irDiagnosticToJson` has no CST, no AST node, and no range to
  // splice against.  Providing it means first moving (or mirroring) the check
  // into the AST layer — a language change, not a hint.

  // NOT PROVIDED — `loom.bindable-input-value-arg` (`Field { value: x }` →
  // `bind: x`).  The repair is unambiguous, but a `page` is a `ui` MEMBER, and
  // `indexTargets` (src/language/model-patch.ts) indexes only system/context
  // declarations plus aggregate/value-object members: nothing under a `ui {…}`
  // block is addressable, so neither the offending builder entry NOR any
  // enclosing node (page, component, ui) can be a patch target.  It becomes
  // provideable when the address space grows a page/ui arm — not before.

  // A bare name that resolves to nothing, where the validator already computed
  // a did-you-mean candidate and handed it over on the diagnostic's `data`
  // channel → swap the typo for the suggestion.
  //
  // LIMITATION: `enclosingMember` only walks up to an `Aggregate`, so a typo
  // inside a workflow / projection body (or a value object's members) has no
  // addressable enclosing member here and gets no hint.  Widening the address
  // space is its own slice; guessing a target `applyPatches` can't resolve
  // would poison the whole batch, so those cases return `undefined`.
  "loom.unknown-name": (d, doc, node) => {
    const suggestion = (d.data as { suggestion?: unknown } | undefined)?.suggestion;
    if (typeof suggestion !== "string" || suggestion === "") return undefined;
    const member = enclosingMember(node);
    if (!member) return undefined;
    const r = flagged(d, doc, member);
    if (!r || r.start === r.end) return undefined;
    const source = `${r.text.slice(0, r.start)}${suggestion}${r.text.slice(r.end)}`;
    return replaceNode(member, source, `Did you mean '${suggestion}'?`);
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

/** Every `loom.*` code that carries a repair.  Exported so the coverage ratchet
 *  (`test/language/fix-hint-coverage.test.ts`) can check the registry against
 *  the wording catalog — a provider keyed to a code nothing emits is a fix no
 *  user can reach, which is exactly how the editor shipped a dead quick fix for
 *  `loom.framework-mismatch` through every green run. */
export const FIX_HINT_CODES: readonly string[] = Object.keys(PROVIDERS);

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
