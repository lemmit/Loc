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

import type { EnrichedBoundedContextIR, PageIR, StmtIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, upperFirst } from "../../util/naming.js";
import { emitExpr, type WalkContext } from "../_walker/walker-core.js";
import { dartZeroValue } from "./dart-expr.js";
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
}

/** True when a page carries reactive state and/or named actions — the trigger
 *  for the `ConsumerWidget` + Riverpod projection path (the display-only pages
 *  stay plain `StatelessWidget`s). */
export function hasRiverpodState(page: PageIR): boolean {
  return page.state.length > 0 || page.actions.length > 0;
}

/** Build a minimal `WalkContext` for rendering a Notifier method body / state
 *  init through the shared `emitExpr` (so RHS reads dereference the projected
 *  `state`).  `locals` binds the action's single payload param so a body ref to
 *  it resolves to the bare Dart identifier. */
function notifierCtx(
  page: PageIR,
  contexts: readonly EnrichedBoundedContextIR[],
  locals: ReadonlyMap<string, string>,
): WalkContext {
  const stateNames = new Set(page.state.map((s) => s.name));
  const derivedNames = new Set(page.derived.map((d) => d.name));
  const aggregatesByName = new Map(
    contexts.flatMap((c) => c.aggregates.map((a) => [a.name, a] as const)),
  );
  return {
    target: flutterTarget,
    imports: new Map(),
    pack: flutterPack(),
    paramNames: new Set<string>(),
    stateNames,
    derivedNames,
    authUi: false,
    usedParams: new Set(),
    usesNavigate: false,
    usesTableSort: false,
    usesTableFilter: false,
    usesState: false,
    usesCurrentUser: false,
    usesRouterLink: false,
    usesRouteId: false,
    userComponents: new Map(),
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames: new Map(),
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
function renderNotifierStmt(stmt: StmtIR, ctx: WalkContext): string {
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

/** Project a stateful page into its `<Page>State` / `<Page>Notifier` /
 *  `<page>Provider` Dart triad. */
export function renderRiverpod(
  page: PageIR,
  contexts: readonly EnrichedBoundedContextIR[],
): RiverpodProjection {
  const stateClass = `${upperFirst(page.name)}State`;
  const notifierClass = `${upperFirst(page.name)}Notifier`;
  const providerName = `${lowerFirst(page.name)}Provider`;

  const fields = page.state.map((f) => {
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

  // --- State data class -----------------------------------------------------
  const ctorParams = fields
    .map((f) => (f.nullable ? `this.${f.name}` : `required this.${f.name}`))
    .join(", ");
  const stateLines: string[] = [
    `class ${stateClass} {`,
    `  const ${stateClass}(${ctorParams ? `{${ctorParams}}` : ""});`,
    ...fields.map((f) => `  final ${f.dt} ${f.name};`),
  ];
  if (fields.length > 0) {
    stateLines.push("");
    stateLines.push(
      `  ${stateClass} copyWith({${fields.map((f) => `${f.paramType} ${f.name}`).join(", ")}}) {`,
    );
    stateLines.push(
      `    return ${stateClass}(${fields.map((f) => `${f.name}: ${f.name} ?? this.${f.name}`).join(", ")});`,
    );
    stateLines.push("  }");
  }
  stateLines.push("}");

  // --- Notifier -------------------------------------------------------------
  const buildInits = fields.map((f) => {
    const v = f.init
      ? emitExpr(f.init, notifierCtx(page, contexts, new Map()))
      : dartZeroValue(f.type);
    return `${f.name}: ${v}`;
  });
  // A `const` initial state is valid only when every init is a compile-time
  // literal (the zero-value fallbacks always are); a computed init drops it.
  const constEligible = fields.every((f) => !f.init || f.init.kind === "literal");
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
  for (const action of page.actions) {
    const param = action.params[0];
    const locals = new Map<string, string>();
    if (param) locals.set(param.name, param.name);
    const ctx = notifierCtx(page, contexts, locals);
    const body = action.body.map((s) => renderNotifierStmt(s, ctx));
    const sig = param
      ? `void ${action.name}(${dartType(param.type)} ${param.name})`
      : `void ${action.name}()`;
    notifierLines.push("");
    notifierLines.push(`  ${sig} {`);
    for (const b of body) notifierLines.push(`    ${b}`);
    notifierLines.push("  }");
  }
  notifierLines.push("}");

  const providerLine = `final ${providerName} = NotifierProvider<${notifierClass}, ${stateClass}>(${notifierClass}.new);`;

  const source = [...stateLines, "", ...notifierLines, "", providerLine].join("\n");
  return { providerName, stateClass, notifierClass, source };
}
