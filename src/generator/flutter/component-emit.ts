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
// An `extern` component (hand-written Dart), a `derived` binding, an
// async-effect action (`match await`), a STORE read (the binding is named by the
// page shell, not here), a read keyed by the ROUTE id (`byId(id)` — no route on
// a component), and a stateful component that ALSO reads (that would need
// `ConsumerStatefulWidget`) are NOT threaded into the walker's `userComponents`,
// so their calls fall back to the shared "unknown component" comment (never
// broken Dart).

import type {
  ComponentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ParamIR,
  UiApiParamIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import type { ApiCallSite } from "../_walker/target.js";
import { type ApiHookUse, walkBody } from "../_walker/walker-core.js";
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
    new Set(), // derivedNames — `candidates()` excludes derived-bearing components
    false, // authUi
    // i18n key prefix — `component.<Name>` matches the catalog.
    ctx.i18nEnabled ? `component.${c.name}` : undefined,
  );
  return {
    widget: r.tsx.trim(),
    apiHooks: r.usedApiHooks,
    usesRouteId: r.usesRouteId,
    usesStores: (r.usedStores?.size ?? 0) > 0,
    usesChildren: r.usesChildren,
  };
}

/** True when this component's walk can ride the `ConsumerWidget` path — it
 *  issues reads, carries no `state {}` of its own (a stateful+reads component
 *  would need `ConsumerStatefulWidget`, still deferred), and its reads are not
 *  keyed by a route id it has no way to bind. */
function isReadConsumer(c: ComponentIR, r: ComponentWalkResult): boolean {
  return r.apiHooks.size > 0 && !isStateful(c) && !r.usesRouteId;
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

/** The candidate components — non-extern, no `derived`, with a body.  A `derived`
 *  binding reads as `state.<name>` which the component's Model doesn't carry, so
 *  those stay deferred.  Both stateless and stateful (`state {}` + `action`s)
 *  shapes qualify. */
function candidates(components: readonly ComponentIR[]): ComponentIR[] {
  return components.filter(
    (c) => !c.extern && c.derived.length === 0 && !hasAsyncEffectAction(c) && c.body !== undefined,
  );
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
    if (r.apiHooks.size === 0 || isReadConsumer(c, r)) out.set(c.name, c.params);
  }
  return out;
}

/** True when a component's fields reference a non-primitive (domain) type, so
 *  `lib/components.dart` must import `../models.dart`. */
function needsModels(components: readonly ComponentIR[]): boolean {
  const prim = new Set(["String", "int", "double", "bool", "DateTime"]);
  return components.some((c) =>
    c.params.some((p) => {
      const dt = dartType(p.type).replace(/\?$/, "");
      return !prim.has(dt) && !dt.startsWith("List<") && dt !== "dynamic";
    }),
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
): string {
  const modelClass = `${c.name}Model`;
  const stateFields = buildStateFields(c.state);
  const stateNames = new Set(c.state.map((s) => s.name));
  const derivedNames = new Set<string>();
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
    if (isReadConsumer(c, walked)) {
      anyConsumer = true;
      return renderConsumerComponent(c, widget, ctorArgs, fields, walked.apiHooks);
    }
    return isStateful(c)
      ? renderStatefulComponent(c, widget, ctorArgs, fields, componentParams, ctx)
      : renderStatelessComponent(c, widget, ctorArgs, fields);
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
