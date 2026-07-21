// Flutter user-component projector — emits a `component Foo(params) { body }`
// declaration as a Dart widget, into one shared `lib/components.dart`.  The
// invocation seam (`flutter-target.ts`'s `renderUserComponent`) emits the
// constructor call `Foo(param: value)`; this module emits the class the call
// resolves to.
//
// TWO SHAPES:
//   • STATELESS (value-param, no own state/action) → a `StatelessWidget`: one
//     final field per param, the walked body as the `build` return.
//   • STATEFUL (`state {}` + named `action`s) → a `StatefulWidget` whose `State`
//     holds an immutable `<Comp>Model` (the same data-class shape a Riverpod page
//     projects), exposes each param as a `widget.<param>` getter, and wraps each
//     action body in `setState` — reusing the page path's `renderNotifierStmt`
//     (a write becomes `state = state.copyWith(field: value)`).  State is
//     per-instance (each `Foo(...)` its own `State`), which a shared Riverpod
//     provider would get wrong.
//
// A component that issues READS (a QueryView / api-hook body), an `extern`
// component (hand-written Dart), a `derived` binding, or an async-effect action
// (`match await`) is NOT threaded into the walker's `userComponents`, so its call
// falls back to the shared "unknown component" comment (never broken Dart).
// `slot`/children params are likewise deferred.

import type {
  ComponentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ParamIR,
  UiApiParamIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { walkBody } from "../_walker/walker-core.js";
import { dartType } from "./dart-types.js";
import { flutterTarget } from "./flutter-target.js";
import { flutterPack, usesIntl } from "./pack.js";
import {
  buildStateFields,
  buildStateInits,
  renderNotifierStmt,
  renderStateDataClass,
  stateCtx,
} from "./riverpod-emit.js";

/** Context the component walk needs — the same lookups the page walk threads. */
export interface ComponentWalkCtx {
  apiParams: readonly UiApiParamIR[];
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>;
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>;
}

interface ComponentWalkResult {
  widget: string;
  /** True when the body issues a data read (api hook) — a read component can't
   *  be a plain `StatelessWidget`/`StatefulWidget` here, so it stays deferred. */
  hasReads: boolean;
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
  );
  return { widget: r.tsx.trim(), hasReads: r.usedApiHooks.size > 0 };
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
 *  component is emittable iff its body issues no reads (nested component refs
 *  don't affect that probe). */
export function emittableComponentParams(
  components: readonly ComponentIR[],
  ctx: ComponentWalkCtx,
): Map<string, readonly ParamIR[]> {
  // First pass with NO threading — the read probe is independent of nesting.
  const all = new Map(candidates(components).map((c) => [c.name, c.params] as const));
  const out = new Map<string, readonly ParamIR[]>();
  for (const c of candidates(components)) {
    if (!walkComponent(c, all, ctx).hasReads) out.set(c.name, c.params);
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

  const blocks = used.map((c) => {
    const { widget } = walkComponent(c, componentParams, ctx);
    const ctorArgs = c.params.map((p) => `required this.${p.name}`).join(", ");
    const fields = c.params.map((p) => `  final ${dartType(p.type)} ${p.name};`);
    return isStateful(c)
      ? renderStatefulComponent(c, widget, ctorArgs, fields, componentParams, ctx)
      : renderStatelessComponent(c, widget, ctorArgs, fields);
  });

  const imports = ["import 'package:flutter/material.dart';"];
  if (needsModels(used)) imports.push("import 'models.dart';");
  if (usesIntl(blocks.join("\n"))) imports.push("import 'package:intl/intl.dart';");
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
