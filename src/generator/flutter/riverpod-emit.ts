// Riverpod state/action projector — the Flutter analogue of Feliz's
// `update-emit.ts` (the Elmish Model/Msg/update projection).
//
// The view seams (`flutter-target.ts`) emit READS (`state.<field>`) + INTENT (a
// button whose `onClick: inc` calls the notifier tear-off `inc()`); this module
// projects a page's `state {}` + named `action`s into the Riverpod triad:
//
//   1. A `<Page>State` immutable data class — one `final` field per state cell
//      (types via `dartType`), a `const` constructor, and a `copyWith`.
//   2. A `<Page>Notifier extends Notifier<<Page>State>` whose `build()` returns
//      the initial state (each `StateFieldIR.init`, else the type's zero value)
//      and which carries one method per `action`.
//   3. A `final <page>Provider = NotifierProvider<…>(…new);`.
//
// The Notifier method bodies are the one place a state WRITE lands in
// notifier-method context (`state = state.copyWith(field: value)`), so — exactly
// like Feliz's `renderUpdateStmt` sitting apart from the walker's `emitStmt` —
// the write projection lives HERE, not in the `flutterTarget` view seam (whose
// `renderStateWrite` stays the deferred inline-view-write stub).  Value
// expressions still route through the shared `emitExpr` so a `count` read on the
// RHS resolves through `flutterTarget.renderStateRead` to `state.count`.
//
// SCOPE (this slice): scalar/collection `:=`/`+=`/`-=` writes, `let`, bare
// expression statements, and sibling-action calls.  Nested-target writes
// (`order.shipping.zip := v`) and store/async-effect action bodies are marked
// `TODO(flutter full-parity)` — a deep immutable rebuild is out of scope here.

import { variantTag } from "../../ir/stdlib/unions.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  PageIR,
  ParamIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { errorTypeUri } from "../../util/error-defaults.js";
import { lowerFirst, plural, snake, upperFirst } from "../../util/naming.js";
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import { emitExpr, type WalkContext } from "../_walker/walker-core.js";
import { dartString, dartZeroValue } from "./dart-expr.js";
import { dartType } from "./dart-types.js";
import { flutterTarget } from "./flutter-target.js";
import { flutterPack } from "./pack.js";

/** The projected Riverpod triad for one stateful page. */
export interface RiverpodProjection {
  /** Provider variable name (`counterProvider`). */
  providerName: string;
  /** State data-class name (`CounterState`). */
  stateClass: string;
  /** Notifier class name (`CounterNotifier`). */
  notifierClass: string;
  /** Dart source: state class + notifier + provider (imports emitted by the
   *  page shell, not here). */
  source: string;
  /** Names of actions whose body awaits a remote effect (`match await`).  Their
   *  Notifier method is `Future<void> <name>(String id) async` (needs the route
   *  id), so the page shell binds each as an id-capturing closure tear-off. */
  asyncEffectActions: Set<string>;
}

/** True when an action body awaits a remote effect — a `match await` (lowered to
 *  a `variant-match` statement).  Drives the async Notifier-method shape + the
 *  page's route-id / http / models imports. */
function actionHasAsyncEffect(action: PageIR["actions"][number]): boolean {
  return action.body.some((s) => s.kind === "variant-match");
}

/** True when a page carries reactive state and/or named actions — the trigger
 *  for the `ConsumerWidget` + Riverpod projection path (the display-only pages
 *  stay plain `StatelessWidget`s). */
export function hasRiverpodState(page: PageIR): boolean {
  return page.state.length > 0 || page.actions.length > 0;
}

/** Build a minimal `WalkContext` for rendering a state-writing method body /
 *  state init through the shared `emitExpr` (so RHS reads dereference the
 *  projected `state`).  Shared by the page Notifier projection (Riverpod) and
 *  the component `StatefulWidget` projection — both write `state = state.copyWith(…)`.
 *
 *  `locals` binds an action's payload param so a body ref to it resolves to the
 *  bare Dart identifier; `paramNames` (component path) lets a param read render
 *  bare (resolving to the `widget.<param>` getter on the State); `userComponents`
 *  lets a nested `Foo(...)` call in a method body resolve. */
export function stateCtx(opts: {
  stateNames: ReadonlySet<string>;
  derivedNames: ReadonlySet<string>;
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>;
  locals: ReadonlyMap<string, string>;
  paramNames?: ReadonlySet<string>;
  apiParamNames?: ReadonlyMap<string, string>;
  userComponents?: ReadonlyMap<string, readonly ParamIR[]>;
}): WalkContext {
  const { stateNames, derivedNames, aggregatesByName, locals } = opts;
  return {
    target: flutterTarget,
    imports: new Map(),
    pack: flutterPack(),
    paramNames: new Set<string>(opts.paramNames ?? []),
    stateNames: new Set(stateNames),
    derivedNames: new Set(derivedNames),
    authUi: false,
    usedParams: new Set(),
    usesNavigate: false,
    usesTableSort: false,
    usesTableFilter: false,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
    userComponents: new Map(opts.userComponents ?? []),
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames: new Map(opts.apiParamNames ?? []),
    usedApiHooks: new Map(),
    lambdaParams: locals,
    shellLocals: new Set(),
    aggregatesByName,
    bcByAggregate: new Map(),
    workflowsByName: new Map(),
    bcByWorkflow: new Map(),
    formOfs: [],
    sink: {},
    actionMutations: [],
    collectedTestids: new Set(),
    usesCodeBlock: false,
    usesFileUpload: false,
    usesFragment: false,
    externFunctions: new Set(),
    usedExternFunctions: new Set(),
    usedActions: new Set(),
    usedStores: new Map(),
  };
}

/** Render one action-body statement into a Notifier-method line.  A state write
 *  becomes `state = state.copyWith(field: <value>)`; a sibling-action call is a
 *  bare in-class method invocation.  The RHS routes through `emitExpr`, so a
 *  `count` read resolves through the state seam to `state.count`. */
export function renderNotifierStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      const seg = stmt.target.segments;
      const root = seg[0]!;
      const value = emitExpr(stmt.value, ctx);
      if (seg.length === 1) {
        return `state = state.copyWith(${root}: ${value});`;
      }
      // Nested immutable rebuild (`order.shipping.zip := v`) needs a per-level
      // copyWith down the wire-model chain — deferred.
      return `// TODO(flutter full-parity): nested state write ${seg.join(".")} := ${value}`;
    }
    case "add":
    case "remove": {
      const seg = stmt.target.segments;
      const root = seg[0]!;
      if (seg.length !== 1) {
        return `// TODO(flutter full-parity): nested compound write on ${seg.join(".")}`;
      }
      const rhs = emitExpr(stmt.value, ctx);
      const cur = `state.${root}`;
      // A collection target appends / removes-by-value on the Dart list; a scalar
      // target is an arithmetic compound (`+`/`-`).  `stmt.collection` (set at
      // lowering) is the discriminator — the same flag the JS/F# frontends read.
      const value = stmt.collection
        ? stmt.kind === "add"
          ? `[...${cur}, ${rhs}]`
          : `${cur}.where((__v) => __v != ${rhs}).toList()`
        : `${cur} ${stmt.kind === "add" ? "+" : "-"} ${rhs}`;
      return `state = state.copyWith(${root}: ${value});`;
    }
    case "let":
      return `final ${stmt.name} = ${emitExpr(stmt.expr, ctx)};`;
    case "expression":
      return `${emitExpr(stmt.expr, ctx)};`;
    case "call": {
      // A sibling page action (`target: "action"`) is another Notifier method —
      // an in-class bare call re-enters the update path.  Extern ui functions
      // render the same bare form (the app supplies the binding).  Store /
      // private-operation calls are full-parity follow-ups.
      if (stmt.target === "store-action" || stmt.target === "private-operation") {
        return `// TODO(flutter full-parity): '${stmt.target}' call '${stmt.name}' in a Notifier method`;
      }
      const args = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${stmt.name}(${args});`;
    }
    default:
      // `variant-match` (async effect) + backend-only kinds — deferred, but never
      // silently dropped (a visible TODO in the emitted Dart).
      return `// TODO(flutter full-parity): unsupported action statement '${stmt.kind}'`;
  }
}

/** Render a `match await <api>.<Agg>.<op>(args) { … }` async effect into an async
 *  Notifier-method body.  Mirrors the JS-family shape (`renderJsVariantMatch`)
 *  but in Dart: POST the instance-op to `/<coll>/$id/<op>`, reify a non-2xx
 *  ProblemDetails body back into the error variant (clobbering `type` to the
 *  variant tag), then a Dart-3 `switch` over the wire `type` discriminator that
 *  reifies each arm's variant via its `fromJson` and runs the arm body (state
 *  writes through the same `renderNotifierStmt`, so `message := o.code` becomes
 *  `state = state.copyWith(...)`).  Returns the method body lines (indented by
 *  the caller). */
function renderVariantMatchNotifier(
  stmt: Extract<StmtIR, { kind: "variant-match" }>,
  ctx: WalkContext,
  contexts: readonly EnrichedBoundedContextIR[],
): string[] {
  const detected = tryDetectApiHook(stmt.subject, {
    apiParamNames: ctx.apiParamNames,
    aggregatesByName: ctx.aggregatesByName,
    workflowsByName: ctx.workflowsByName,
  });
  const agg = detected ? ctx.aggregatesByName.get(detected.aggregateName) : undefined;
  const op = agg?.operations.find((o) => o.name === detected?.operation);
  if (!detected || !agg || !op) {
    return ["// TODO(flutter full-parity): `match await` subject is not a resolvable remote op"];
  }
  const bc = contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
  const coll = snake(plural(agg.name));
  const opPath = snake(op.routeSlug ?? op.name);
  // Request payload — the op's params filled from the awaited call's positional
  // args (matching the op signature; validated upstream by loom.match-await-*).
  const bodyEntries = op.params.map(
    (p, i) =>
      `${dartString(p.name)}: ${detected.args[i] ? emitExpr(detected.args[i]!, ctx) : "null"}`,
  );
  const bodyMap = `<String, dynamic>{${bodyEntries.join(", ")}}`;

  // Classify each arm: an error variant reaches the client as a non-2xx
  // ProblemDetails; the payload classification is authoritative, the lowered
  // `isError` hint is the OR-fallback (its UI-body lowering can't see the context).
  const arms = stmt.arms.map((arm) => {
    const tag = variantTag(arm.varType);
    const isError =
      arm.isError === true || !!bc?.payloads.some((p) => p.name === tag && p.kind === "error");
    const armCtx: WalkContext = arm.binding
      ? { ...ctx, lambdaParams: new Map([...ctx.lambdaParams, [arm.binding, arm.binding]]) }
      : ctx;
    const body = arm.body.map((s) => renderNotifierStmt(s, armCtx));
    return { tag, binding: arm.binding, body, isError };
  });
  const errorVariants = arms
    .filter((a) => a.isError)
    .map((a) => ({ tag: a.tag, uri: errorTypeUri(a.tag) }));

  const out: string[] = ["Map<String, dynamic> result;", "try {"];
  out.push(
    `  final res = await http.post(apiUri('/${coll}/\${id}/${opPath}'),`,
    "      headers: const {'Content-Type': 'application/json'},",
    `      body: jsonEncode(${bodyMap}));`,
    "  final decoded = jsonDecode(res.body) as Map<String, dynamic>;",
    "  if (res.statusCode >= 200 && res.statusCode < 300) {",
    "    result = decoded;",
  );
  if (errorVariants.length === 1) {
    // Single error variant — re-stamp its known tag (the wire `type` was
    // clobbered to the ProblemDetails URI, but the fields survive).
    out.push(
      "  } else {",
      `    result = {...decoded, 'type': ${dartString(errorVariants[0]!.tag)}};`,
      "  }",
    );
  } else if (errorVariants.length > 1) {
    // Multi-error — map the caught ProblemDetails `type` URI back to the tag.
    const chain =
      errorVariants
        .slice(0, -1)
        .map((v) => `decoded['type'] == ${dartString(v.uri)} ? ${dartString(v.tag)}`)
        .join(" : ") + ` : ${dartString(errorVariants[errorVariants.length - 1]!.tag)}`;
    out.push("  } else {", `    result = {...decoded, 'type': ${chain}};`, "  }");
  } else {
    // No error variant declared — a non-2xx has no arm to route to; keep the
    // decoded body (its `type`, if any, falls through the switch).
    out.push("  } else {", "    result = decoded;", "  }");
  }
  out.push(
    "} catch (_) {",
    "  return; // network / decode failure — abort the effect (no arm runs)",
    "}",
    "switch (result['type']) {",
  );
  for (const arm of arms) {
    out.push(`  case ${dartString(arm.tag)}:`, "    {");
    if (arm.binding) out.push(`      final ${arm.binding} = ${arm.tag}.fromJson(result);`);
    for (const b of arm.body) out.push(`      ${b}`);
    out.push("    }");
  }
  if (stmt.elseBody) {
    const elseCtx = ctx;
    out.push("  default:", "    {");
    for (const s of stmt.elseBody) out.push(`      ${renderNotifierStmt(s, elseCtx)}`);
    out.push("    }");
  }
  out.push("}");
  return out;
}

/** One projected state cell — the shape both the immutable state/model data
 *  class and the Notifier / `setState` write paths consume. */
export interface DartStateField {
  name: string;
  /** Dart field type (`int`, `String?`). */
  dt: string;
  nullable: boolean;
  /** copyWith parameter type — always the nullable form (an omitted arg keeps
   *  `this`). */
  paramType: string;
  init?: ExprIR;
  type: TypeIR;
}

/** Project a `state {}` block into the per-cell Dart field descriptors. */
export function buildStateFields(state: readonly StateFieldIR[]): DartStateField[] {
  return state.map((f) => {
    const dt = dartType(f.type);
    const nullable = dt.endsWith("?");
    return {
      name: f.name,
      dt,
      nullable,
      // copyWith always takes the nullable form (an omitted arg keeps `this`).
      paramType: nullable ? dt : `${dt}?`,
      init: f.init,
      type: f.type,
    };
  });
}

/** Emit an immutable Dart data class (`const` ctor, `final` fields, `copyWith`)
 *  for a set of state cells — the `<Page>State` a Riverpod page's Notifier holds
 *  AND the `<Component>Model` a stateful component's `State` holds. */
export function renderStateDataClass(
  className: string,
  fields: readonly DartStateField[],
): string[] {
  const ctorParams = fields
    .map((f) => (f.nullable ? `this.${f.name}` : `required this.${f.name}`))
    .join(", ");
  const out: string[] = [
    `class ${className} {`,
    `  const ${className}(${ctorParams ? `{${ctorParams}}` : ""});`,
    ...fields.map((f) => `  final ${f.dt} ${f.name};`),
  ];
  if (fields.length > 0) {
    out.push("");
    out.push(
      `  ${className} copyWith({${fields.map((f) => `${f.paramType} ${f.name}`).join(", ")}}) {`,
    );
    out.push(
      `    return ${className}(${fields.map((f) => `${f.name}: ${f.name} ?? this.${f.name}`).join(", ")});`,
    );
    out.push("  }");
  }
  out.push("}");
  return out;
}

/** Build the `<name>: <init>` entries a state/model constructor call takes —
 *  each `init` through the shared expr layer, else the type's zero value — plus
 *  whether a `const` construction is valid (every init a compile-time literal). */
export function buildStateInits(
  fields: readonly DartStateField[],
  ctx: WalkContext,
): { entries: string[]; constEligible: boolean } {
  const entries = fields.map((f) =>
    f.init ? `${f.name}: ${emitExpr(f.init, ctx)}` : `${f.name}: ${dartZeroValue(f.type)}`,
  );
  const constEligible = fields.every((f) => !f.init || f.init.kind === "literal");
  return { entries, constEligible };
}

/** Aggregate-name lookup over a set of contexts (used to seed a `stateCtx`). */
function aggregateIndex(
  contexts: readonly EnrichedBoundedContextIR[],
): ReadonlyMap<string, EnrichedAggregateIR> {
  return new Map(contexts.flatMap((c) => c.aggregates.map((a) => [a.name, a] as const)));
}

/** Project a stateful page into its `<Page>State` / `<Page>Notifier` /
 *  `<page>Provider` Dart triad. */
export function renderRiverpod(
  page: PageIR,
  contexts: readonly EnrichedBoundedContextIR[],
  apiParamNames: ReadonlyMap<string, string> = new Map(),
): RiverpodProjection {
  const stateClass = `${upperFirst(page.name)}State`;
  const notifierClass = `${upperFirst(page.name)}Notifier`;
  const providerName = `${lowerFirst(page.name)}Provider`;

  const aggregatesByName = aggregateIndex(contexts);
  const stateNames = new Set(page.state.map((s) => s.name));
  const derivedNames = new Set(page.derived.map((d) => d.name));
  const fields = buildStateFields(page.state);

  // --- State data class -----------------------------------------------------
  const stateLines = renderStateDataClass(stateClass, fields);

  // --- Notifier -------------------------------------------------------------
  const initCtx = stateCtx({ stateNames, derivedNames, aggregatesByName, locals: new Map() });
  const { entries: buildInits, constEligible } = buildStateInits(fields, initCtx);
  const buildReturn =
    fields.length > 0
      ? `${constEligible ? "const " : ""}${stateClass}(${buildInits.join(", ")})`
      : `const ${stateClass}()`;

  const notifierLines: string[] = [
    `class ${notifierClass} extends Notifier<${stateClass}> {`,
    "  @override",
    `  ${stateClass} build() {`,
    `    return ${buildReturn};`,
    "  }",
  ];
  const asyncEffectActions = new Set<string>();
  for (const action of page.actions) {
    const param = action.params[0];
    const locals = new Map<string, string>();
    if (param) locals.set(param.name, param.name);
    const ctx = stateCtx({ stateNames, derivedNames, aggregatesByName, locals, apiParamNames });
    const isAsync = actionHasAsyncEffect(action);
    // An async-effect action's op is instance-scoped, so its method takes the
    // route `id` (a leading param the page-shell closure supplies) and is
    // `Future<void> … async`.  Its `variant-match` body renders the await/reify/
    // switch; any sibling statements render as normal Notifier lines.
    const body = action.body.flatMap((s) =>
      s.kind === "variant-match"
        ? renderVariantMatchNotifier(s, ctx, contexts)
        : [renderNotifierStmt(s, ctx)],
    );
    if (isAsync) asyncEffectActions.add(action.name);
    const idParam = isAsync ? "String id" : "";
    const actionParam = param ? `${dartType(param.type)} ${param.name}` : "";
    const paramList = [idParam, actionParam].filter(Boolean).join(", ");
    const sig = isAsync
      ? `Future<void> ${action.name}(${paramList}) async`
      : `void ${action.name}(${paramList})`;
    notifierLines.push("");
    notifierLines.push(`  ${sig} {`);
    for (const b of body) notifierLines.push(`    ${b}`);
    notifierLines.push("  }");
  }
  notifierLines.push("}");

  const providerLine = `final ${providerName} = NotifierProvider<${notifierClass}, ${stateClass}>(${notifierClass}.new);`;

  const source = [...stateLines, "", ...notifierLines, "", providerLine].join("\n");
  return { providerName, stateClass, notifierClass, source, asyncEffectActions };
}
