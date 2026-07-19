// ---------------------------------------------------------------------------
// Svelte `WalkerTarget` — Svelte 5 (runes) implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope.
//
// Svelte 5 sits remarkably close to TSX for the shared markup walker:
// `{expr}` interpolation, `<Comp x={y}/>` invocation and
// `data-testid={expr}` are byte-compatible, and the runes state model
// reads like plain JS.  The deltas this target owns:
//
//   - state writes are plain assignments (`count = v`, no setter)
//   - api factories come from `$lib/api/*` (same use* names as the
//     react packs — @tanstack/svelte-query v6 returns reactive
//     objects with the same .data/.isPending/.mutate surface)
//   - navigation is SvelteKit's `goto()`
//   - conditional CHILDREN render as `{#if}` blocks (Svelte template
//     expressions cannot evaluate to markup)
//   - comments are HTML comments; the style attr is a CSS string
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
  renderJsNavigate,
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

export const svelteTarget: WalkerTarget = {
  framework: "svelte",
  // Expression-syntax leaves (JS) — shared by all JSX-family frontends.
  ...jsExprLeaves,

  // --- State seam ---------------------------------------------------------

  /** Runes state reads are bare identifiers in template and handler
   *  position alike — `let step = $state(0)` then `step`. */
  renderStateRead(ref: StateRef, _position: RenderPosition): string {
    return ref.name;
  },

  /** Plain reassignment — `$state` makes the assignment reactive;
   *  no setter convention exists. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `${ref.name} = ${value}`;
  },

  /** In-place nested mutation — `order.shipping.zip = v`.  Svelte 5
   *  `$state` is deeply reactive, so a member assignment triggers an
   *  update; no immutable spread (unlike React). */
  renderNestedStateWrite(segments: readonly string[], valueJs: string): string {
    return `${segments.join(".")} = ${valueJs}`;
  },

  // --- Interactive-table seam (M-T1.1) ------------------------------------

  /** An `onclick` header driving client-side sort.  Svelte 5 `$state`
   *  runes are reassigned in place (`sortKey = "name"`) and stay reactive;
   *  text interpolation is `{ … }`. */
  renderSortableHeader(spec) {
    const { header, field, sortKey, sortDir } = spec;
    const k = sortKey.name;
    const d = sortDir.name;
    const q = JSON.stringify(field);
    const onClick =
      `() => { if (${k} === ${q}) { ${d} = ${d} === "asc" ? "desc" : "asc"; } ` +
      `else { ${k} = ${q}; ${d} = "asc"; } }`;
    const indicator = `{${k} === ${q} ? (${d} === "asc" ? " ↑" : " ↓") : ""}`;
    // A real `<button>` (not a clickable `<span>`) so the header is keyboard-
    // focusable + has an implicit ARIA role — `svelte-check --fail-on-warnings`
    // (the generated-svelte-build gate) flags a span with `onclick`.  The style
    // resets the native button chrome so it still reads as a header.
    const style =
      "background: none; border: none; padding: 0; font: inherit; cursor: pointer; user-select: none;";
    return `<button type="button" style="${style}" onclick={${onClick}}>${header}${indicator}</button>`;
  },

  /** Sort the rows via the shared `sortRows` helper (`$lib/table-sort`) —
   *  Svelte's strict `svelte-check` can't index a typed row by a dynamic
   *  string key inline, so the cast lives in the helper module. */
  renderSortedRows(rowsExpr, sortKey, sortDir) {
    return `sortRows(${rowsExpr}, ${sortKey.name}, ${sortDir.name})`;
  },

  /** Prev / "Page N of M" / Next pager.  `$state` reassigns in place inside the
   *  `onclick` arrows; `disabled={…}` and `{ … }` interpolation carry the plain
   *  JS expressions (`Math` is just a JS global here). */
  renderPager(spec) {
    const p = spec.page.name;
    const pages = spec.totalPagesExpr;
    const style =
      "display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem;";
    return (
      `<div style="${style}" data-testid="pager">` +
      `<button type="button" disabled={${p} <= 1} onclick={() => { ${p} = ${p} - 1; }}>Prev</button>` +
      `<span>Page {${p}} of {${pages}}</span>` +
      `<button type="button" disabled={${p} >= ${pages}} onclick={() => { ${p} = ${p} + 1; }}>Next</button>` +
      `</div>`
    );
  },

  /** A `bind:value` search box driving the client-side filter — Svelte 5
   *  two-way binds the `$state` rune, so no manual event handler is needed. */
  renderFilterInput(filter) {
    const style = "margin-bottom: 0.75rem; padding: 0.375rem 0.5rem;";
    return (
      `<input type="search" bind:value={${filter.name}} placeholder="Filter…" ` +
      `aria-label="Filter table" style="${style}" data-testid="table-filter" />`
    );
  },

  /** Filter via the shared `filterRows` helper (`$lib/table-sort`) — Svelte's
   *  strict `svelte-check` can't carry the inline `Object.values` cast, so it
   *  lives in the helper module. */
  renderFilteredRows(rowsExpr, filter) {
    return `filterRows(${rowsExpr}, ${filter.name})`;
  },

  // --- API binding seam ---------------------------------------------------

  /** Identical naming to the TSX target — the svelte api modules
   *  export the same `useAll<Plural>` / `useCreate<Single>` /
   *  `use<X>View` factories (svelte-query v6's createQuery returns a
   *  reactive object with the React-Query property surface), so the
   *  page-level wiring is name-compatible.  Only the import root
   *  differs: SvelteKit's `$lib/api/*` alias instead of relative
   *  `../api/*`. */
  buildHookUse(detected: DetectedApiCall, renderArg: (e: ExprIR) => string): TargetHookUse {
    if (detected.kind === "view") {
      const viewName = detected.aggregateName;
      const viewPascal = upperFirstName(viewName);
      return {
        varName: `${lowerFirstName(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "$lib/api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      const wf = upperFirstName(detected.aggregateName);
      const isAll = detected.operation === "all";
      return {
        varName: isAll ? `all${wf}Instances` : `${lowerFirstName(detected.aggregateName)}Instance`,
        hookName: isAll ? `useAll${wf}Instances` : `use${wf}InstanceById`,
        importFrom: "$lib/api/workflows",
        argsRendered: detected.args.map(renderArg),
      };
    }
    const aggregate = detected.aggregateName;
    const op = detected.operation;
    return {
      varName: hookVarName(aggregate, op),
      hookName: hookFnName(aggregate, op),
      importFrom: `$lib/api/${lowerFirstName(upperFirstName(aggregate))}`,
      argsRendered: detected.args.map(renderArg),
    };
  },

  /** Like TSX: call sites reference the hoisted local; chained
   *  access (`.data`, `.mutate(args)`) comes from the surrounding IR
   *  walk. */
  renderApiCall(call: ApiCallSite, _renderedArgs: string): string {
    return call.varName ?? hookVarName(call.aggregateName, call.operation);
  },

  /** Hoist `const <var> = use<X>(args);` lines — svelte-query
   *  factories are invoked once in component-init position exactly
   *  like React hooks.  Parameterised reads wrap each rendered arg
   *  in an accessor (`() => arg`) because svelte-query v6 takes
   *  thunks for reactive arguments (route params change without a
   *  component re-mount). */
  renderApiHoisting(uses: ApiCallSite[]): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of uses) {
      const varName = u.varName ?? hookVarName(u.aggregateName, u.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      const hookName = u.hookName ?? hookFnName(u.aggregateName, u.operation);
      // Parenthesise the thunk body so an object-literal query arg (a paged
      // find's `{ page, pageSize, sort, dir }`) isn't parsed as a block.
      const args = (u.argsRendered ?? []).map((a) => `() => (${a})`);
      lines.push(`const ${varName} = ${hookName}(${args.join(", ")});`);
    }
    return lines;
  },

  // --- Match expression seam ----------------------------------------------

  /** Chained ternaries — valid in Svelte EXPRESSION position (match
   *  arms are values; markup-bearing conditionals route through
   *  `renderConditionalChild` instead).  Same emission as TSX. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    return renderJsMatch(arms, elseArm);
  },

  /** Child-position match — a structural `{#if}` / `{:else if}` /
   *  `{:else}` chain (Svelte template expressions cannot evaluate to
   *  markup; same divergence as renderConditionalChild). */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    const parts: string[] = [];
    arms.forEach((arm, i) => {
      parts.push(`{${i === 0 ? "#if" : ":else if"} ${arm.predicate}}\n${inner}${arm.value}`);
    });
    if (elseArm !== undefined) {
      parts.push(`{:else}\n${inner}${elseArm}`);
    }
    return `${parts.join(`\n${close}`)}\n${close}{/if}`;
  },

  // --- List-comprehension seam --------------------------------------------

  /** `{#each coll as item, idx (key)}body{/each}` — Svelte's native
   *  keyed iteration block (no wrapper element, no `.map`).  The index
   *  binding is emitted only when referenced; the `(key)` keyed-each
   *  expression is always present (the default key is the index).
   *
   *  An `empty:` arm slots into Svelte's native `{:else}` clause — no
   *  re-evaluation of `coll`, unlike the TSX/Vue idioms. */
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
    const binding = usesIdx ? `${itemVar}, ${indexVar}` : itemVar;
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    return [
      `{#each ${coll} as ${binding} (${keyExpr})}`,
      `${inner}${body}`,
      ...(emptyBody === undefined ? [] : [`${close}{:else}`, `${inner}${emptyBody}`]),
      `${close}{/each}`,
    ].join("\n");
  },

  // --- Navigation seam ----------------------------------------------------

  /** SvelteKit navigation through the `navigate` local.  The svelte
   *  page shell imports `{ goto as navigate }` from `$app/navigation`
   *  so every walker-emitted `navigate(...)` call — including the
   *  pack templates' default-submit redirect statements, which the
   *  shared form primitives compose with the literal name
   *  `navigate` — resolves without a walker-side seam.  Route state
   *  rides the shallow-routing `state` option (read back via
   *  `page.state`). */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string {
    return renderJsNavigate(routeTemplate, args, stateExpr);
  },

  /** The magic route `id` reads the local `id` the shell derives from
   *  `$derived(page.params.id ?? "")` (gated on `usesRouteId`). */
  renderRouteId(): string {
    return "id";
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Svelte templates have no expression-comment
   *  form; `{/* *​/}` would parse as an interpolation. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
  },

  /** `{#if}` block — Svelte template expressions cannot evaluate to
   *  markup, so a conditional CHILD must be a control-flow block.
   *  Indentation mirrors the TSX ternary's depth shape so nested
   *  output stays readable. */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const inner = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    return `{#if ${cond}}\n${inner}${thenS}\n${close}{:else}\n${inner}${elseS}\n${close}{/if}`;
  },

  /** CSS-string style attribute.  An all-literal style stays a plain quoted
   *  attribute (`style="a: b"`, byte-identical to before).  Once ANY value is
   *  dynamic, bind a JS TEMPLATE LITERAL instead (`style={` + backtick + `…` +
   *  backtick + `}`): a dynamic value is `JSON.stringify`-rendered, so it carries
   *  double quotes (`active ? "green" : "gray"`), and interpolating that inside a
   *  quoted `style="…"` (then entity-escaping the whole string) would turn the
   *  `"` into `&quot;` INSIDE the `{…}` JS expression — Svelte parses that as JS
   *  and dies.  A `${…}` inside a `{`backtick`}` binding has no delimiter to
   *  collide with. */
  renderStyleAttr(
    entries: ReadonlyArray<{ key: string; rendered: string; literal?: string }>,
  ): string {
    if (entries.length === 0) return "";
    const hasDynamic = entries.some((e) => e.literal === undefined);
    if (!hasDynamic) {
      const css = entries.map(({ key, literal }) => `${key}: ${literal}`).join("; ");
      return ` style="${css.replace(/"/g, "&quot;")}"`;
    }
    const css = entries
      .map(({ key, rendered, literal }) => `${key}: ${literal ?? `\${${rendered}}`}`)
      .join("; ");
    return ` style={\`${css}\`}`;
  },

  /** Svelte 5 children snippet — optional-render so components
   *  invoked without children stay valid.  (Snippets aren't
   *  interpolatable, so the JSX `{children}` fallback is wrong here.) */
  renderChildrenSlot(): string {
    return "{@render children?.()}";
  },

  /** None — the runes form runtime (`createForm` from
   *  `$lib/forms.svelte`) rides the svelte packs' form templates. */
  formRuntimeImports(): ReadonlyArray<{ from: string; named: readonly string[] }> {
    return [];
  },

  /** Svelte 5 shares JSX's `{expr}` interpolation syntax. */
  renderInterpolation(jsExpr: string): string {
    return `{${jsExpr}}`;
  },

  /** Svelte dynamic attribute — `name={expr}`, leading space
   *  included (same spelling as JSX). */
  renderAttrBinding(name: string, jsExpr: string): string {
    return ` ${name}={${jsExpr}}`;
  },

  /** Svelte text shares JSX's significant set — `{` opens an
   *  interpolation, `<` opens a tag, `&` opens an entity — so the
   *  entity escape carries over unchanged (`}` / `>` escaping is
   *  harmless and keeps the two outputs aligned). */
  escapeText(text: string): string {
    return escapeJsFamilyText(text);
  },

  // --- Store seam (Stage 5) -----------------------------------------------

  /** A `<Store>.<field>` read.  The Svelte store module is a `$state` rune
   *  singleton (`export const cart = $state<…>({ … })`), so a field read is
   *  `<storeVar>.<field>` (`cart.lines`).  The page shell binds this to a
   *  local named after the field via `const <field> = $derived(<this>)` so
   *  the reactive read survives, and the body references the bare local — this
   *  return value is the canonical read form the shell wraps. */
  renderStoreFieldRead(ref: { storeName: string; field: string }): string {
    return `${lowerFirstName(ref.storeName)}.${ref.field}`;
  },

  /** A `<Store>.<action>(args)` call.  Store actions are bare module-level
   *  arrow exports (`export const clear = () => { … }`), so the call site
   *  imports the action and invokes the bare name — `clear(args)`. */
  renderStoreActionCall(
    ref: { storeName: string; action: string; local: string },
    renderedArgs: string,
  ): string {
    return `${ref.local}(${renderedArgs})`;
  },

  /** Render a `variant-match` (async-actions-and-effects.md Stage 2) as Svelte's
   *  async envelope: `await` the hoisted svelte-query mutation (`mutateAsync`),
   *  reify a caught `ApiError` into the union's error variant (its `type`
   *  overwritten server-side by the ProblemDetails URI, re-stamped here to the
   *  statically-known error tag), then a discriminant `switch (result.type)`
   *  binding each arm's narrowed local.  The skeleton is a plain TS switch —
   *  byte-identical to the TSX target — since it lands inside `<script lang="ts">`
   *  and the arm bodies arrive already rendered as Svelte-correct statements
   *  (`$state` writes, `navigate(…)`).  walker-core resolved every piece +
   *  registered the `ApiError` / union-type imports; this only assembles the
   *  skeleton. */
  renderVariantMatch(spec: VariantMatchSpec): string {
    const mutate = spec.mutationVar
      ? `${spec.mutationVar}.mutateAsync(${spec.mutateArgs})`
      : // Degenerate: no detected remote op (walker-core still delegates so the
        // statement is never dropped) — leave a typed placeholder await.
        `Promise.reject(new Error("no remote op for variant-match"))`;
    return renderJsVariantMatch(spec, mutate);
  },
};
