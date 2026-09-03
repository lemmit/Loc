// Flutter user-component projector — emits a `component Foo(params) { body }`
// declaration as a Dart widget, into one shared `lib/components.dart`.  The
// invocation seam (`flutter-target.ts`'s `renderUserComponent`) emits the
// constructor call `Foo(param: value)`; this module emits the class the call
// resolves to.
//
// THREE SHAPES:
//   • STATELESS (value-param, no own state/action) → a `StatelessWidget`: one
//     final field per param, the walked body as the `build` return.
//   • READ-BEARING (a `QueryView { of: … }` body, no own state) → a Riverpod
//     `ConsumerWidget`, exactly as a read-bearing PAGE is: `build` receives the
//     `WidgetRef` and hoists `ref.watch(<var>Provider…)` through the same
//     `renderApiHoisting` seam, and `collectFlutterReads` scans component bodies
//     so the provider it watches exists in `reads.dart`.
//   • STATEFUL (`state {}` + named `action`s) → a `StatefulWidget` whose `State`
//     holds an immutable `<Comp>Model` (the same data-class shape a Riverpod page
//     projects), exposes each param as a `widget.<param>` getter, and wraps each
//     action body in `setState` — reusing the page path's `renderNotifierStmt`
//     (a write becomes `state = state.copyWith(field: value)`).  State is
//     per-instance (each `Foo(...)` its own `State`), which a shared Riverpod
//     provider would get wrong.
//
// A `derived` binding rides ALL THREE shapes: it is a pure function of the
// params (and, on the stateful shape, of `state`), so it emits as a Dart GETTER
// on the class whose scope those names live in — the widget for the stateless /
// consumer shapes, the `State` for the stateful one — and the body reads it
// bare through the walker's `renderDerivedRead` seam.  Before that seam a
// derived read was spelled `state.<name>`, a field the `<Comp>Model` data class
// never declares, so every `derived`-bearing component was dropped WHOLE.
//
// An `extern` component (hand-written Dart), an async-effect action
// (`match await`), a STORE read (the binding is named by the page shell, not
// here), ANY use of the ROUTE id (a bare `id`, a `byId(id)` read, and the
// primitives whose Dart addresses the row by it — `OperationForm` /
// `DestroyForm` / a `Modal` hosting one), a `currentUser` claim read, a
// `derived` reaching for one of those same page-shell-only bindings, and a
// stateful component that ALSO reads (that would need `ConsumerStatefulWidget`)
// are NOT threaded into the walker's `userComponents`, so their calls fall back
// to the shared "unknown component" comment (never broken Dart).
//
// The route-id and `currentUser` filters used to be NARROWER than the bindings
// they protect: `usesRouteId` was tested only inside `isReadConsumer` (so it
// only ran for a READ-BEARING component) and `usesCurrentUser` was not tested at
// all.  Both leaks emitted a widget naming an undeclared local — `Text('${id}')`
// / `Text('${currentUser.id}')`, i.e. `Undefined name` Dart that `flutter
// analyze` rejects — which is worse than the drop it was meant to avoid.
//
// Every filter here is REPORTED by `loom.user-component-deferred-target`
// (`src/ir/validate/checks/ui-checks.ts`, the flutter arms), so a dropped
// component is a diagnostic rather than a silent vanish.

import type {
  ComponentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ParamIR,
  UiApiParamIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import type { ApiCallSite } from "../_walker/target.js";
import { type ApiHookUse, emitExpr, walkBody } from "../_walker/walker-core.js";
import { FLUTTER_CHILD_PARAM } from "./dart-expr.js";
import { dartType } from "./dart-types.js";
import { flutterTarget } from "./flutter-target.js";
import { flutterPack, usesIntl, usesMath } from "./pack.js";
import {
  buildStateFields,
  buildStateInits,
  renderNotifierStmt,
  renderStateDataClass,
  stateCtx,
  stateSetterMethods,
} from "./riverpod-emit.js";

/** Context the component walk needs — the same lookups the page walk threads. */
export interface ComponentWalkCtx {
  apiParams: readonly UiApiParamIR[];
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>;
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>;
  /** True when the ui has extractable user-visible strings (M-T1.11) — the walk
   *  then keys every literal text slot to the catalog (`component.<Name>.…`) and
   *  emits `t(…)`.  False → no prefix, byte-identical to pre-i18n. */
  i18nEnabled?: boolean;
}

interface ComponentWalkResult {
  widget: string;
  /** The api reads the body issued, in walk order — the same `ApiHookUse`
   *  entries a page's `renderConsumerPage` feeds to `renderApiHoisting`.  A
   *  non-empty map turns the widget into a `ConsumerWidget` whose `build`
   *  hoists `final <var> = ref.watch(<var>Provider…)`. */
  apiHooks: ReadonlyMap<string, ApiHookUse>;
  /** True when the body's read is keyed by the ROUTE id (`byId(id)`) — the
   *  walker renders that as the bare local `id`, which only a page shell binds
   *  from its route arguments.  A component has no route, so such a body stays
   *  deferred rather than emitting Dart that names nothing. */
  usesRouteId: boolean;
  /** True when the body reads a store field / calls a store action.  A store is
   *  a Riverpod provider, so reaching it needs a `WidgetRef` — which only the
   *  page path's `ConsumerWidget` carries.  Rather than bind a name nothing
   *  declares, such a component is dropped from the emittable set and its call
   *  site falls back to the shared "unknown component" comment. */
  usesStores: boolean;
  /** True when the body reads `currentUser.<claim>`.  The session is bound by
   *  the PAGE shell (`final currentUser = ref.watch(sessionProvider).value!`),
   *  never by a component — so a component naming it emitted `Undefined name
   *  'currentUser'` Dart.  Deferred instead. */
  usesCurrentUser: boolean;
  /** True when the body contains `Slot { }` — the widget then takes an optional
   *  `child` constructor param for the caller's markup to land in. */
  usesChildren: boolean;
}

/** Walk a component body once through the shared engine, with its own state +
 *  param names in scope (stateful components read `state.<f>` / their param
 *  getters).  Returns the rendered widget + whether it issues reads. */
function walkComponent(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: ComponentWalkCtx,
): ComponentWalkResult {
  const paramNames = new Set(c.params.map((p) => p.name));
  const stateNames = new Set(c.state.map((s) => s.name));
  const r = walkBody(
    c.body!,
    flutterTarget,
    flutterPack(),
    paramNames,
    stateNames,
    componentParams,
    ctx.apiParams,
    ctx.aggregatesByName,
    ctx.bcByAggregate,
    new Map(), // workflowsByName — a component hosts no WorkflowForm
    new Map(), // bcByWorkflow
    new Map(), // paramTypes
    new Map(), // pageRoutes
    new Set(), // externFunctions
    // `derived` bindings — read BARE (a class getter, see `derivedGetters`),
    // which is what `flutterTarget.renderDerivedRead` spells.
    new Set(c.derived.map((d) => d.name)),
    false, // authUi
    // i18n key prefix — `component.<Name>` matches the catalog.
    ctx.i18nEnabled ? `component.${c.name}` : undefined,
  );
  return {
    widget: r.tsx.trim(),
    apiHooks: r.usedApiHooks,
    usesRouteId: r.usesRouteId,
    usesStores: (r.usedStores?.size ?? 0) > 0,
    usesCurrentUser: r.usesCurrentUser,
    usesChildren: r.usesChildren,
  };
}

/** True when this component's walk can ride the `ConsumerWidget` path — it
 *  issues reads and carries no `state {}` of its own (a stateful+reads component
 *  would need `ConsumerStatefulWidget`, still deferred).  The route-id case is
 *  handled one level up, by `needsRouteId`, because it disqualifies a component
 *  whether or not it reads. */
function isReadConsumer(c: ComponentIR, r: ComponentWalkResult): boolean {
  return r.apiHooks.size > 0 && !isStateful(c);
}

/** True when the walk bound the magic route `id` — a local ONLY a page shell
 *  declares (`routeArgBindings` in `index.ts`).  No component shape binds it, so
 *  emitting one that names it produces `Undefined name 'id'`.
 *
 *  This used to be tested only INSIDE `isReadConsumer`, i.e. only for a
 *  READ-BEARING component.  A component whose body merely rendered `id`
 *  (`component BareId() { body: Text { id } }`) issued no api read, so the guard
 *  never ran and the widget emitted as `Text('${id}')` — uncompilable Dart in a
 *  file `flutter analyze` would reject.  Deferring it instead keeps the
 *  never-broken-output rule; the loss is reported by
 *  `loom.user-component-deferred-target` (`ui-checks.ts`, the flutter arms). */
function needsRouteId(r: ComponentWalkResult): boolean {
  return r.usesRouteId;
}

/** True when the walk named a binding only a PAGE SHELL declares — the route
 *  `id` or the session `currentUser`.  Both were previously tested only on the
 *  read-bearing path (or not at all), so a component naming one emitted Dart
 *  that referenced an undeclared local.  The body-side twin of
 *  `derivedNeedsShell`, which already covers the same two (plus stores) on the
 *  `derived` side. */
function needsPageShell(r: ComponentWalkResult): boolean {
  return needsRouteId(r) || r.usesCurrentUser;
}

/** True when a component carries its own reactive state — the `StatefulWidget`
 *  path.  (A component with actions but no state has nothing to `setState`, so it
 *  is not treated as stateful.) */
function isStateful(c: ComponentIR): boolean {
  return c.state.length > 0;
}

/** True when an action awaits a remote effect (`match await` → a `variant-match`
 *  statement).  Those need the page's notifier/route-id machinery — deferred, so
 *  a component carrying one is not emittable here. */
function hasAsyncEffectAction(c: ComponentIR): boolean {
  return c.actions.some((a) => a.body.some((s) => s.kind === "variant-match"));
}

/** True when a `derived` expression reaches for a binding only a PAGE SHELL
 *  supplies — a store member (a Riverpod provider needing a `WidgetRef`), the
 *  route `id`, or the session `currentUser`.  A getter naming one of those would
 *  be `Undefined name` Dart, so its component stays deferred instead.  (The
 *  body walk has its own probes for the same three; this is the derived-side
 *  twin, which the walk never sees.) */
function derivedNeedsShell(e: ExprIR): boolean {
  if (e.kind === "id") return true;
  if (e.kind === "ref" && (e.refKind === "store-field" || e.refKind === "current-user"))
    return true;
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) {
      for (const c of v)
        if (c && typeof c === "object" && "kind" in c && derivedNeedsShell(c)) {
          return true;
        }
    } else if (v && typeof v === "object" && "kind" in v && derivedNeedsShell(v as ExprIR)) {
      return true;
    }
  }
  return false;
}

/** The candidate components — non-extern, with a body, no async-effect action,
 *  and no `derived` reaching for a page-shell-only binding.  All three shapes
 *  (stateless, read-bearing consumer, stateful) carry their `derived` bindings
 *  as class getters. */
function candidates(components: readonly ComponentIR[]): ComponentIR[] {
  return components.filter(
    (c) =>
      !c.extern &&
      !hasAsyncEffectAction(c) &&
      c.body !== undefined &&
      !c.derived.some((d) => derivedNeedsShell(d.expr)),
  );
}

/** One `<DartType> get <name> => <expr>;` per `derived` binding, in declaration
 *  order so a later one may read an earlier (Dart getters are order-free, but
 *  the `derivedNames` scope has to grow left-to-right for the REF to resolve as
 *  a bare name rather than a stray identifier).
 *
 *  Emitted on the class whose scope the expression's names live in: for the
 *  stateless / consumer shapes that is the widget (params are its `final`
 *  fields); for the stateful shape it is the `State` (params arrive through its
 *  `widget.<p>` getters and `state.<f>` is its model). */
function derivedGetters(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: ComponentWalkCtx,
): string[] {
  const seen = new Set<string>();
  return c.derived.map((d) => {
    const dctx = stateCtx({
      stateNames: new Set(c.state.map((s) => s.name)),
      derivedNames: new Set(seen),
      aggregatesByName: ctx.aggregatesByName,
      locals: new Map(),
      paramNames: new Set(c.params.map((p) => p.name)),
      apiParamNames: new Map(ctx.apiParams.map((p) => [p.name, p.apiName])),
      userComponents: componentParams,
    });
    const line = `  ${dartType(d.type)} get ${d.name} => ${emitExpr(d.expr, dctx)};`;
    seen.add(d.name);
    return line;
  });
}

/** The set of emittable components + their param lists — threaded into the page
 *  walker's `userComponents` so a `Foo(...)` call resolves (and only these, so a
 *  non-emittable component's call falls back to the diagnostic comment).  A
 *  read-BEARING component qualifies through the `ConsumerWidget` path
 *  (`isReadConsumer`); a store-bearing one still does not (a store binding is
 *  named by the page shell, not by the component). */
export function emittableComponentParams(
  components: readonly ComponentIR[],
  ctx: ComponentWalkCtx,
): Map<string, readonly ParamIR[]> {
  // First pass with NO threading — the probes are independent of nesting.
  const all = new Map(candidates(components).map((c) => [c.name, c.params] as const));
  const out = new Map<string, readonly ParamIR[]>();
  for (const c of candidates(components)) {
    const r = walkComponent(c, all, ctx);
    if (r.usesStores) continue;
    if (needsPageShell(r)) continue;
    if (r.apiHooks.size === 0 || isReadConsumer(c, r)) out.set(c.name, c.params);
  }
  return out;
}

/** True when a component's fields — params or `derived` getter return types —
 *  reference a non-primitive (domain) type, so `lib/components.dart` must import
 *  `../models.dart`. */
function needsModels(components: readonly ComponentIR[]): boolean {
  const prim = new Set(["String", "int", "double", "bool", "DateTime"]);
  const domain = (t: ParamIR["type"]): boolean => {
    const dt = dartType(t).replace(/\?$/, "");
    return !prim.has(dt) && !dt.startsWith("List<") && dt !== "dynamic";
  };
  return components.some(
    (c) => c.params.some((p) => domain(p.type)) || c.derived.some((d) => domain(d.type)),
  );
}

/** Emit a READ-BEARING component as a Riverpod `ConsumerWidget` — the exact
 *  shape a read-bearing PAGE takes (`renderConsumerPage`): `build` receives the
 *  `WidgetRef`, hoists one `final <var> = ref.watch(<var>Provider…)` per
 *  distinct read through the SAME `renderApiHoisting` seam, and returns the
 *  walked body (whose `QueryView` dispatches on that `AsyncValue` via `.when`).
 *  The providers themselves come from `reads.dart` — `collectFlutterReads` now
 *  scans component bodies alongside page bodies, so the watch and the provider
 *  cannot disagree. */
function renderConsumerComponent(
  c: ComponentIR,
  widget: string,
  ctorArgs: string,
  fields: string[],
  apiHooks: ReadonlyMap<string, ApiHookUse>,
): string {
  const uses: ApiCallSite[] = [...apiHooks.values()].map((h) => ({
    apiHandle: "",
    aggregateName: "",
    operation: "",
    kind: "query",
    args: [],
    varName: h.varName,
    argsRendered: h.argsRendered,
  }));
  return lines(
    `class ${c.name} extends ConsumerWidget {`,
    `  const ${c.name}({super.key${ctorArgs ? `, ${ctorArgs}` : ""}});`,
    ...fields,
    "",
    "  @override",
    "  Widget build(BuildContext context, WidgetRef ref) {",
    ...flutterTarget.renderApiHoisting(uses),
    `    return ${widget || "const SizedBox.shrink()"};`,
    "  }",
    "}",
  );
}

/** Emit a stateless component as a `StatelessWidget` (one final field per param,
 *  the walked body as `build`'s return). */
function renderStatelessComponent(
  c: ComponentIR,
  widget: string,
  ctorArgs: string,
  fields: string[],
): string {
  return lines(
    `class ${c.name} extends StatelessWidget {`,
    `  const ${c.name}({super.key${ctorArgs ? `, ${ctorArgs}` : ""}});`,
    ...fields,
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    `    return ${widget || "const SizedBox.shrink()"};`,
    "  }",
    "}",
  );
}

/** Emit a stateful component as a `StatefulWidget` + private `State`.  The State
 *  holds an immutable `<Comp>Model` (built in `initState`, where `widget` — and
 *  thus the param getters — is bound), exposes each param as a getter, and wraps
 *  each action's body in `setState` (writes reuse `renderNotifierStmt`). */
function renderStatefulComponent(
  c: ComponentIR,
  widget: string,
  ctorArgs: string,
  fields: string[],
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: ComponentWalkCtx,
  /** `derived` getters — on the STATE class, whose scope has both the param
   *  getters and `state`, not on the widget. */
  derived: readonly string[],
): string {
  const modelClass = `${c.name}Model`;
  const stateFields = buildStateFields(c.state);
  const stateNames = new Set(c.state.map((s) => s.name));
  // An action body / a state init may read a `derived` binding — bare, since it
  // is a getter on this same `State` class (`derivedGetters`).
  const derivedNames = new Set(c.derived.map((d) => d.name));
  const paramNames = new Set(c.params.map((p) => p.name));
  const apiParamNames = new Map(ctx.apiParams.map((p) => [p.name, p.apiName]));

  const modelLines = renderStateDataClass(modelClass, stateFields);

  // Initial model — param reads in an init resolve to the `widget.<p>` getters,
  // valid inside `initState` (where `widget` is bound; a field initializer is not).
  const initCtx = stateCtx({
    stateNames,
    derivedNames,
    aggregatesByName: ctx.aggregatesByName,
    locals: new Map(),
    paramNames,
    apiParamNames,
    userComponents: componentParams,
  });
  const { entries, constEligible } = buildStateInits(stateFields, initCtx);
  const modelCtor = `${constEligible ? "const " : ""}${modelClass}(${entries.join(", ")})`;

  // Param getters — a bare param read in the body/actions resolves here.
  const paramGetters = c.params.map(
    (p) => `  ${dartType(p.type)} get ${p.name} => widget.${p.name};`,
  );

  // Action methods — each body wrapped in `setState` (a write is
  // `state = state.copyWith(...)`; a sibling-action call re-enters an in-class
  // method).  The single payload param (if any) binds as a local.
  const actionMethods = c.actions.map((action) => {
    const param = action.params[0];
    const locals = new Map<string, string>();
    if (param) locals.set(param.name, param.name);
    const actionCtx = stateCtx({
      stateNames,
      derivedNames,
      aggregatesByName: ctx.aggregatesByName,
      locals,
      paramNames,
      apiParamNames,
      userComponents: componentParams,
    });
    const sig = param
      ? `void ${action.name}(${dartType(param.type)} ${param.name})`
      : `void ${action.name}()`;
    const body = action.body.map((s) => `      ${renderNotifierStmt(s, actionCtx)}`);
    return lines(`  ${sig} {`, "    setState(() {", ...body, "    });", "  }");
  });

  // Per-state-field setters — the in-class write side of a controlled input's
  // `bind:` (`set<Field>` / `set<Field>Text`; the pack emits a bare call that
  // resolves here in a component, or to a page-shell tear-off on a page).  Dart
  // flags unused LOCALS, not unused methods, so emitting one per cell is safe.
  const setterLines = stateSetterMethods(stateFields, (assign) => [
    "    setState(() {",
    `      ${assign}`,
    "    });",
  ]);

  const stateClassName = `_${c.name}State`;
  const stateClassLines = lines(
    `class ${stateClassName} extends State<${c.name}> {`,
    `  late ${modelClass} state;`,
    ...paramGetters,
    ...derived,
    "",
    "  @override",
    "  void initState() {",
    "    super.initState();",
    `    state = ${modelCtor};`,
    "  }",
    ...actionMethods.flatMap((m) => ["", m]),
    ...setterLines,
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    `    return ${widget || "const SizedBox.shrink()"};`,
    "  }",
    "}",
  );

  const widgetClassLines = lines(
    `class ${c.name} extends StatefulWidget {`,
    `  const ${c.name}({super.key${ctorArgs ? `, ${ctorArgs}` : ""}});`,
    ...fields,
    "",
    "  @override",
    `  State<${c.name}> createState() => ${stateClassName}();`,
    "}",
  );

  return [...modelLines, "", widgetClassLines, "", stateClassLines].join("\n");
}

/** Emit `lib/components.dart` — every USED emittable component as a widget
 *  (Stateless or Stateful).  Returns "" when the ui uses none (the caller emits
 *  no file). */
export function renderComponentsFile(
  components: readonly ComponentIR[],
  usedNames: ReadonlySet<string>,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: ComponentWalkCtx,
): string {
  const used = candidates(components).filter((c) => usedNames.has(c.name));
  if (used.length === 0) return "";

  let anyConsumer = false;
  const blocks = used.map((c) => {
    const walked = walkComponent(c, componentParams, ctx);
    const { widget, usesChildren } = walked;
    const ctorParts = c.params.map((p) => `required this.${p.name}`);
    const fields = c.params.map((p) => `  final ${dartType(p.type)} ${p.name};`);
    // `Slot { }` in the body reads the `child` param — OPTIONAL (not `required`),
    // so a call site that passes no children still constructs, and the slot's
    // `child ?? const SizedBox.shrink()` renders nothing.
    if (usesChildren) {
      ctorParts.push(`this.${FLUTTER_CHILD_PARAM}`);
      fields.push(`  final Widget? ${FLUTTER_CHILD_PARAM};`);
    }
    const ctorArgs = ctorParts.join(", ");
    // `derived` getters land on the class whose scope their expression reads:
    // the widget for the stateless / consumer shapes, the `State` for a
    // stateful one (where the params are `widget.<p>` getters and `state` is
    // the model).
    const derived = derivedGetters(c, componentParams, ctx);
    if (isReadConsumer(c, walked)) {
      anyConsumer = true;
      return renderConsumerComponent(c, widget, ctorArgs, [...fields, ...derived], walked.apiHooks);
    }
    return isStateful(c)
      ? renderStatefulComponent(c, widget, ctorArgs, fields, componentParams, ctx, derived)
      : renderStatelessComponent(c, widget, ctorArgs, [...fields, ...derived]);
  });

  const imports = ["import 'package:flutter/material.dart';"];
  // A read-bearing component is a `ConsumerWidget` watching a provider from
  // `reads.dart` — both imports are needed exactly when one emitted.
  if (anyConsumer) {
    imports.push(
      "import 'package:flutter_riverpod/flutter_riverpod.dart';",
      "import 'reads.dart';",
    );
  }
  if (needsModels(used)) imports.push("import 'models.dart';");
  if (usesIntl(blocks.join("\n"))) imports.push("import 'package:intl/intl.dart';");
  // The generated translation runtime (M-T1.11) — a sibling of this file under
  // `lib/`, imported only when a component body resolved a `t(…)` call.
  if (/(?<![A-Za-z0-9_$.])t\(/.test(blocks.join("\n"))) imports.push("import 'i18n.dart';");
  // `min`/`max`/`round` scalar intrinsics route through `math.*` (`dart-expr.ts`).
  if (usesMath(blocks.join("\n"))) imports.push("import 'dart:math' as math;");
  return `${lines(
    "// User components — one widget per `component Foo(params) { body }` a ui",
    "// hosts (StatelessWidget, or StatefulWidget when it carries `state`).",
    "// Generated by the Loom Flutter target; do not edit.",
    "",
    ...imports,
    "",
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  )}\n`;
}
