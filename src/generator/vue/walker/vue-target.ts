// ---------------------------------------------------------------------------
// Vue `WalkerTarget` — Vue-3-flavoured implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope, and
// `docs/plans/vue-frontend-plan.md` for the platform plan.
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

import type { ExprIR, StateFieldIR, TypeIR } from "../../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "../../_walker/api-hook-detector.js";
import {
  defaultInitForJs,
  escapeJsFamilyText,
  hookFnName,
  hookVarName,
  lowerFirstName,
  referencesIdent,
  renderJsMatch,
  upperFirstName,
} from "../../_walker/js-target-helpers.js";
import type {
  ApiCallSite,
  RenderPosition,
  StateRef,
  TargetHookUse,
  WalkerTarget,
} from "../../_walker/target.js";

/** Vue-flavoured `WalkerTarget`.  Stateless and pure — no walker
 *  context is captured; every method takes the data it needs.
 *  Consumed by the cross-target conformance test and (from the
 *  generator-core slice on) the shared markup walker. */
export const vueTarget: WalkerTarget = {
  framework: "vue",

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

  // --- API binding seam ---------------------------------------------------

  /** Turn a detected api call into vue-query composable naming +
   *  import.  Deliberately the SAME naming formula as React
   *  (`useCreateCustomer` / `../api/customer`): the `use*` prefix is
   *  Vue's composable convention too, and keeping the generated api
   *  module surface name-identical across the two SPA frontends
   *  keeps the api-builder shareable. */
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
   *  analogue).  Predicate attrs quote-collision-safe like
   *  renderAttrBinding. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    const quoteCond = (cond: string): string => {
      if (!cond.includes('"')) return `"${cond}"`;
      if (!cond.includes("'")) return `'${cond}'`;
      throw new Error(
        `vueTarget.renderMatchChild: match predicate mixes single and double quotes — cannot be attribute-quoted: ${cond}`,
      );
    };
    const blocks: string[] = [];
    arms.forEach((arm, i) => {
      const directive = i === 0 ? "v-if" : "v-else-if";
      blocks.push(
        `<template ${directive}=${quoteCond(arm.predicate)}>\n${inner}${arm.value}\n${pad}</template>`,
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
   *  attribute-quoted, so the collection expression must not collide
   *  with the chosen quote (same constraint as `renderAttrBinding`). */
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
    const quoteFor = (expr: string): string => {
      if (!expr.includes('"')) return `"${expr}"`;
      if (!expr.includes("'")) return `'${expr}'`;
      throw new Error(
        `vueTarget.renderForEach: v-for expression mixes single and double quotes — cannot be attribute-quoted: ${expr}`,
      );
    };
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    // `renderAttrBinding` returns the `:key` attr with a leading space.
    const keyAttr = vueTarget.renderAttrBinding("key", keyExpr);
    const forLines = [
      `<template v-for=${quoteFor(forExpr)}${keyAttr}>`,
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
      `${pad}<template v-if=${quoteFor(`!${coll}.length`)}>`,
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

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Vue templates use plain markup comments. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
  },

  /** Vue mustache interpolation in text/child position. */
  renderInterpolation(jsExpr: string): string {
    return `{{ ${jsExpr} }}`;
  },

  /** Vue dynamic attribute — `:name="expr"`, leading space included.
   *  The expression is quoted, so pick the quote character the
   *  rendered JS doesn't use: JS string literals render double-quoted
   *  (JSON.stringify), so a `"`-bearing expression binds single-
   *  quoted.  An expression carrying BOTH quote kinds can't be
   *  attribute-quoted at all — fail loud rather than emit a template
   *  that won't compile (handler hoisting is the structural fix,
   *  tracked for the forms/handlers slice). */
  renderAttrBinding(name: string, jsExpr: string): string {
    if (!jsExpr.includes('"')) return ` :${name}="${jsExpr}"`;
    if (!jsExpr.includes("'")) return ` :${name}='${jsExpr}'`;
    throw new Error(
      `vueTarget.renderAttrBinding: expression for ':${name}' mixes single and double quotes — cannot be attribute-quoted. Simplify the expression (e.g. avoid apostrophes inside string literals used in bindings).`,
    );
  },

  /** `<template v-if>` / `<template v-else>` block pair.  Vue
   *  template expressions cannot evaluate to markup (no JSX-style
   *  markup-valued ternary), so conditional children render as
   *  structural directives — the same divergence Svelte has with
   *  `{#if}` blocks. */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    return [
      `<template v-if="${cond}">`,
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
};
