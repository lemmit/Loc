// Flutter user-component projector — emits a `component Foo(params) { body }`
// declaration as a Dart `StatelessWidget` (one final field per param, the walked
// body as the `build` return).  The invocation seam (`flutter-target.ts`'s
// `renderUserComponent`) emits the constructor call `Foo(param: value)`; this
// module emits the class the call resolves to, into one shared
// `lib/components.dart`.
//
// SCOPE (this slice): STATELESS, value-param, no-read presentational components
// — params → widget tree.  A component with its own `state`/`action`/`derived`
// (a stateful component → its own Notifier), an `extern` component (hand-written
// Dart), or a body that issues reads is NOT threaded into the walker's
// `userComponents`, so its call falls back to the shared "unknown component"
// comment (never broken Dart).  `slot`/children params are likewise deferred.

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
import { flutterPack } from "./pack.js";

/** Context the component walk needs — the same lookups the page walk threads. */
export interface ComponentWalkCtx {
  apiParams: readonly UiApiParamIR[];
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>;
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>;
}

/** Walk a component body once, returning its rendered widget + whether it is
 *  emittable as a plain `StatelessWidget` (no reads, no state usage). */
function walkComponent(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: ComponentWalkCtx,
): { widget: string; emittable: boolean } {
  const paramNames = new Set(c.params.map((p) => p.name));
  const r = walkBody(
    c.body!,
    flutterTarget,
    flutterPack(),
    paramNames,
    new Set(), // no state
    componentParams,
    ctx.apiParams,
    ctx.aggregatesByName,
    ctx.bcByAggregate,
  );
  return { widget: r.tsx.trim(), emittable: r.usedApiHooks.size === 0 && !r.usesState };
}

/** The candidate components — non-extern, no own state/action/derived, with a
 *  body.  A stateful component (its own Notifier) is a documented follow-up. */
function candidates(components: readonly ComponentIR[]): ComponentIR[] {
  return components.filter(
    (c) =>
      !c.extern &&
      c.state.length === 0 &&
      c.actions.length === 0 &&
      c.derived.length === 0 &&
      c.body !== undefined,
  );
}

/** The set of emittable components + their param lists — threaded into the page
 *  walker's `userComponents` so a `Foo(...)` call resolves (and only these, so a
 *  non-emittable component's call falls back to the diagnostic comment). */
export function emittableComponentParams(
  components: readonly ComponentIR[],
  ctx: ComponentWalkCtx,
): Map<string, readonly ParamIR[]> {
  // First pass with NO threading — a candidate is emittable iff its body issues
  // no reads and uses no state (nested component refs don't affect that probe).
  const all = new Map(candidates(components).map((c) => [c.name, c.params] as const));
  const out = new Map<string, readonly ParamIR[]>();
  for (const c of candidates(components)) {
    if (walkComponent(c, all, ctx).emittable) out.set(c.name, c.params);
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

/** Emit `lib/components.dart` — every USED emittable component as a
 *  `StatelessWidget`.  Returns "" when the ui uses none (the caller emits no
 *  file). */
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
  });

  const imports = ["import 'package:flutter/material.dart';"];
  if (needsModels(used)) imports.push("import 'models.dart';");
  return `${lines(
    "// User components — one StatelessWidget per `component Foo(params) { body }`",
    "// a ui hosts.  Generated by the Loom Flutter target; do not edit.",
    "",
    ...imports,
    "",
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
  )}\n`;
}
