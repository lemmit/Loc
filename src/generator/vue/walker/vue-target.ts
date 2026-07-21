// ---------------------------------------------------------------------------
// Vue `WalkerTarget` — Vue-3-flavoured implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope, and
// `docs/old/plans/vue-frontend-plan.md` for the platform plan.
//
// Generated pages are SFCs with a `<script setup lang="ts">` block:
// state fields are `ref()`s and API handles are vue-query composables
// hoisted in the script block.  Everything the WALKER emits lands in
// the SFC `<template>` (mustaches, directive attrs, inline handlers),
// where Vue auto-unwraps top-level refs and compiles assignments to
// them — so state reads/writes are bare names in both contract
// positions; only the page shell's own script-side code touches
// `.value`.
// ---------------------------------------------------------------------------

import type { ExprIR, TypeIR } from "../../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "../../_walker/api-hook-detector.js";
import { jsExprLeaves } from "../../_walker/js-expr-leaves.js";
import {
  defaultInitForJs,
  escapeJsFamilyText,
  hookFnName,
  hookVarName,
  lowerFirstName,
  referencesIdent,
  renderJsMatch,
  renderJsVariantMatch,
  upperFirstName,
} from "../../_walker/js-target-helpers.js";
import type {
  ApiCallSite,
  RenderPosition,
  StateRef,
  TargetHookUse,
  VariantMatchSpec,
  WalkerTarget,
} from "../../_walker/target.js";
import { renderVueDestroyForm } from "./destroy-form.js";

/** Attribute-quote a rendered JS/binding expression for a Vue directive
 *  value (`:key`, `v-if`, `v-for`, `v-else-if`, testid, …).  Vue decodes
 *  HTML entities in attribute values BEFORE compiling the expression, so
 *  an expression carrying BOTH quote kinds is ESCAPED (the delimiter char
 *  → its entity) rather than rejected — every valid `.ddd` expression
 *  renders (React/Svelte emit these fine, so Vue must too; a hard throw
 *  aborted the whole system's Vue codegen — audit finding B21).
 *
 *  `prefer` picks the delimiter when the expression is quote-free or the
 *  preferred quote is absent, so callers stay byte-identical to their old
 *  hand-rolled quote selection:
 *    - `'"'` (default) — double-quote first (renderAttrBinding / v-for /
 *      match predicate): JS string literals render double-quoted, so a
 *      `"`-bearing expression binds single-quoted; a both-quote expression
 *      escapes `"`→`&quot;` under a `"` delimiter.
 *    - `"'"` — single-quote first (renderConditionalChild): the condition
 *      commonly carries double-quoted JS string literals
 *      (`role === "manager"`), so a single delimiter keeps them intact; a
 *      both-quote condition escapes `'`→`&#39;` under a `'` delimiter.
 *
 *  `&` is entity-escaped first in the both-quote branch so a literal `&`
 *  in the expression can't combine with the injected entity. */
function quoteAttrExpr(expr: string, prefer: '"' | "'" = '"'): string {
  const hasDouble = expr.includes('"');
  const hasSingle = expr.includes("'");
  if (prefer === '"') {
    if (!hasDouble) return `"${expr}"`;
    if (!hasSingle) return `'${expr}'`;
    return `"${expr.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  }
  if (!hasSingle) return `'${expr}'`;
  if (!hasDouble) return `"${expr}"`;
  return `'${expr.replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'`;
}

/** Vue-flavoured `WalkerTarget`.  Stateless and pure — no walker
 *  context is captured; every method takes the data it needs.
 *  Consumed by the cross-target conformance test and (from the
 *  generator-core slice on) the shared markup walker. */
export const vueTarget: WalkerTarget = {
  framework: "vue",
  // Expression-syntax leaves (JS) — shared by all JSX-family frontends.
  ...jsExprLeaves,

  // --- State seam ---------------------------------------------------------

  /** Bare name in BOTH positions: every expression the shared walker
   *  emits lands inside the SFC `<template>` (mustaches, `v-if`
   *  attrs, inline `@click` handlers) where Vue auto-unwraps
   *  top-level refs — and Vue compiles assignments to setup refs in
   *  inline handlers too.  Script-position code is the page shell's
   *  own (it writes `.value` itself). */
  renderStateRead(ref: StateRef, _position: RenderPosition): string {
    return ref.name;
  },

  /** `step = <expr>` — `state :=` writes occur inside inline
   *  template handlers where the SFC compiler rewrites unwrapped-ref
   *  assignment; `.value` there would dereference the unwrapped
   *  value instead. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `${ref.name} = ${value}`;
  },

  /** In-place nested mutation — `order.shipping.zip = v`.  The SFC
   *  compiler unwraps the top-level ref (`order` → `order.value`) inside
   *  the inline handler, so the deep assignment is reactive; no spread,
   *  no setter (unlike React). */
  renderNestedStateWrite(segments: readonly string[], valueJs: string): string {
    return `${segments.join(".")} = ${valueJs}`;
  },

  // --- Interactive-table seam (M-T1.1) ------------------------------------

  /** A `@click` header driving client-side sort.  Vue writes state
   *  in-place (`sortKey = 'name'`); the SFC compiler unwraps the ref in
   *  the inline handler.  Text interpolation is `{{ … }}`. */
  renderSortableHeader(spec) {
    const { header, field, sortKey, sortDir } = spec;
    const k = sortKey.name;
    const d = sortDir.name;
    const q = `'${field}'`;
    const onClick =
      `${k} === ${q} ? (${d} = ${d} === 'asc' ? 'desc' : 'asc') ` + `: (${k} = ${q}, ${d} = 'asc')`;
    const indicator = `{{ ${k} === ${q} ? (${d} === 'asc' ? ' ↑' : ' ↓') : '' }}`;
    // A real `<button>` (not a clickable `<span>`) so the header is keyboard-
    // focusable + carries an implicit ARIA role (a11y gates reject a span with
    // `@click`).  The style resets the native button chrome to read as a header.
    const style =
      "background: none; border: none; padding: 0; font: inherit; cursor: pointer; user-select: none;";
    return `<button type="button" style="${style}" @click="${onClick}">${header}${indicator}</button>`;
  },

  /** Sort the rows via the shared `sortRows` helper — Vue's strict template
   *  can't carry the inline `as`-cast comparator React uses, so the typed
   *  dynamic-key indexing lives in `src/lib/table-sort.ts` and the `v-for`
   *  expression just calls it.  Refs auto-unwrap in the template. */
  renderSortedRows(rowsExpr, sortKey, sortDir) {
    return `sortRows(${rowsExpr}, ${sortKey.name}, ${sortDir.name})`;
  },

  /** Prev / "Page N of M" / Next pager.  `:disabled` + `@click` bindings write
   *  the ref in place (SFC unwrap); `Math` is on Vue's template global allow-
   *  list, so the "of M" label computes inline. */
  renderPager(spec) {
    const p = spec.page.name;
    const pages = spec.totalPagesExpr;
    const style =
      "display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem;";
    return (
      `<div style="${style}" data-testid="pager">` +
      `<button type="button" :disabled="${p} <= 1" @click="${p} = ${p} - 1">Prev</button>` +
      `<span>Page {{ ${p} }} of {{ ${pages} }}</span>` +
      `<button type="button" :disabled="${p} >= ${pages}" @click="${p} = ${p} + 1">Next</button>` +
      `</div>`
    );
  },

  /** A `v-model` search box driving the client-side filter — two-way binds the
   *  ref (the SFC compiler unwraps it), so no manual event cast is needed. */
  renderFilterInput(filter) {
    const style = "margin-bottom: 0.75rem; padding: 0.375rem 0.5rem;";
    return (
      `<input type="search" v-model="${filter.name}" placeholder="Filter…" ` +
      `aria-label="Filter table" style="${style}" data-testid="table-filter" />`
    );
  },

  /** Filter via the shared `filterRows` helper — Vue's strict template can't
   *  carry the inline `Object.values` cast, so the logic lives in
   *  `src/lib/table-sort.ts` and the `v-for` expression just calls it.  Refs
   *  auto-unwrap in the template. */
  renderFilteredRows(rowsExpr, filter) {
    return `filterRows(${rowsExpr}, ${filter.name})`;
  },

  // --- API binding seam ---------------------------------------------------

  /** Turn a detected api call into vue-query composable naming +
   *  import.  Deliberately the SAME naming formula as React
   *  (`useCreateCustomer` / `../api/customer`): the `use*` prefix is
   *  Vue's composable convention too, and keeping the generated api
   *  module surface name-identical across the two SPA frontends
   *  keeps the api-builder shareable. */
  buildHookUse(detected: DetectedApiCall, renderArg: (e: ExprIR) => string): TargetHookUse {
    if (detected.kind === "workflow-instance") {
      const wf = upperFirstName(detected.aggregateName);
      const isAll = detected.operation === "all";
      return {
        varName: isAll ? `all${wf}Instances` : `${lowerFirstName(detected.aggregateName)}Instance`,
        hookName: isAll ? `useAll${wf}Instances` : `use${wf}InstanceById`,
        importFrom: "../api/workflows",
        argsRendered: detected.args.map(renderArg),
      };
    }
    const aggregate = detected.aggregateName;
    const op = detected.operation;
    return {
      varName: hookVarName(aggregate, op),
      hookName: hookFnName(aggregate, op),
      importFrom: `../api/${lowerFirstName(upperFirstName(aggregate))}`,
      argsRendered: detected.args.map(renderArg),
    };
  },

  /** Var-only, like TSX: the composable handle is hoisted ONCE in
   *  `<script setup>` and every IR call site references the var;
   *  chained access (`.data` / `.mutate(args)` / `.isPending`)
   *  comes from the surrounding IR walk.  The generator-core slice
   *  validates the `@tanstack/vue-query` handle shape against this
   *  surface (the hoisting wraps the handle so nested refs read
   *  uniformly in template + script positions — see
   *  `renderApiHoisting`). */
  renderApiCall(call: ApiCallSite, _renderedArgs: string): string {
    return call.varName ?? hookVarName(call.aggregateName, call.operation);
  },

  /** Hoist one `const <var> = <hook>(args);` line per unique hook
   *  usage in `<script setup>`.  Same de-dupe + fallback semantics
   *  as `tsxTarget.renderApiHoisting` (varName/hookName/argsRendered
   *  pass through verbatim when supplied). */
  renderApiHoisting(uses: ApiCallSite[]): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of uses) {
      const varName = u.varName ?? hookVarName(u.aggregateName, u.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      const hookName = u.hookName ?? hookFnName(u.aggregateName, u.operation);
      const args = u.argsRendered ?? [];
      lines.push(`const ${varName} = ${hookName}(${args.join(", ")});`);
    }
    return lines;
  },

  // --- Match expression seam ----------------------------------------------

  /** Chained ternaries — identical to TSX.  Vue template
   *  interpolation (`{{ … }}`) and script position both evaluate JS
   *  expressions, so the ternary chain is correct in either; markup-
   *  valued conditional CHILDREN go through `renderConditionalChild`
   *  (`<template v-if>` blocks) instead. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    return renderJsMatch(arms, elseArm);
  },

  /** Child-position match — a structural `<template v-if>` /
   *  `v-else-if` / `v-else` chain (Vue template expressions cannot
   *  evaluate to markup, so the TSX brace-wrapped ternary has no
   *  analogue).  Predicate attrs are quote-collision-safe via
   *  `quoteAttrExpr` (escapes rather than throws), like
   *  renderAttrBinding. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    const blocks: string[] = [];
    arms.forEach((arm, i) => {
      const directive = i === 0 ? "v-if" : "v-else-if";
      blocks.push(
        `<template ${directive}=${quoteAttrExpr(arm.predicate)}>\n${inner}${arm.value}\n${pad}</template>`,
      );
    });
    if (elseArm !== undefined) {
      blocks.push(`<template v-else>\n${inner}${elseArm}\n${pad}</template>`);
    }
    return blocks.join(`\n${pad}`);
  },

  // --- List-comprehension seam --------------------------------------------

  /** `<template v-for="(item, idx) in coll" :key="key">body</template>`.
   *  The non-rendering `<template>` carries `v-for` + the required
   *  `:key` without introducing a wrapper element.  The index binding
   *  is emitted only when referenced.  The `v-for` expression is
   *  attribute-quoted via `quoteAttrExpr` (escapes a both-quote
   *  collision rather than throwing — same constraint as
   *  `renderAttrBinding`). */
  renderForEach(
    coll: string,
    itemVar: string,
    indexVar: string,
    keyExpr: string,
    body: string,
    depth: number,
    emptyBody?: string,
  ): string {
    const usesIdx = referencesIdent(keyExpr, indexVar) || referencesIdent(body, indexVar);
    const binding = usesIdx ? `(${itemVar}, ${indexVar})` : itemVar;
    const forExpr = `${binding} in ${coll}`;
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    // `renderAttrBinding` returns the `:key` attr with a leading space.
    const keyAttr = vueTarget.renderAttrBinding("key", keyExpr);
    const forLines = [
      `<template v-for=${quoteAttrExpr(forExpr)}${keyAttr}>`,
      `${inner}${body}`,
      `${pad}</template>`,
    ];
    if (emptyBody === undefined) return forLines.join("\n");
    // Vue forbids `v-for` + `v-if` on one node, so the empty arm is a
    // sibling `<template v-if="!coll.length">` (the comprehension stays
    // a `v-for` template).  Both re-read `coll` — fine for the page DSL's
    // simple `each:` refs.
    return [
      ...forLines,
      `${pad}<template v-if=${quoteAttrExpr(`!${coll}.length`)}>`,
      `${inner}${emptyBody}`,
      `${pad}</template>`,
    ].join("\n");
  },

  // --- Navigation seam ----------------------------------------------------

  /** `router.push(...)` — vue-router 4.  The page shell hoists
   *  `const router = useRouter();` whenever navigation is used.
   *  Route state rides the history API (`state:` member of the
   *  push location), the vue-router analogue of React Router's
   *  `navigate(path, { state })`. */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string {
    if (stateExpr !== undefined) {
      return `router.push({ path: ${JSON.stringify(routeTemplate)}, state: ${stateExpr} })`;
    }
    if (args.length === 0) {
      return `router.push(${JSON.stringify(routeTemplate)})`;
    }
    const state = args.map((a) => `${a.name}: ${a.value}`).join(", ");
    return `router.push({ path: ${JSON.stringify(routeTemplate)}, state: { ${state} } })`;
  },

  /** The magic route `id` reads the local `id` the shell binds from
   *  `route.params.id` (gated on `usesRouteId`). */
  renderRouteId(): string {
    return "id";
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Vue templates use plain markup comments. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
  },

  /** A component body's `Slot { }` → Vue's default `<slot>` (template content
   *  the parent passes as children), not the JSX `{children}` idiom. Vue slots
   *  are not props, so no `children` prop is emitted. */
  renderChildrenSlot(): string {
    return "<slot />";
  },

  /** Vue mustache interpolation in text/child position. */
  renderInterpolation(jsExpr: string): string {
    return `{{ ${jsExpr} }}`;
  },

  /** Vue dynamic attribute — `:name="expr"`, leading space included.
   *  The expression is quoted, so pick the quote character the
   *  rendered JS doesn't use: JS string literals render double-quoted
   *  (JSON.stringify), so a `"`-bearing expression binds single-
   *  quoted.  An expression carrying BOTH quote kinds is entity-
   *  escaped (`"`→`&quot;`) under a double-quote delimiter — Vue
   *  decodes the entity before compiling the binding, so the template
   *  stays well-formed and every valid `.ddd` expression renders. */
  renderAttrBinding(name: string, jsExpr: string): string {
    return ` :${name}=${quoteAttrExpr(jsExpr)}`;
  },

  /** `<template v-if>` / `<template v-else>` block pair.  Vue
   *  template expressions cannot evaluate to markup (no JSX-style
   *  markup-valued ternary), so conditional children render as
   *  structural directives — the same divergence Svelte has with
   *  `{#if}` blocks.  The `v-if` is SINGLE-quoted (like `renderStyleAttr`
   *  below) because the rendered condition can carry double-quoted JS
   *  string literals (`currentUser.role === "manager"`); a double-quoted
   *  attribute would terminate at the first inner `"`.  A condition that
   *  ALSO carries an apostrophe is entity-escaped (`'`→`&#39;`) via
   *  `quoteAttrExpr` rather than silently emitting a broken `v-if`. */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    // `"null"` is the walker's render-nothing sentinel (e.g. an auth-gated
    // action button's else arm).  Vue renders a bare `null` token as literal
    // TEXT, so drop the `v-else` entirely — matching the Angular target's guard.
    if (elseS === "null") {
      return [
        `<template v-if=${quoteAttrExpr(cond, "'")}>`,
        `${inner}${thenS}`,
        `${pad}</template>`,
      ].join("\n");
    }
    return [
      `<template v-if=${quoteAttrExpr(cond, "'")}>`,
      `${inner}${thenS}`,
      `${pad}</template>`,
      `${pad}<template v-else>`,
      `${inner}${elseS}`,
      `${pad}</template>`,
    ].join("\n");
  },

  /** Style attribute.  All-literal entries collapse to a flat CSS
   *  string (kebab keys, plain `style="…"`); any dynamic entry
   *  forces the `:style` object binding.  The binding is single-
   *  quoted because rendered value expressions use double-quoted JS
   *  string literals. */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string {
    if (entries.length === 0) return "";
    if (entries.every((e) => e.literal !== undefined)) {
      const css = entries.map(({ key, literal }) => `${key}: ${literal}`).join("; ");
      return ` style="${css}"`;
    }
    const parts = entries.map(({ key, rendered }) => {
      const camelKey = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return `${camelKey}: ${rendered}`;
    });
    return ` :style='{ ${parts.join(", ")} }'`;
  },

  /** Vue template text escaping.  Entity-escape `&` (first) plus the
   *  tag delimiters; `{`/`}` entity-escape too so literal `{{` can
   *  never form a mustache interpolation. */
  escapeText(text: string): string {
    return escapeJsFamilyText(text);
  },

  // --- Store seam (Stage 5) -----------------------------------------------

  /** A `<Store>.<field>` read.  The shared walker records the use
   *  (`ctx.usedStores`) and emits the BARE member name (`lines`) — like
   *  a state ref under Vue's template auto-unwrap — so this method's
   *  return value is unused by the body; its presence gates the
   *  "store not implemented" throw and keeps the contract shape with
   *  the other JS-family targets.  The page shell binds the bare local
   *  (`const lines = computed(() => cart.state.lines)`) — see
   *  `renderStoreWiring` in `page-shell.ts`. */
  renderStoreFieldRead(ref: { storeName: string; field: string }): string {
    return ref.field;
  },

  /** A `<Store>.<action>(args)` call.  As with field reads, the shared
   *  walker emits the bound-local call (`clear(args)`) directly; the
   *  page shell binds `const clear = cart.clear`.  Returned for contract
   *  shape symmetry. */
  renderStoreActionCall(
    ref: { storeName: string; action: string; local: string },
    renderedArgs: string,
  ): string {
    return `${ref.local}(${renderedArgs})`;
  },

  // --- Async-effect seam (async-actions-and-effects.md Stage 2) ------------

  /** Render a `variant-match` (`match await <op>() { Variant b => … }`) in a
   *  Vue action-handler body.  The skeleton is the SAME JS/TS async envelope
   *  React emits — the arm bodies arrive already rendered as Vue-correct
   *  statements (the page shell's `repointToScript` re-points state writes to
   *  `.value` on the whole returned block afterwards), and the awaited mutation
   *  composable is `@tanstack/vue-query`'s `useMutation` handle (hoisted in
   *  `<script setup>` exactly like every other Vue mutation), so `mutateAsync`
   *  reads identically.  walker-core resolved every piece — this only assembles
   *  the switch skeleton.  `ApiError` + the union response type are imported by
   *  the page shell (the shared walker-core registered both). */
  renderVariantMatch(spec: VariantMatchSpec): string {
    const mutate = spec.mutationVar
      ? `${spec.mutationVar}.mutateAsync(${spec.mutateArgs})`
      : // Degenerate: no detected remote op (walker-core still delegates so the
        // statement is never dropped) — leave a typed placeholder await.
        `Promise.reject(new Error("no remote op for variant-match"))`;
    return renderJsVariantMatch(spec, mutate);
  },

  /** `DestroyForm(of: <Agg>)` — forked so the `window.confirm(...)` handler is
   *  hoisted into `<script setup>` instead of an (impossible) `@click` template
   *  expression. See `./destroy-form.ts`. */
  renderDestroyForm(call, ctx, depth): string | null {
    return renderVueDestroyForm(call, ctx, depth);
  },
};
