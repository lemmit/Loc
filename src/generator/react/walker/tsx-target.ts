// ---------------------------------------------------------------------------
// TSX `WalkerTarget` — React-flavoured implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope.
//
// This module is the *standalone* impl: it lifts the seams the
// inline React walker (`src/generator/react/body-walker.ts`) already
// implements into the `WalkerTarget` interface so callers — and the
// cross-target conformance test — can consume them directly.  The
// walker itself still inlines these seams; the extraction is gated
// on the byte-identical fixture suite.
//
// Mapping (file:line at time of extraction):
//   renderStateRead   — body-walker.ts:625-633 (ref-case path)
//   renderStateWrite  — body-walker.ts:980-1011 (assign / add / remove)
//   renderApiCall     — body-walker.ts:594-597 + walker/api-hooks.ts:60-103
//   renderApiHoisting — walker/page-shell.ts:220-226 (apiHookDecls)
//   renderMatch       — body-walker.ts:635-645 (ternary chain — match
//                       lowers to ternary in `src/ir/lower/lower-expr.ts`)
//   renderNavigate    — walker/primitives/controls.ts:199-213 (emitActionThen)
//   defaultInitFor    — walker/page-shell.ts:705-725 (zeroValueForType)
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../../ir/types/loom-ir.js";
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
  renderJsNavigate,
  renderJsVariantMatch,
  storeHookName,
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

/** TSX-flavoured `WalkerTarget`.  Stateless and pure — no walker
 *  context is captured; every method takes the data it needs.  Consumed
 *  by the cross-target conformance test
 *  (`walker-target-contract.test.ts`) that exercises the contract
 *  shared with `heexTarget`. */
export const tsxTarget: WalkerTarget = {
  framework: "react",

  // --- Expression-syntax leaves (JS) — shared by all JSX-family frontends --
  ...jsExprLeaves,

  // --- State seam ---------------------------------------------------------

  /** TSX `useState` reads identically at any render position: the
   *  destructured local (`step`) is in scope inside JSX braces and
   *  inside event handlers.  Position is ignored. */
  renderStateRead(ref: StateRef, _position: RenderPosition): string {
    return ref.name;
  },

  /** `setStep(value)` — the `set<Pascal>` convention React's
   *  `useState` destructure produces (see `renderUseState`
   *  at `walker/page-shell.ts:631`). */
  renderStateWrite(ref: StateRef, value: string): string {
    const name = ref.name;
    const setter = `set${name[0]!.toUpperCase()}${name.slice(1)}`;
    return `${setter}(${value})`;
  },

  /** Immutable nested update: build the spread inside-out, then call the
   *  root's setter — `setOrder({ ...order, shipping: { ...order.shipping,
   *  zip: v } })`.  React state can't be mutated in place or it won't
   *  re-render. */
  renderNestedStateWrite(segments: readonly string[], valueJs: string): string {
    let value = valueJs;
    for (let i = segments.length - 1; i >= 1; i--) {
      value = `{ ...${segments.slice(0, i).join(".")}, ${segments[i]!}: ${value} }`;
    }
    const root = segments[0]!;
    const setter = `set${root[0]!.toUpperCase()}${root.slice(1)}`;
    return `${setter}(${value})`;
  },

  // --- Interactive-table seam (M-T1.1) ------------------------------------

  /** A clickable header that drives client-side sort: clicking an
   *  inactive column selects it ascending; clicking the active column
   *  toggles the direction.  A ↑/↓ glyph marks the active column. */
  renderSortableHeader(spec) {
    const { header, field, sortKey, sortDir } = spec;
    const k = sortKey.name;
    const d = sortDir.name;
    const setK = `set${k[0]!.toUpperCase()}${k.slice(1)}`;
    const setD = `set${d[0]!.toUpperCase()}${d.slice(1)}`;
    const q = JSON.stringify(field);
    const onClick =
      `() => { if (${k} === ${q}) { ${setD}(${d} === "asc" ? "desc" : "asc"); } ` +
      `else { ${setK}(${q}); ${setD}("asc"); } }`;
    const indicator = `{${k} === ${q} ? (${d} === "asc" ? " ↑" : " ↓") : ""}`;
    // A real `<button>` (not a `<span onClick>`) so the sort control is
    // keyboard-focusable and carries an implicit ARIA role — the a11y gates
    // (svelte-check `--fail-on-warnings`, axe) reject a clickable span.  The
    // style resets the native button chrome so it still reads as a header.
    const style = `{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }`;
    return `<button type="button" style={${style}} onClick={${onClick}}>${header}${indicator}</button>`;
  },

  /** Sort the rows array by the active `sortKey` column in `sortDir`
   *  order.  Copies first (`[...]`) so the source array isn't mutated;
   *  the `as number` casts satisfy the type-checker while relational
   *  `<` compares strings and numbers correctly at runtime. */
  renderSortedRows(rowsExpr, sortKey, sortDir) {
    const k = sortKey.name;
    const d = sortDir.name;
    return (
      `[...(${rowsExpr})].sort((a, b) => { if (!${k}) { return 0; } ` +
      `const av = (a as Record<string, unknown>)[${k}]; ` +
      `const bv = (b as Record<string, unknown>)[${k}]; ` +
      `const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; ` +
      `return ${d} === "desc" ? -c : c; })`
    );
  },

  /** Prev / "Page N of M" / Next pager, wired to the `page` state field.
   *  Prev disables on page 1; Next disables once the window reaches the
   *  total.  Inline-styled so it stays pack-agnostic (like the sort header). */
  renderPager(spec) {
    const p = spec.page.name;
    const setP = `set${p[0]!.toUpperCase()}${p.slice(1)}`;
    const pages = spec.totalPagesExpr;
    const style = `{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" }`;
    return (
      `<div style={${style}} data-testid="pager">` +
      `<button type="button" disabled={${p} <= 1} onClick={() => ${setP}(${p} - 1)}>Prev</button>` +
      `<span>Page {${p}} of {${pages}}</span>` +
      `<button type="button" disabled={${p} >= ${pages}} onClick={() => ${setP}(${p} + 1)}>Next</button>` +
      `</div>`
    );
  },

  /** A controlled search box driving the client-side filter.  `value`/`onChange`
   *  is React's two-way idiom; inline-styled so it stays pack-agnostic. */
  renderFilterInput(filter) {
    const n = filter.name;
    const setN = `set${n[0]!.toUpperCase()}${n.slice(1)}`;
    const style = `{ marginBottom: "0.75rem", padding: "0.375rem 0.5rem" }`;
    return (
      `<input type="search" placeholder="Filter…" aria-label="Filter table" ` +
      `value={${n}} onChange={(e) => ${setN}(e.target.value)} ` +
      `style={${style}} data-testid="table-filter" />`
    );
  },

  /** Inline case-insensitive substring filter across every row value.  `Object
   *  .values` hits the `{}` overload (→ `any[]`), so no per-value cast; the row
   *  cast satisfies strict indexing.  An empty query passes all rows. */
  renderFilteredRows(rowsExpr, filter) {
    const q = filter.name;
    return (
      `((${rowsExpr}) ?? []).filter((r) => { const __q = (${q}).trim().toLowerCase(); ` +
      `return __q === "" || Object.values(r as Record<string, unknown>)` +
      `.some((v) => v != null && String(v).toLowerCase().includes(__q)); })`
    );
  },

  // --- API binding seam ---------------------------------------------------

  /** Turn a detected api call into React-Query naming + import.
   *  `Customer.create` → `{ varName: "customerCreate", hookName:
   *  "useCreateCustomer", importFrom: "../api/customer", argsRendered: [] }`.
   *  View hooks (`Views.activeOrders`) take a different naming
   *  shape (`activeOrdersView` / `useActiveOrdersView` /
   *  `"../api/views"`).  Mirrors the formula at
   *  `walker/api-hooks.ts:60-103` pre-extraction. */
  buildHookUse(detected: DetectedApiCall, renderArg: (e: ExprIR) => string): TargetHookUse {
    if (detected.kind === "view") {
      const viewName = detected.aggregateName;
      const viewPascal = upperFirstName(viewName);
      return {
        varName: `${lowerFirstName(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "../api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      // `Fulfillment.instances.all` → useAllFulfillmentInstances();
      // `Fulfillment.instances.byId(id)` → useFulfillmentInstanceById(id).
      // Both live in the shared `../api/workflows` module.
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

  /** TSX rewrites the IR call site to the local hook variable
   *  produced by `renderApiHoisting`.  See the contract docs at
   *  `src/generator/_walker/target.ts` for the full rationale —
   *  the short version: React Query hoists `useXxx()` ONCE per
   *  component, every call site references the resulting var, and
   *  any chained access (`.data`, `.mutate(args)`, `.isPending`)
   *  comes from the surrounding IR walk via the standard
   *  member / method-call codepath.  The contract returns ONLY
   *  the var name — the IR-node-level emission.
   *
   *  `renderedArgs` is unused (TSX never invokes the hook at the
   *  call site).  Kept in the signature for cross-target shape
   *  symmetry with HEEx. */
  renderApiCall(call: ApiCallSite, _renderedArgs: string): string {
    return call.varName ?? hookVarName(call.aggregateName, call.operation);
  },

  /** Hoist one `const <var> = useXxx(args);` line per unique hook
   *  usage.  When `varName`/`hookName`/`argsRendered` are supplied
   *  on the ApiCallSite (the delegating walker passes ApiHookUse
   *  fields through), the target uses them verbatim — this
   *  preserves the View-hook shape (`useXxxView`) that the
   *  aggregate+op formula can't capture.  When absent (standalone
   *  test usage), the target falls back to recomputing from
   *  aggregate+op with empty args.
   *
   *  Iteration order preserves the caller's input order so the
   *  hoisted block reflects whatever ordering the walker tracks —
   *  pages today register hooks in the order they're discovered
   *  during the body walk (Map insertion order). */
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

  /** Chain ternaries — `(p1) ? v1 : (p2) ? v2 : fallback`.  Match
   *  lowers via `src/ir/lower/lower-expr.ts` to a `match` IR node; the
   *  React walker emits the chained form (no native switch
   *  expression in JS).  When `elseArm` is undefined we emit
   *  `null` as the terminal — JSX renders nothing. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    return renderJsMatch(arms, elseArm);
  },

  /** Child-position match — the flat ternary chain, brace-wrapped
   *  below depth 0 (JSX-child syntax).  Byte-identical to the inline
   *  form the walker carried before the seam. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const inner = tsxTarget.renderMatch(arms, elseArm);
    return depth === 0 ? inner : `{${inner}}`;
  },

  // --- List-comprehension seam --------------------------------------------

  /** `coll.map((item, idx) => (<Fragment key={key}>body</Fragment>))`.
   *  The keyed Fragment satisfies `useJsxKeyInIterable` without
   *  introducing a wrapper DOM node; the index binding is emitted only
   *  when referenced (else `noUnusedFunctionParameters` fires).  Brace-
   *  wrapped below depth 0, mirroring the ternary/match-child arms.
   *
   *  With an `empty:` arm the `.map` becomes the false branch of a
   *  `coll.length === 0 ? (empty) : (.map(…))` ternary (the same
   *  brace-wrap rule applies). */
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
    const params = usesIdx ? `(${itemVar}, ${indexVar})` : `(${itemVar})`;
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    const mapExpr = [
      `${coll}.map(${params} => (`,
      `${inner}<Fragment key={${keyExpr}}>`,
      `${inner}  ${body}`,
      `${inner}</Fragment>`,
      `${close}))`,
    ].join("\n");
    const expr =
      emptyBody === undefined
        ? mapExpr
        : [
            `${coll}.length === 0 ? (`,
            `${inner}${emptyBody}`,
            `${close}) : (`,
            `${inner}${mapExpr}`,
            `${close})`,
          ].join("\n");
    return depth === 0 ? expr : `{${expr}}`;
  },

  // --- Navigation seam ----------------------------------------------------

  /** `navigate("/route", { state: { ...args } })` — React Router v6
   *  shape.  When `args` is empty, the second arg is omitted.
   *  `routeTemplate` is the target page's route path with `:param`
   *  placeholders left in place; the walker is responsible for
   *  interpolating param values into the route string before
   *  passing it in (React Router consumes literal paths). */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string {
    return renderJsNavigate(routeTemplate, args, stateExpr);
  },

  /** The magic route `id` reads the local `id` the shell destructures from
   *  `useParams<{ id: string }>()` (gated on `usesRouteId`). */
  renderRouteId(): string {
    return "id";
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** JSX expression-comment in child position. */
  renderComment(text: string): string {
    return `{/* ${text} */}`;
  },

  /** JSX child-position interpolation — the brace wrap. */
  renderInterpolation(jsExpr: string): string {
    return `{${jsExpr}}`;
  },

  /** JSX dynamic attribute — `name={expr}`, leading space included. */
  renderAttrBinding(name: string, jsExpr: string): string {
    return ` ${name}={${jsExpr}}`;
  },

  /** Parenthesised ternary.  Depth 0 sits directly inside the
   *  component's `return ( … )` parens; nested child positions need
   *  the JSX brace wrap.  Verbatim lift of the walk()-ternary case. */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const inner = `${cond} ? (\n${"  ".repeat(depth + 1)}${thenS}\n${"  ".repeat(depth)}) : (\n${"  ".repeat(depth + 1)}${elseS}\n${"  ".repeat(depth)})`;
    return depth === 0 ? inner : `{${inner}}`;
  },

  /** JSX object-literal style attribute with camelCased CSS keys.
   *  Verbatim lift of the old body-walker styleAttr body. */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string {
    if (entries.length === 0) return "";
    const parts = entries.map(({ key, rendered }) => {
      const camelKey = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return `${JSON.stringify(camelKey)}: ${rendered}`;
    });
    return ` style={{ ${parts.join(", ")} }}`;
  },

  /** JSX text escaping — entity-escape the expression / tag
   *  delimiters (and `&` first so entity refs don't double-escape).
   *  Behaviour-identical to `walker/shared/args.ts:escapeJsxText`
   *  (kept local so this module stays self-contained). */
  escapeText(text: string): string {
    return escapeJsFamilyText(text);
  },

  // --- Store seam (Stage 5) -----------------------------------------------

  /** A `<Store>.<field>` read → the Zustand selector the page shell binds:
   *  `useCart((s) => s.lines)`.  The shell binds it to a local named after
   *  the field; the body references that bare local. */
  renderStoreFieldRead(ref: { storeName: string; field: string }): string {
    return `${storeHookName(ref.storeName)}((s) => s.${ref.field})`;
  },

  /** A `<Store>.<action>(args)` call.  The shell binds the action via
   *  `useCart((s) => s.clear)` to a local named after the action; the call
   *  site invokes that bare local. */
  renderStoreActionCall(
    ref: { storeName: string; action: string; local: string },
    renderedArgs: string,
  ): string {
    return `${ref.local}(${renderedArgs})`;
  },

  /** Render a `variant-match` (async-actions-and-effects.md Stage 2) as
   *  React's async envelope: `await` the hoisted mutation (`mutateAsync`),
   *  reify a caught `ApiError` into the union's error variant (its `type`
   *  overwritten server-side by the ProblemDetails URI, re-stamped here to the
   *  statically-known error tag), then a discriminant `switch (result.type)`
   *  binding each arm's narrowed local.  walker-core resolved every piece —
   *  this only assembles the TSX skeleton. */
  renderVariantMatch(spec: VariantMatchSpec): string {
    const mutate = spec.mutationVar
      ? `${spec.mutationVar}.mutateAsync(${spec.mutateArgs})`
      : // Degenerate: no detected remote op (walker-core still delegates so the
        // statement is never dropped) — leave a typed placeholder await.
        `Promise.reject(new Error("no remote op for variant-match"))`;
    return renderJsVariantMatch(spec, mutate);
  },
};
