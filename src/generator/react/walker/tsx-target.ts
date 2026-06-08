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
      return defaultInitForTsx(field.type);
    }
    return defaultInitForTsx(field.type);
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
      const viewPascal = upperFirstLocal(viewName);
      return {
        varName: `${lowerFirstLocal(viewName)}View`,
        hookName: `use${viewPascal}View`,
        importFrom: "../api/views",
        argsRendered: [],
      };
    }
    if (detected.kind === "workflow-instance") {
      // `Fulfillment.instances.all` → useAllFulfillmentInstances();
      // `Fulfillment.instances.byId(id)` → useFulfillmentInstanceById(id).
      // Both live in the shared `../api/workflows` module.
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
    const terminal = elseArm ?? "null";
    let out = terminal;
    for (let i = arms.length - 1; i >= 0; i--) {
      const a = arms[i]!;
      out = `(${a.predicate}) ? (${a.value}) : ${out}`;
    }
    return out;
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
    // Escape hatch: a non-object-literal second arg (the source's
    // `navigate(Page, someExpr)` shape) flows through pre-rendered.
    // Takes precedence over `args` — caller picks one path.
    if (stateExpr !== undefined) {
      return `navigate(${JSON.stringify(routeTemplate)}, { state: ${stateExpr} })`;
    }
    if (args.length === 0) {
      return `navigate(${JSON.stringify(routeTemplate)})`;
    }
    const state = args.map((a) => `${a.name}: ${a.value}`).join(", ");
    return `navigate(${JSON.stringify(routeTemplate)}, { state: { ${state} } })`;
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForTsx(type);
  },
};

// ---------------------------------------------------------------------------
// Internals — verbatim lifts from the inline walker so a delegating
// walker produces byte-identical output.
// ---------------------------------------------------------------------------

/** React-side hook variable name: `<aggCamel><OpPascal>`.  Mirrors
 *  `walker/api-hooks.ts:95`. */
function hookVarName(aggregate: string, op: string): string {
  return `${lowerFirstLocal(aggregate)}${upperFirstLocal(op)}`;
}

/** React-side hook fn name.  Mirrors `walker/api-hooks.ts:86-94`. */
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

/** Zero value per type.  Mirrors `walker/page-shell.ts:705-725`. */
function defaultInitForTsx(type: TypeIR): string {
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

// Local naming helpers — avoid importing from util/naming.ts so this
// module stays self-contained and easier to refactor.  Verbatim
// behaviour with the imported versions for the inputs the walker
// produces.
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
