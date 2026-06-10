// ---------------------------------------------------------------------------
// Vue `WalkerTarget` — Vue-3-flavoured implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope, and
// `docs/plans/vue-frontend-plan.md` for the platform plan.
//
// Generated pages are SFCs with a `<script setup lang="ts">` block:
// state fields are `ref()`s, API handles are vue-query composables
// hoisted in the script block, and block-body lambdas (where
// `state :=` writes and api mutations live) hoist to script-level
// handler functions.  That split drives the two position-dependent
// seams:
//
//   - reads: bare name in TEMPLATE position (Vue auto-unwraps
//     top-level refs in templates), `.value` in HANDLER position
//     (script-level functions see the raw Ref);
//   - writes: always `.value =` — writes only occur inside
//     block-body lambdas, which the page shell hoists to script.
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "../../_walker/api-hook-detector.js";
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

  /** Vue templates auto-unwrap top-level refs (`step` reads the
   *  number), but script-position code sees the raw `Ref` and needs
   *  `.value`.  This is the position-dependence the contract's
   *  `RenderPosition` parameter exists for (HEEx precedent:
   *  `@step` vs `socket.assigns.step`). */
  renderStateRead(ref: StateRef, position: RenderPosition): string {
    return position === "template" ? ref.name : `${ref.name}.value`;
  },

  /** `step.value = <expr>` — `state :=` writes occur inside
   *  block-body lambdas, which the Vue page shell hoists to
   *  script-level handler functions (never inline template
   *  expressions), so the script-position form is always right. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `${ref.name}.value = ${value}`;
  },

  /** State-field initializer rendered as a JS expression.  Same
   *  contract semantics as `tsxTarget.renderStateInit`: the
   *  delegating walker pre-renders explicit `= <init>` expressions
   *  with its own context; the standalone target falls back to the
   *  type default so misuse surfaces as "always-default" output,
   *  not a crash. */
  renderStateInit(field: StateFieldIR, init: ExprIR | undefined): string {
    if (init !== undefined) {
      return defaultInitForVue(field.type);
    }
    return defaultInitForVue(field.type);
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
      const viewPascal = upperFirstLocal(viewName);
      return {
        varName: `${lowerFirstLocal(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "../api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      const wf = upperFirstLocal(detected.aggregateName);
      const isAll = detected.operation === "all";
      return {
        varName: isAll ? `all${wf}Instances` : `${lowerFirstLocal(detected.aggregateName)}Instance`,
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
      importFrom: `../api/${lowerFirstLocal(upperFirstLocal(aggregate))}`,
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
    const terminal = elseArm ?? "null";
    let out = terminal;
    for (let i = arms.length - 1; i >= 0; i--) {
      const a = arms[i]!;
      out = `(${a.predicate}) ? (${a.value}) : ${out}`;
    }
    return out;
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
    return defaultInitForVue(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Vue templates use plain markup comments. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
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
    return text
      .replace(/&/g, "&amp;")
      .replace(/\{/g, "&#123;")
      .replace(/\}/g, "&#125;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },
};

// ---------------------------------------------------------------------------
// Internals — naming formulas shared with the React target by value
// (kept local so the module stays self-contained; the conformance
// test pins the cross-target naming equality deliberately).
// ---------------------------------------------------------------------------

/** Composable variable name: `<aggCamel><OpPascal>`. */
function hookVarName(aggregate: string, op: string): string {
  return `${lowerFirstLocal(aggregate)}${upperFirstLocal(op)}`;
}

/** Composable fn name — `use<Op><Single>` family. */
function hookFnName(aggregate: string, op: string): string {
  const single = upperFirstLocal(aggregate);
  const pluralName = pluralLocal(single);
  if (op === "all") return `useAll${pluralName}`;
  if (op === "byId") return `use${single}ById`;
  if (op === "create") return `useCreate${single}`;
  if (op === "update") return `useUpdate${single}`;
  if (op === "delete") return `useDelete${single}`;
  return `use${upperFirstLocal(op)}${single}`;
}

/** Zero value per type — JS literals, same table as TSX (the Vue
 *  SPA shares the wire shape and the decimal.js money convention). */
function defaultInitForVue(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "money":
        return 'new Decimal("0")';
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "undefined";
  return "undefined";
}

function lowerFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

function upperFirstLocal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function pluralLocal(s: string): string {
  // Conservative rules matching `src/util/naming.ts:plural`.
  if (s.endsWith("y") && !/[aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}
