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
//   renderStateInit   — walker/page-shell.ts:625-725 (renderUseState + zeroValueForType)
//   renderApiCall     — body-walker.ts:594-597 + walker/api-hooks.ts:60-103
//   renderApiHoisting — walker/page-shell.ts:220-226 (apiHookDecls)
//   renderMatch       — body-walker.ts:635-645 (ternary chain — match
//                       lowers to ternary in `src/ir/lower/lower-expr.ts`)
//   renderNavigate    — walker/primitives/controls.ts:199-213 (emitActionThen)
//   defaultInitFor    — walker/page-shell.ts:705-725 (zeroValueForType)
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR, TypeIR } from "../../../ir/types/loom-ir.js";
import type { DetectedApiCall } from "../../_walker/api-hook-detector.js";
import {
  defaultInitForJs,
  escapeJsFamilyText,
  hookFnName,
  hookVarName,
  lowerFirstName,
  renderJsMatch,
  renderJsNavigate,
  upperFirstName,
} from "../../_walker/js-target-helpers.js";
import type {
  ApiCallSite,
  RenderPosition,
  StateRef,
  TargetHookUse,
  WalkerTarget,
} from "../../_walker/target.js";

/** TSX-flavoured `WalkerTarget`.  Stateless and pure — no walker
 *  context is captured; every method takes the data it needs.  Consumed
 *  by the cross-target conformance test
 *  (`walker-target-contract.test.ts`) that exercises the contract
 *  shared with `heexTarget`. */
export const tsxTarget: WalkerTarget = {
  framework: "react",

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

  /** State-field initializer rendered as a JS expression.  When the
   *  declaration carries an explicit `= <init>`, the caller has
   *  pre-rendered it and passes the source string here would lose
   *  context — but the WalkerTarget contract receives the raw
   *  `ExprIR`, which we DON'T re-walk here because there's no
   *  WalkContext.  Today the delegation site (page-shell) already
   *  pre-renders via `renderInitExpr` — once it delegates to us,
   *  we'll need either a rendering callback in `ApiCallSite`-shape
   *  or a thin `WalkerContext` parameter.  v0 returns the type
   *  default when no init is present; explicit-init handling is
   *  the same shape the future-walker will pass through. */
  renderStateInit(field: StateFieldIR, init: ExprIR | undefined): string {
    if (init !== undefined) {
      // Caller is expected to pre-render via its own walker context
      // (page-shell.ts:643 renderInitExpr).  Once delegation lands,
      // this branch becomes `return walk(init)` — for the
      // standalone target we fall back to the type default so
      // misuse surfaces as "always-default" output, not a crash.
      return defaultInitForJs(field.type);
    }
    return defaultInitForJs(field.type);
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
};
