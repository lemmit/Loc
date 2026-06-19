// ---------------------------------------------------------------------------
// Angular `WalkerTarget` — Angular-flavoured implementation of the
// cross-framework walker contract.  See `src/generator/_walker/target.ts`
// for the contract definition and scope, and
// `docs/plans/angular-frontend-plan.md` for the platform plan.
//
// Generated pages are standalone components: state fields are `signal()`s
// and API handles are toSignal-backed reads off `inject()`-ed `@Injectable`
// services, hoisted in the component class.  Everything the WALKER emits
// lands in the component `template`, where signals read with call syntax
// (`name()`) in EVERY position and write via `name.set(v)`.  Control flow
// uses Angular's built-in `@if` / `@for` / `@else if` blocks; bindings are
// `[prop]="…"` / `(event)="…"`; markup-valued matches render as `@if`
// chains (Angular template expressions can't evaluate to markup, like Vue).
// ---------------------------------------------------------------------------

import type { ExprIR, TypeIR } from "../../../ir/types/loom-ir.js";
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
import type { WalkContext } from "../../_walker/walker-core.js";
import { renderAngularAction } from "../action.js";
import { renderAngularCreateForm } from "../create-form.js";
import { renderAngularModal } from "../modal.js";

/** Angular-flavoured `WalkerTarget`.  Stateless and pure — no walker
 *  context is captured; every method takes the data it needs.  Consumed
 *  by the cross-target conformance test and the shared markup walker. */
export const angularTarget: WalkerTarget = {
  framework: "angular",

  // --- State seam ---------------------------------------------------------

  /** Signal read — call syntax in BOTH positions.  Angular signals are
   *  zoneless getters: `count()` reads the current value in templates
   *  and class code alike (no Vue-style position-dependent `.value`). */
  renderStateRead(ref: StateRef, _position: RenderPosition): string {
    return `${ref.name}()`;
  },

  /** `count.set(<expr>)` — a `state :=` write becomes a signal `set`,
   *  emitted inline in an `(event)` handler. */
  renderStateWrite(ref: StateRef, value: string): string {
    return `${ref.name}.set(${value})`;
  },

  /** Immutable nested update via the signal's `set` — reads the current
   *  value through the signal call (`order()`), builds the spread inside-
   *  out, then `order.set({ ...order(), shipping: { ...order().shipping,
   *  zip: v } })`.  Angular signals don't react to in-place mutation. */
  renderNestedStateWrite(segments: readonly string[], valueJs: string): string {
    const root = segments[0]!;
    let value = valueJs;
    for (let i = segments.length - 1; i >= 1; i--) {
      const prefix = [`${root}()`, ...segments.slice(1, i)].join(".");
      value = `{ ...${prefix}, ${segments[i]!}: ${value} }`;
    }
    return `${root}.set(${value})`;
  },

  // --- API binding seam ---------------------------------------------------

  /** Same `use*` naming + `../api/<agg>` import as React/Vue — the
   *  generated api-service surface stays name-identical across the SPA
   *  frontends so the shared api-module builder is reusable.  On
   *  Angular the `use*` factory returns a toSignal-backed read handle
   *  (or calls a service mutation), hoisted in the component class. */
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

  /** Var-only, like TSX/Vue: the handle is hoisted ONCE in the
   *  component class and every IR call site references the var; chained
   *  access (`.value()` / `.mutate(args)` / `.isPending()`) comes from
   *  the surrounding IR walk. */
  renderApiCall(call: ApiCallSite, _renderedArgs: string): string {
    return call.varName ?? hookVarName(call.aggregateName, call.operation);
  },

  /** Hoist one `readonly <var> = <hook>(args);` CLASS FIELD per unique hook
   *  usage — the field initializer is the injection context the `use*`
   *  factory's `inject()` needs.  (TSX/Vue hoist `const` lines into the
   *  function body; Angular components have no function body, so the reads
   *  live as members.)  Same de-dupe + fallback semantics as the other
   *  targets. */
  renderApiHoisting(uses: ApiCallSite[]): string[] {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const u of uses) {
      const varName = u.varName ?? hookVarName(u.aggregateName, u.operation);
      if (seen.has(varName)) continue;
      seen.add(varName);
      const hookName = u.hookName ?? hookFnName(u.aggregateName, u.operation);
      const args = u.argsRendered ?? [];
      lines.push(`readonly ${varName} = ${hookName}(${args.join(", ")});`);
    }
    return lines;
  },

  /** Angular's read handle exposes `data` as a SIGNAL, so the QueryView
   *  data-lambda binding calls it (`<handle>.data()`).  TSX/Vue read the
   *  TanStack `.data` property directly (the omitted-default path).  For a byId
   *  read (`single`) `data()` is `T | null`; the template's `@if (…data())`
   *  guard can't narrow a call result, so assert non-null inside it. */
  renderQueryDataAccess(handle: string, single?: boolean): string {
    return single ? `${handle}.data()!` : `${handle}.data()`;
  },

  /** Fork `CreateForm(of: …)` to idiomatic typed Reactive Forms (the shared
   *  react-hook-form path is skipped for Angular). */
  renderCreateForm(call: ExprIR, ctx: WalkContext, depth: number): string | null {
    return call.kind === "call" ? renderAngularCreateForm(call, ctx, depth) : null;
  },

  /** Fork `Action(inst.op)` to an inline statement-bound button + an
   *  id-at-mutate hoist (Angular templates can't host the JSX arrow). */
  renderAction(call: ExprIR, ctx: WalkContext, depth: number): string | null {
    return call.kind === "call" ? renderAngularAction(call, ctx, depth) : null;
  },

  /** Defer the operation-dialog form — Angular renders forms inline (no
   *  `field-input-*` / `primitive-modal` templates), and the dialog form is a
   *  later batch.  Returning a comment here keeps the op-form path off the
   *  shared RHF dispatch so the page renders a placeholder instead of crashing
   *  on a missing template. */
  renderOperationForm(_call: ExprIR): string | null {
    return "<!-- OperationForm: the operation-dialog form is not yet supported on Angular -->";
  },

  /** Fork `Modal { OperationForm(…), trigger: … }` to a signal-toggled inline
   *  Reactive Form (the operation-dialog form). */
  renderModal(call: ExprIR, ctx: WalkContext, depth: number): string | null {
    return call.kind === "call" ? renderAngularModal(call, ctx, depth) : null;
  },

  /** `Button(to:)` → `router.navigateByUrl(<to>)` (bound as a statement by
   *  `renderEventHandler`); `router` is injected via `usesNavigate`. */
  renderNavigateExpr(toArg: string): string {
    return `router.navigateByUrl(${toArg})`;
  },

  // --- Match expression seam ----------------------------------------------

  /** Chained ternaries — Angular interpolations + bindings evaluate JS
   *  expressions, so a value-position `match` is a ternary chain (same
   *  as TSX/Vue); markup-valued conditional CHILDREN go through
   *  `renderMatchChild` (`@if` chains) instead. */
  renderMatch(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
  ): string {
    return renderJsMatch(arms, elseArm);
  },

  /** Child-position match — an `@if (pred) { … } @else if (pred) { … }
   *  @else { … }` control-flow chain.  Angular template expressions
   *  can't evaluate to markup (no JSX-style markup-valued ternary), so
   *  markup-valued arms render as control-flow blocks — the same
   *  divergence Vue (`<template v-if>`) and Svelte (`{#if}`) have. */
  renderMatchChild(
    arms: ReadonlyArray<{ predicate: string; value: string }>,
    elseArm: string | undefined,
    depth: number,
  ): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    const blocks: string[] = [];
    arms.forEach((arm, i) => {
      const open = i === 0 ? `@if (${arm.predicate}) {` : `} @else if (${arm.predicate}) {`;
      blocks.push(`${open}\n${inner}${arm.value}`);
    });
    if (elseArm !== undefined) {
      blocks.push(`} @else {\n${inner}${elseArm}`);
    }
    return `${blocks.join(`\n${pad}`)}\n${pad}}`;
  },

  // --- List-comprehension seam --------------------------------------------

  /** `@for (item of coll; track <key>) { body }` — Angular's built-in
   *  control-flow loop.  `track` is mandatory; the index alias
   *  (`let idx = $index`) is declared only when the body references it.
   *  A bare-index key collapses to `track $index`. */
  renderForEach(
    coll: string,
    itemVar: string,
    indexVar: string,
    keyExpr: string,
    body: string,
    depth: number,
  ): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    const trackExpr = keyExpr === indexVar ? "$index" : keyExpr;
    const usesIdxInBody = referencesIdent(body, indexVar);
    const ctxVar = usesIdxInBody ? `; let ${indexVar} = $index` : "";
    return [
      `@for (${itemVar} of ${coll}; track ${trackExpr}${ctxVar}) {`,
      `${inner}${body}`,
      `${pad}}`,
    ].join("\n");
  },

  // --- Navigation seam ----------------------------------------------------

  /** `router.navigateByUrl(...)` — the component class hoists
   *  `readonly router = inject(Router);` whenever navigation is used.
   *  Route state rides Angular's `NavigationBehaviorOptions.state`, the
   *  analogue of React Router's `navigate(path, { state })`. */
  renderNavigate(
    routeTemplate: string,
    args: ReadonlyArray<{ name: string; value: string }>,
    stateExpr?: string,
  ): string {
    if (stateExpr !== undefined) {
      return `router.navigateByUrl(${JSON.stringify(routeTemplate)}, { state: ${stateExpr} })`;
    }
    if (args.length === 0) {
      return `router.navigateByUrl(${JSON.stringify(routeTemplate)})`;
    }
    const state = args.map((a) => `${a.name}: ${a.value}`).join(", ");
    return `router.navigateByUrl(${JSON.stringify(routeTemplate)}, { state: { ${state} } })`;
  },

  // --- Type-default seam --------------------------------------------------

  defaultInitFor(type: TypeIR): string {
    return defaultInitForJs(type);
  },

  // --- Markup seams ---------------------------------------------------------

  /** HTML comment — Angular templates use plain markup comments. */
  renderComment(text: string): string {
    return `<!-- ${text} -->`;
  },

  /** Angular interpolation in text/child position. */
  renderInterpolation(jsExpr: string): string {
    return `{{ ${jsExpr} }}`;
  },

  /** Angular property binding — `[name]="expr"`, leading space included.
   *  The expression is quoted, so pick the quote the rendered JS doesn't
   *  use (JS string literals render double-quoted via JSON.stringify, so
   *  a `"`-bearing expression binds single-quoted).  An expression
   *  carrying BOTH quote kinds can't be attribute-quoted — fail loud
   *  rather than emit a template that won't compile. */
  renderAttrBinding(name: string, jsExpr: string): string {
    if (!jsExpr.includes('"')) return ` [${name}]="${jsExpr}"`;
    if (!jsExpr.includes("'")) return ` [${name}]='${jsExpr}'`;
    throw new Error(
      `angularTarget.renderAttrBinding: expression for '[${name}]' mixes single and double quotes — cannot be attribute-quoted. Simplify the expression (e.g. avoid apostrophes inside string literals used in bindings).`,
    );
  },

  /** `@if (cond) { … } @else { … }` control-flow block pair.  Angular
   *  template expressions can't evaluate to markup, so conditional
   *  children render as control-flow blocks (the Vue `<template v-if>` /
   *  Svelte `{#if}` analogue). */
  renderConditionalChild(cond: string, thenS: string, elseS: string, depth: number): string {
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    return [
      `@if (${cond}) {`,
      `${inner}${thenS}`,
      `${pad}} @else {`,
      `${inner}${elseS}`,
      `${pad}}`,
    ].join("\n");
  },

  /** Style attribute.  All-literal entries collapse to a flat CSS string
   *  (`style="…"`); any dynamic entry forces the `[style]` object
   *  binding (camelCase keys), single-quoted because rendered value
   *  expressions use double-quoted JS string literals. */
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
    return ` [style]='{ ${parts.join(", ")} }'`;
  },

  /** Angular template text escaping.  Entity-escape `&` (first) plus the
   *  tag delimiters; `{`/`}` entity-escape too so a literal `{{` can
   *  never form an interpolation. */
  escapeText(text: string): string {
    return escapeJsFamilyText(text);
  },

  /** Content projection — Angular's children slot is `<ng-content>`. */
  renderChildrenSlot(): string {
    return "<ng-content></ng-content>";
  },

  /** Event handler in `(click)`-style binding position.  Angular binds
   *  a STATEMENT, not a function value, so the lambda's arrow wrapper is
   *  dropped: the block form inlines its statements (`;`-joined, each
   *  trailing `;` trimmed — the binding is one statement context); the
   *  expression form passes through verbatim.  An empty handler is the
   *  empty string. */
  renderEventHandler(statements: readonly string[] | undefined, expr: string | undefined): string {
    if (statements && statements.length > 0) {
      return statements.map((s) => s.replace(/;\s*$/, "")).join("; ");
    }
    return expr ?? "";
  },
};
