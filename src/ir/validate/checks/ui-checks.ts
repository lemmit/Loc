// -------------------------------------------------------------------------
// UI body checks (Bucket V / F1, F2, F3) — page / component body shapes the
// walker renders as a silent-wrong placeholder.  Each fires on the
// fully-resolved page/component body `ExprIR`, so the matching walker
// sentinels become unreachable from valid input.
//
//   F1 — `Action(<inst>.<op>)` renders `mutateAsync({})`, dropping any
//        operation parameters (`src/generator/_walker/primitives/controls.ts`).
//        Reject an `Action` whose resolved operation takes parameters; the
//        author should use `OperationForm(of:, op:)`, which renders the
//        parameter inputs.
//
//   F2 — a method-call whose receiver doesn't resolve to a param / state /
//        let / lambda binding / ui api-handle / form shell-local renders as
//        `/* TODO: method-call … needs hooks {} binding */ undefined`
//        (`src/generator/_walker/walker-core.ts`).  Reject the unresolved
//        receiver so the sentinel can't be reached.
//
//   F4 — a free CALL in a render-tree position that resolves to nothing the
//        walker can render.  In LAYOUT position it emits a visible
//        `unknown layout component` comment; in a user-visible TEXT SLOT it
//        emits NOTHING AT ALL — a typo'd name silently deletes the content.
//        `loom.unknown-page-element`.
//
//   F3 — a stdlib COLLECTION OP on a collection receiver
//        (`rows.count`, `rows.where(λ)`, `rows.sum(λ)`) renders VERBATIM.
//        `loom.frontend-collection-op-unsupported`; see the block above
//        `checkFrontendCollectionOps` for the emitter evidence.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { isCollectionOp } from "../../../util/collection-ops.js";
import {
  isWalkerPrimitive,
  WALKER_PRIMITIVE_SLOTS,
  WALKER_SUB_PRIMITIVE_PARENTS,
} from "../../../util/walker-primitive-names.js";
import { pagedReturn } from "../../stdlib/generics.js";
import type {
  ActionIR,
  AggregateIR,
  ComponentIR,
  DerivedIR,
  EnrichedLoomModel,
  ExprIR,
  FindIR,
  PageIR,
  ProjectionIR,
  StateFieldIR,
  StmtIR,
  StoreIR,
  TypeIR,
  UiIR,
} from "../../types/loom-ir.js";
import { allAggregates, allContexts } from "../../types/loom-ir.js";
import { classifyPage, pageSlotKey } from "../../util/page-kind.js";
import { groupedProjectionNames, readableProjectionNames } from "../../util/projection-read.js";
import { typeLabel } from "../../util/type-label.js";
import {
  walkExprChildren,
  walkExprDeep,
  walkStmtChildren,
  walkStmtExprsDeep,
} from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// View-effect builtins (`navigate(…)`, `toast(…)`) lower to bare
// `private-operation`-shaped calls but resolve against the page's imports at
// emit time (`src/generator/_walker/primitives/controls.ts`,
// `elixir/heex-walker-core.ts`), so an action body calling one is legitimate —
// the unresolved-action-ref check must NOT flag them.
const VIEW_EFFECT_BUILTINS = new Set<string>(["navigate", "toast"]);

/** Form primitives that introduce a mutation shell-local into their
 *  `onSubmit:` lambda.  The walker binds these names so the body may
 *  reference them as method-call receivers (`onSubmit: v =>
 *  create.mutateAsync(v)`); we must admit the same names. */
const FORM_SHELL_LOCALS: Record<string, readonly string[]> = {
  CreateForm: ["create", "register", "handleSubmit", "control", "errors"],
  Form: ["create", "register", "handleSubmit", "control", "errors"],
  WorkflowForm: ["run", "register", "handleSubmit", "control", "errors"],
  OperationForm: ["create", "run", "register", "handleSubmit", "control", "errors"],
};

export function validateUiBodies(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const aggByName = new Map<string, AggregateIR>();
  for (const a of allAggregates(loom)) aggByName.set(a.name, a);
  // The api-hook detector (`tryDetectApiHook`, patterns A–G) resolves a
  // method-call receiver rooted at a declared aggregate / workflow name, or
  // the magic `Views` handle — even with no `api X: Y` binding.  Mirror that
  // acceptance so F2 only flags receivers the walker truly can't resolve.
  const aggNames = new Set<string>();
  const workflowNames = new Set<string>();
  // Projection names drive F3 (`loom.ui-projection-read-unsupported`): every
  // declared projection is a candidate, and the READABLE subset (unkeyed
  // query-time — singleton or grouped) is subtracted below, leaving the
  // flavours with no frontend client (keyed, folded) to be rejected.
  const projectionNames = new Set<string>();
  for (const c of allContexts(loom)) {
    for (const a of c.aggregates) aggNames.add(a.name);
    for (const w of c.workflows) workflowNames.add(w.name);
    for (const p of c.projections) projectionNames.add(p.name);
  }
  const readableProjections = readableProjectionNames(allContexts(loom));
  // The `Chart` arg gates need the GROUPED subset plus each projection's
  // resolved row shape (`wireShape`) to validate the accessor lambdas against.
  const groupedReadable = groupedProjectionNames(allContexts(loom));
  const projectionsByIrName = new Map<string, ProjectionIR>();
  for (const c of allContexts(loom)) {
    for (const p of c.projections) projectionsByIrName.set(p.name, p);
  }
  // aggregate → its repository's finds by name.  The Angular component gate
  // reads it to tell a REACTIVE query (a user `find`, or a paged `all`, whose
  // args the query re-reads lazily) from a plain hoisted read — the same
  // distinction `adjustFindHookArgs` makes in the walker.
  const findsByAggregate = new Map<string, Map<string, FindIR>>();
  for (const c of allContexts(loom)) {
    for (const r of c.repositories) {
      const m = findsByAggregate.get(r.aggregateName) ?? new Map<string, FindIR>();
      for (const f of r.finds) m.set(f.name, f);
      findsByAggregate.set(r.aggregateName, m);
    }
  }

  for (const sys of loom.systems) {
    // Frontends whose COMPONENT emitter filters its emitted set (feliz /
    // angular), per mounted ui.  The framework is resolved per-ui —
    // `ui.framework` wins, then the deployable's platform-derived
    // `uiFramework` — because a static-bundle host serves whichever bundle the
    // ui declares (`mountedUis` in system-checks.ts uses the same resolution).
    // Deduped per framework: two deployables serving the same bundle are one
    // gap, not two diagnostics.
    const filteringHosts = new Map<string, Map<string, string>>();
    for (const d of sys.deployables) {
      for (const uiName of [d.uiName, ...(d.hostedUiNames ?? [])]) {
        if (!uiName) continue;
        const fw = sys.uis.find((u) => u.name === uiName)?.framework ?? d.uiFramework;
        if (!fw || !COMPONENT_FILTERING_FRAMEWORKS.has(fw)) continue;
        const byFw = filteringHosts.get(uiName) ?? new Map<string, string>();
        if (!byFw.has(fw)) byFw.set(fw, d.name);
        filteringHosts.set(uiName, byFw);
      }
    }
    // EVERY framework each ui is actually rendered through — the same per-ui
    // resolution as `filteringHosts`, unfiltered.  The per-target body gates
    // below (`loom.table-filter-unsupported`,
    // `loom.modal-controlled-op-form-unsupported`) need it because a
    // static-bundle host serves whichever bundle the ui declares, so the
    // framework that renders a page is not the deployable's platform.
    const renderingHosts = new Map<string, Map<string, string>>();
    for (const d of sys.deployables) {
      for (const uiName of [d.uiName, ...(d.hostedUiNames ?? [])]) {
        if (!uiName) continue;
        const fw = sys.uis.find((u) => u.name === uiName)?.framework ?? d.uiFramework;
        if (!fw) continue;
        const byFw = renderingHosts.get(uiName) ?? new Map<string, string>();
        if (!byFw.has(fw)) byFw.set(fw, d.name);
        renderingHosts.set(uiName, byFw);
      }
    }
    // Which uis this system renders through Feliz — the one frontend whose
    // walker cannot render `.map(λ)` (see `MAP_UNRENDERED_FRAMEWORK`).  A ui
    // declares its own `framework:`, but the LEGACY binding leaves it unset and
    // derives the framework from the hosting deployable, so both are consulted
    // (`platform: feliz` hosts only `framework: feliz` — the same detector
    // `loom.feliz-async-effect-unsupported` uses in store-checks.ts).
    const felizUis = new Set<string>();
    for (const d of sys.deployables) {
      if (d.platform !== MAP_UNRENDERED_FRAMEWORK && d.uiFramework !== MAP_UNRENDERED_FRAMEWORK)
        continue;
      for (const n of [d.uiName, ...(d.hostedUiNames ?? [])]) if (n) felizUis.add(n);
    }
    for (const ui of sys.uis) {
      const mapRendered = ui.framework !== MAP_UNRENDERED_FRAMEWORK && !felizUis.has(ui.name);
      const handles = new Set<string>([
        ...ui.apiParams.map((p) => p.name),
        ...(ui.channelParams ?? []).map((p) => p.name),
        ...aggNames,
        ...workflowNames,
        "Views",
      ]);
      // UI extern-function names (`function f(…) extern from "…"`) — a bare
      // call to one in an action body lowers to a `private-operation` (no UI
      // function is in `findFunctionInEnv`), so the unresolved-action-ref check
      // must NOT flag it (extern-function-hook-escape-hatch.md).
      const functionNames = new Set<string>((ui.functions ?? []).map((f) => f.name));
      // Component name → its `action`-typed param names — the extern-component
      // Tier 2 behaviour-callback slots, exempt from the lambda-purity check.
      const componentActionParams = new Map<string, ReadonlySet<string>>();
      for (const comp of ui.components) {
        const slots = new Set<string>(
          comp.params.filter((p) => p.type.kind === "action").map((p) => p.name),
        );
        if (slots.size > 0) componentActionParams.set(comp.name, slots);
      }
      const apiParamNames = new Set(ui.apiParams.map((p) => p.name));
      // F4 — the names a render-tree free call may carry, mirroring what the
      // walker resolves at emit time (registry primitive → user component →
      // value-object construction → extern function).
      // Components resolve from TWO scopes, and the gate must mirror both or a
      // shipped example fails on a name the walker resolves fine: the ui-local
      // `component`s, PLUS the ROOT-level ones declared outside any `ui { … }`,
      // which are ambient workspace-wide (`LoomModel.components`, the same
      // global symbol space as `rootValueObjects`).
      const callableNames: CallableNames = {
        components: new Set([...loom.components, ...ui.components].map((c) => c.name)),
        valueObjects: new Set(allContexts(loom).flatMap((c) => c.valueObjects.map((v) => v.name))),
        functions: new Set((ui.functions ?? []).map((f) => f.name)),
      };
      for (const page of ui.pages) {
        const actionsByName = new Map(page.actions.map((a) => [a.name, a]));
        const ctx: BodyCheckCtx = {
          aggByName,
          projectionNames,
          readableProjections,
          handles,
          functionNames,
          componentActionParams,
          exemptLambdas: new Set(),
          scope: new Set(),
          where: pageWhere(page),
          actionsByName,
        };
        checkBody(page.body, ctx, diags);
        checkBody(page.title, ctx, diags);
        checkBody(page.requires, ctx, diags);
        checkActionBodies(page.actions, ctx, diags);
        checkInstanceEffectRouteId(page, aggNames, apiParamNames, diags);
        checkFrontendCollectionOps(page, pageWhere(page), mapRendered, diags);
        checkUnknownPageElements(page, pageWhere(page), callableNames, diags);
        checkSlotOutsideComponent(page, pageWhere(page), diags);
        checkUnresolvedPageRefs(page, pageWhere(page), callableNames, diags);
        checkFixedSlotArity(page, pageWhere(page), diags);
        checkSubPrimitivePlacement(page, pageWhere(page), diags);
        checkDataGridSelection(page.body, page.state, pageWhere(page), diags);
        // The `of:` receiver must be an API HANDLE — the walker's Pattern H
        // (`<apiHandle>.<Projection>`) is the only shape that hoists the
        // projection hook, so the gate accepts exactly what resolves.
        checkChartArgs(
          page.body,
          apiParamNames,
          groupedReadable,
          projectionsByIrName,
          pageWhere(page),
          diags,
        );
        checkAsyncEffectArgs(
          pageWhere(page),
          page.actions,
          aggByName,
          apiParamNames,
          aggNames,
          diags,
        );
      }
      for (const comp of ui.components) {
        const actionsByName = new Map(comp.actions.map((a) => [a.name, a]));
        const ctx: BodyCheckCtx = {
          aggByName,
          projectionNames,
          readableProjections,
          handles,
          functionNames,
          componentActionParams,
          exemptLambdas: new Set(),
          scope: new Set(),
          where: `component '${comp.name}'`,
          actionsByName,
        };
        checkBody(comp.body, ctx, diags);
        checkActionBodies(comp.actions, ctx, diags);
        checkFrontendCollectionOps(comp, `component '${comp.name}'`, mapRendered, diags);
        checkUnknownPageElements(comp, `component '${comp.name}'`, callableNames, diags);
        checkUnresolvedPageRefs(comp, `component '${comp.name}'`, callableNames, diags);
        checkFixedSlotArity(comp, `component '${comp.name}'`, diags);
        checkSubPrimitivePlacement(comp, `component '${comp.name}'`, diags);
        checkDataGridSelection(comp.body, comp.state, `component '${comp.name}'`, diags);
        checkChartArgs(
          comp.body,
          apiParamNames,
          groupedReadable,
          projectionsByIrName,
          `component '${comp.name}'`,
          diags,
        );
        checkAsyncEffectArgs(
          `component '${comp.name}'`,
          comp.actions,
          aggByName,
          apiParamNames,
          aggNames,
          diags,
        );
      }
      // A `store`'s state initialisers and action bodies are the THIRD frontend
      // expression surface.  A store action is emitted by each frontend's own
      // store builder (`react`'s
      // zustand slice, `flutter/store-builder.ts`'s Riverpod notifier, the Feliz
      // Elmish `update` arm), and none of them renders a collection op either:
      // `action tidy() { tags := tags.distinct() }` CRASHES the Feliz emitter
      // (`feliz/fs-expr.ts` has no leaf for it) and emits uncompilable Dart
      // (`state.tags.distinct()`) on Flutter — from a `.ddd` that validated
      // clean.  Same vocabulary gap, same gate.
      for (const store of ui.stores) {
        checkFrontendCollectionOps(store, `store '${store.name}'`, mapRendered, diags);
      }
      // A `toast(<expr>)` outside the v1 message subset CRASHES every realtime
      // renderer (target-agnostic — the three switches are arm-for-arm equal).
      checkToastMessages(ui, diags);
      // Two per-target body shapes that render on SOME frontends and are
      // dropped on the rest.  Both are keyed on the rendering framework, so the
      // gate stops firing for a target the moment it ports.
      for (const [framework, dName] of renderingHosts.get(ui.name) ?? []) {
        for (const page of ui.pages) {
          checkTableFilterSupport(page, pageWhere(page), framework, dName, diags);
          checkControlledModalOpForm(page, pageWhere(page), framework, dName, diags);
        }
        for (const comp of ui.components) {
          const where = `component '${comp.name}'`;
          checkTableFilterSupport(comp, where, framework, dName, diags);
          checkControlledModalOpForm(comp, where, framework, dName, diags);
        }
      }
      // A user `component` whose shape the hosting frontend's component emitter
      // FILTERS OUT — the component and every call site of it vanish.
      for (const [framework, dName] of filteringHosts.get(ui.name) ?? []) {
        checkUserComponentSupport(
          ui,
          framework,
          dName,
          { aggByName, apiParamNames, aggNames, findsByAggregate },
          diags,
        );
      }
    }
  }
}

// -------------------------------------------------------------------------
// `loom.instance-effect-needs-route-id` (M-T6.17) — a page action whose body
// awaits an aggregate INSTANCE operation (`match await <api>.<Agg>.<op>(…)`)
// acts on the record identified by the page's route `:id`.  On a paramless page
// there is no record in scope, so the effect is user error on EVERY frontend:
// the Feliz generator gates it, and the JS frontends (React/Vue/Svelte/Angular)
// synthesize a `useParams` `id` and POST an empty-id (`id ?? ""`) request — a
// broken call.  This TARGET-AGNOSTIC check rejects it uniformly so a `.ddd`
// generates working code on every target, or fails validation on every target.
// (Workflows / non-aggregate subjects aren't record-scoped, so they're skipped.)
// -------------------------------------------------------------------------

/** True when a page `route:` binds a `:param` segment (`/orders/:id`). */
function pageRouteHasParam(route: string | undefined): boolean {
  return (route ?? "/").split("/").some((s) => s.startsWith(":"));
}

// -------------------------------------------------------------------------
// F3 — `loom.frontend-collection-op-unsupported` (M-T1.3 Defect A).
//
// The stdlib collection ops (`src/util/collection-ops.ts`: count / sum / where
// / any / all / first / sortBy / distinct / take / skip / min / max / avg /
// join / contains / firstOrNull) are a BACKEND vocabulary.  Every backend has a
// real renderer for them (`src/generator/_expr/target.ts`'s `isCollectionOp`
// arm, one leaf table per backend); the frontend walker has NONE.  The shared
// `walker-core.ts` `member` arm emits `<recv>.<member>` and its `method-call`
// arm emits `<recv>.<member>(<args>)` — verbatim, in whatever language the
// target embeds.  Measured on `QueryView { of: X.all, data: rows => Stat(…) }`:
//
//   react/vue/svelte/angular  `rows.count` → `items.count`               TS2339
//   feliz                     `rows.count` → `allCustomers.count`        not F#
//   flutter                   `rows.count` → `customerAll.count`         not Dart
//   phoenixLiveView           `rows.count` → `Enum.count(@items)`        ✓
//
// So the failure lands at `tsc` / `ng build` / `dotnet fable` / `flutter
// analyze` — a generated project that doesn't compile, from a `.ddd` that
// validated clean.  Phoenix is the lone exception because HEEx runs a PARALLEL
// walker (`elixir/heex-walker-core.ts`'s `renderCollectionOp`) — and even there
// `join` (`Enum.map(…).join(", ")`) and `first` (`@items.first`) are invalid
// Elixir, so it is not a portable escape hatch either.
//
// The fix is the GATE, not renderers: mapping 17 ops × 6 frontends would add a
// second expression dialect to the frontend walkers, and the server-side read
// path (a repository `find`, or a `projection` read model) already computes
// these correctly, once, in the database.  So this check is TARGET-AGNOSTIC —
// same reasoning as `loom.instance-effect-needs-route-id` above: a `.ddd`
// generates working code on every target, or fails validation on every target.
//
// TWO exemptions, both grounded in a real renderer:
//
//   • `map` — the ONE op with a genuine frontend renderer on both engines:
//     native `Array.prototype.map` on the JS frontends and `Enum.map/2` on HEEx
//     (DEBT-31, `test/generator/elixir/heex-collection-ops.test.ts`).  Shipped
//     behaviour; not gated.
//   • `page { requires … }` — a gate expression is NOT walked by walker-core.
//     It goes through the closed `src/generator/_frontend/gate-expr.ts`
//     renderer, whose one admitted method IS a collection op
//     (`currentUser.permissions.contains(x)` → `.includes(x)`).  Gate
//     expressions are therefore excluded from this walk entirely.
//
// Detection needs a COLLECTION receiver, not just a catalogue NAME — lowering
// sets `isCollectionOp` from the member name alone (`lower-expr.ts`), so a
// scaffolded repository read `Sales.Customer.all` carries the catalogue name
// too (158 such reads across the repo's `.ddd` corpus, every one of them
// legitimate).  A collection receiver is recognised two ways, because page
// bodies mix TYPED and UNTYPED bindings:
//
//   • a `TypeIR` that IS a collection — `array`, or `optional<array>`.  Covers
//     `state { xs: string[] }`, a typed `derived`, a list literal, an
//     aggregate's `Line[]` field, and any chained result lowering types as an
//     array (`rows.map(…).count`).
//   • a bare ref to a lambda param the page DSL binds to a query's ROW SET —
//     `QueryView { of: X.all, data: rows => … }`.  The `data:` lambda param
//     carries no `TypeIR` (lowering leaves UI primitive lambda params at the
//     `string` placeholder), yet it is a collection by construction, and it is
//     the shape the defect was reported against.  `single: true` binds ONE
//     record instead, so that form binds nothing.
//
// Everything else stays out: a `Table(Column("Count", o => o.count))` accessor
// param is an ELEMENT, so a domain field genuinely named `count` / `first` /
// `min` never trips the gate.
// -------------------------------------------------------------------------

/** Collection ops the frontend walkers DO render, so the gate lets them through.
 *  `map` only: native `Array.prototype.map` (JS frontends) / `Enum.map/2`
 *  (HEEx) / `Iterable.map` (Dart).  Every other catalogue op emits verbatim on
 *  at least the four JS frontends.  Grow this set only alongside a real
 *  renderer on every frontend. */
const FRONTEND_RENDERED_COLLECTION_OPS: ReadonlySet<string> = new Set(["map"]);

/** …with ONE framework carved out.  The walker has no `exprLambda` seam: a
 *  `.map(λ)` falls through to `<recv>.map(<args>)` with a hardcoded JS arrow
 *  (`(x) => …`).  That is real code on React/Vue/Svelte/Angular, valid Dart on
 *  Flutter, and HEEx routes it through its own engine — but on FELIZ it emits
 *  verbatim JS into an F# file, which `dotnet fable` rejects.  So `map` keeps
 *  its exemption everywhere except Feliz, where it joins the gated ops rather
 *  than shipping unbuildable output.  Delete this carve-out when the walker
 *  grows a lambda seam and `feliz-target.ts` renders `List.map`. */
const MAP_UNRENDERED_FRAMEWORK = "feliz";

/** True when a receiver type is a real collection — an `array`, or an
 *  `optional` wrapping one (`rows?.count`). */
function isCollectionType(t: TypeIR): boolean {
  const unwrapped = t.kind === "optional" ? t.inner : t;
  return unwrapped.kind === "array";
}

/** True when this receiver is known to hold a collection: either its `TypeIR`
 *  says so, or it is a bare ref to a row-set lambda binding (see the block
 *  above for why both are needed). */
function isCollectionReceiver(
  receiver: ExprIR,
  receiverType: TypeIR,
  rowSetBindings: ReadonlySet<string>,
): boolean {
  if (isCollectionType(receiverType)) return true;
  return receiver.kind === "ref" && rowSetBindings.has(receiver.name);
}

/** The unsupported collection-op name this node uses, or undefined.
 *  Covers BOTH spellings lowering produces: the call form
 *  (`rows.where(λ)` → `method-call` with `isCollectionOp`) and the
 *  property form (`rows.count` / `rows.first` → a plain `member`, since
 *  `lower-expr.ts` only rewrites a no-paren op into a call for the
 *  `NO_PAREN_CALL_COLLECTION_OPS` names on a TYPED collection). */
function unsupportedCollectionOp(
  e: ExprIR,
  rowSetBindings: ReadonlySet<string>,
  mapRendered: boolean,
): string | undefined {
  const named =
    e.kind === "method-call" && e.isCollectionOp
      ? e
      : e.kind === "member" && isCollectionOp(e.member)
        ? e
        : undefined;
  if (!named) return undefined;
  if (mapRendered && FRONTEND_RENDERED_COLLECTION_OPS.has(named.member)) return undefined;
  if (!isCollectionReceiver(named.receiver, named.receiverType, rowSetBindings)) return undefined;
  return named.member;
}

/** The `data:` lambda param a `QueryView` binds to a query's ROW SET, or
 *  undefined.  `single: true` binds one record, not a collection. */
function rowSetLambdaParam(e: ExprIR): string | undefined {
  if (e.kind !== "call" || e.name !== "QueryView") return undefined;
  const single = namedArg(e, "single");
  if (single?.kind === "literal" && single.lit === "bool" && single.value === "true")
    return undefined;
  const data = namedArg(e, "data");
  return data?.kind === "lambda" ? data.param : undefined;
}

/** Every expression surface of a page / component that the frontend WALKER
 *  renders.  `requires` is deliberately absent — it is a gate expression,
 *  rendered by the closed `_frontend/gate-expr.ts` (see the block above). */
function walkerRenderedExprs(host: PageIR | ComponentIR): ExprIR[] {
  const out: ExprIR[] = [];
  const push = (e?: ExprIR) => {
    if (e) out.push(e);
  };
  push(host.body);
  if ("title" in host) push(host.title);
  for (const d of host.derived as DerivedIR[]) push(d.expr);
  for (const s of host.state as StateFieldIR[]) push(s.init);
  return out;
}

// -------------------------------------------------------------------------
// F4 — `loom.unknown-page-element`.
//
// A free call in a render-tree position (`Stack { Fooo { … } }`,
// `Text(Fooo(x))`) resolves at emit time against a fixed set: the walker
// primitive registry, the ui's declared components, a declared value object
// (a VO construction is a plain wire record), a ui `extern` function, and the
// view-effect builtins.  Anything else renders as one of two failures:
//
//   LAYOUT position → `{/* unknown layout component: Fooo */}`, a visible
//                     comment — bad, but findable.
//   TEXT SLOT       → NOTHING.  `Text(Fooo(x))` emits `<Text></Text>`; the
//                     content is silently deleted.
//
// The second is reachable by an ordinary typo and was flagged at NO tier: the
// brace form `Fooo { … }` has been rejected by the language validator
// (`loom.unknown-builder-type`) all along, but the CALL form of the same
// construct slipped through — one construct, two spellings, one gated.
//
// This check gates the call form at the IR tier, where the walker's acceptance
// set is reproducible from the enriched model.
// -------------------------------------------------------------------------

/** Names a free call in a render-tree position may legitimately carry. */
interface CallableNames {
  components: ReadonlySet<string>;
  valueObjects: ReadonlySet<string>;
  functions: ReadonlySet<string>;
}

/** F4 — reject a render-tree call the walker cannot resolve.  One diagnostic
 *  per (host, name): a body repeating the same typo is one mistake. */
function checkUnknownPageElements(
  host: PageIR | ComponentIR,
  where: string,
  names: CallableNames,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free") return;
      const name = e.name;
      if (flagged.has(name)) return;
      if (
        isWalkerPrimitive(name) ||
        names.components.has(name) ||
        names.valueObjects.has(name) ||
        names.functions.has(name) ||
        VIEW_EFFECT_BUILTINS.has(name) ||
        // A sibling action referenced as a value (`onClick: bump`) lowers to an
        // `action-ref`, not a call; a call to one only appears in an action
        // BODY, which `loom.unresolved-action-ref` owns.
        host.actions.some((a) => a.name === name)
      ) {
        return;
      }
      flagged.add(name);
      diags.push({
        severity: "error",
        code: "loom.unknown-page-element",
        message: diagMessage("loom.unknown-page-element", { where, name }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.slot-outside-component` — `Slot { }` is the CHILDREN passthrough of a
// `component`: the walker sets `usesChildren`, the component shell declares the
// matching children parameter, and the call site's extra positionals fill it.
//
// A page has no caller and therefore no children parameter, so the same
// `Slot { }` in a PAGE body emits an UNBOUND children reference on every
// frontend — `{children}` (React: TS2304), `<slot />` (Vue: an empty slot that
// can never be filled), `{@render children?.()}` (Svelte: an undeclared prop),
// `<ng-content>`, `props.children` (Feliz: a missing record field — F# compile
// error) and `(child ?? const SizedBox.shrink())` (Flutter: an undeclared
// field).  Two of the six do not compile; the other four render nothing.
//
// It is a PLACEMENT mistake, not a per-target gap, so it belongs at the IR
// tier alongside `loom.unknown-page-element` — one gate, all six frontends.
// -------------------------------------------------------------------------

/** Reject `Slot { }` in a PAGE body — one diagnostic per page, however many
 *  slots it spells: a page repeating the mistake made it once. */
function checkSlotOutsideComponent(page: PageIR, where: string, diags: LoomDiagnostic[]): void {
  let flagged = false;
  for (const root of walkerRenderedExprs(page)) {
    walkExprDeep(root, (e) => {
      if (flagged || e.kind !== "call" || e.callKind !== "free" || e.name !== "Slot") return;
      flagged = true;
      diags.push({
        severity: "error",
        code: "loom.slot-outside-component",
        message: diagMessage("loom.slot-outside-component", { where }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.sub-primitive-misplaced` — `Tab` and `Column` are the walker's two
// `group: "sub"` primitives: they have NO top-level renderer of their own.
// Their parent consumes them inline — `emitTabs` scans its positional args for
// `Tab(...)`, `emitTable` / `emitDataGrid` scan theirs for `Column(...)`.
//
// Spelled anywhere else (`Stack { Tab("x") }`, a bare `Column(…)` in a page
// body, a `Column` under a `Tabs`) the call reaches the walker's own dispatch,
// which finds a registered primitive with no `tsx` entry and emits a COMMENT:
// `{/* Tab: not supported by the walker yet */}` on the JSX family (React /
// Vue / Svelte / Angular / Feliz / Flutter), `<%!-- Tab: … --%>` on HEEx.  The
// element — and everything nested inside it — silently disappears from the
// rendered page.  Nothing compiles-errors, so no build gate sees it either.
//
// This is a PLACEMENT contract, not a per-target gap — exactly the shape of
// `loom.slot-outside-component` above, and gated the same way: once, at the IR
// tier, for all seven render targets.  The legal parents come from
// `WALKER_SUB_PRIMITIVE_PARENTS`, which `walker-stdlib-completeness.test.ts`
// pins against the registry's `a11y.owns`, so a new sub-primitive cannot land
// without declaring where it belongs.
// -------------------------------------------------------------------------

/** Reject a sub-primitive call that is not a direct positional child of one of
 *  its declared parents.  One diagnostic per (host, sub-primitive name): a body
 *  misplacing three `Column`s made one mistake. */
function checkSubPrimitivePlacement(
  host: PageIR | ComponentIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  /** Recursive descent carrying the name of the IMMEDIATELY enclosing call, so
   *  the check keys on the parent/child edge the emitters actually read (a
   *  direct positional arg), not on "somewhere under a Tabs". */
  const visit = (e: ExprIR, parentCall: string | undefined): void => {
    if (e.kind === "call" && e.callKind === "free") {
      const parents = WALKER_SUB_PRIMITIVE_PARENTS.get(e.name);
      if (parents && !(parentCall !== undefined && parents.has(parentCall))) {
        if (!flagged.has(e.name)) {
          flagged.add(e.name);
          diags.push({
            severity: "error",
            code: "loom.sub-primitive-misplaced",
            message: diagMessage("loom.sub-primitive-misplaced", {
              where,
              name: e.name,
              parents: [...parents].map((p) => `'${p}'`).join(" or "),
            }),
            source: where,
          });
        }
      }
    }
    // Only a free CALL can be a legal parent (`Tabs(Tab(…), Tab(…))`); anything
    // else resets the parent to `undefined` so a sub-primitive smuggled through
    // a lambda, a member access or a `match` arm is still reported.
    const nextParent = e.kind === "call" ? e.name : undefined;
    walkExprChildren(e, {
      expr: (c) => visit(c, nextParent),
      stmt: (s) => walkStmtExprsDeep(s, (c) => visit(c, undefined)),
    });
  };
  for (const root of walkerRenderedExprs(host)) visit(root, undefined);
}

/** Every expression surface of a STORE a frontend emits: the state
 *  initialisers.  (Its action bodies are walked separately, exactly as a
 *  page's are.)  A store has no `body`/`title`/`derived`, so it cannot go
 *  through `walkerRenderedExprs`. */
function storeRenderedExprs(store: StoreIR): ExprIR[] {
  const out: ExprIR[] = [];
  for (const s of store.state) if (s.init) out.push(s.init);
  return out;
}

// -------------------------------------------------------------------------
// `loom.page-primitive-extra-children` — the ARITY twin of the multi-child
// container sweep (#2567's `Card`, and `Tab` alongside this change).
//
// A container primitive (`Stack`, `Card`, `Tab`, …) renders EVERY positional
// as a child.  A handful of primitives are not containers at all: they are
// fixed SLOT shapes whose pack templates interpolate a known number of
// positions and have nowhere to put an extra one —
//
//   Stat(label, value)          two stacked text elements, `{{{label}}}` +
//                               `{{{value}}}` on all 15 packs
//   KeyValueRow(label, value)   a `<dt>`/`<dd>` pair; the value cell takes ONE
//                               already-walked element on Feliz/Flutter
//   Modal(trigger:, OperationForm(…))
//                               renders the TRIGGER button only — the dialog
//                               body is the op-form's generated field set
//
// A positional past a shape's slot count was read by nobody: the content
// vanished from every frontend while still landing in
// `.loom/messages.en.json`, the same translators-get-a-key-nothing-renders
// symptom `Tab` had.  Widening the packs is not the fix here (there is no
// second value slot to widen INTO), so this is the honest gate — the other
// half of #2567's fix-or-gate rule.
//
// MEMBERSHIP is no longer hand-listed here.  It was, and it covered exactly
// `Stat` / `KeyValueRow` / the op-form `Modal` while every other fixed-arity
// read in the primitive table stayed unguarded — `EnumBadge { "x", "dropped" }`
// and `Image { "/a.png", "/dropped.png", alt: "a" }` both parsed clean and both
// emitted only the first positional.  The slot counts now come from the ONE
// declaration of each primitive's argument surface,
// `WALKER_PRIMITIVE_SLOTS` in `src/util/walker-primitive-names.ts`, which a
// completeness test pins against the emitters' own positional reads.  A new primitive declares
// its contract there or the completeness test fails; it can no longer land
// silently outside this gate.
// -------------------------------------------------------------------------

/** The positional args of a lowered call (named args carry an `argNames` entry
 *  at the same index).  Mirrors the walker's `positionalArgs`, which lives in
 *  the generator layer and cannot be imported here. */
function positionalArgsOf(e: Extract<ExprIR, { kind: "call" }>): ExprIR[] {
  return e.args.filter((_, i) => !e.argNames?.[i]);
}

/** Visit every free call the walker DISPATCHES AS A PRIMITIVE.
 *
 *  A call sitting in the RECEIVER position of a member / method-call is not
 *  one: the walker hands the whole access to `emitExpr`, never to the
 *  primitive registry.  That distinction is load-bearing because a
 *  user-declared value object may share a primitive's NAME —
 *  `Stat { "valueObject", Money(9.99, "USD").currency }` in
 *  `web/src/examples/expression-showcase.ddd` constructs the VO `Money`, and
 *  reading it as the `Money` PRIMITIVE would reject shipped source over an
 *  arity the emitter never applies to it.  So the receiver chain is skipped
 *  while the ARGUMENTS are still walked (`rows.map(r => Text { r.name })`
 *  renders its lambda body). */
function walkRenderedPrimitives(
  e: ExprIR,
  visit: (call: Extract<ExprIR, { kind: "call" }>) => void,
): void {
  if (e.kind === "member" || e.kind === "method-call") {
    const receiver = e.receiver;
    walkExprChildren(e, {
      expr: (c) => {
        if (c !== receiver) walkRenderedPrimitives(c, visit);
      },
      stmt: (s) => walkStmtExprsDeep(s, (c) => walkRenderedPrimitives(c, visit)),
    });
    return;
  }
  if (e.kind === "call" && e.callKind === "free") visit(e);
  walkExprChildren(e, {
    expr: (c) => walkRenderedPrimitives(c, visit),
    stmt: (s) => walkStmtExprsDeep(s, (c) => walkRenderedPrimitives(c, visit)),
  });
}

// -------------------------------------------------------------------------
// `loom.table-filter-unsupported` / `loom.table-filter-server-paged` (M-T1.1)
//
// `Table { filter: <state> }` binds a search box above the table that narrows
// the rows client-side.  It renders on the six frameworks that ride the shared
// `walkBody` core — all six declare the `renderFilteredRows` +
// `renderFilterInput` seams — and on NOBODY else:
//
//   * HEEx runs a parallel engine (`elixir/heex-primitives.ts` `renderTable`),
//     whose `else if` chain handles `rows` / `testid` / sort / page and lets
//     `filter:` fall through into nothing.  No seam, no marker, no diagnostic.
//   * A SERVER-PAGED table's rows are one server window, so a client filter
//     would narrow that page rather than the result set — `table.ts` gates it
//     off (`!serverPaged`) and drops the arg.  This is the common case, not the
//     exotic one: `auto-paged-table.ts` REWRITES the simplest hand-written
//     `QueryView { of: X.all, data: rows => Table { rows: rows, filter: q } }`
//     into the server-paged shape, so the natural spelling loses its filter
//     with `ddd parse` reporting `0 error(s), 0 warning(s)` and the bound state
//     field left as a dead `useState`.
//
// Rendering it is a real slice on both sides (a `filter` param threaded into
// the generated `list/4` + a `handle_event` on LiveView; a server-side filter
// param on the paged read), so this is the honest half meanwhile.
// -------------------------------------------------------------------------

/** Frontends whose walker renders `Table { filter: … }` — the six that declare
 *  `renderFilteredRows` + `renderFilterInput` on their `WalkerTarget`.
 *
 *  EXPORTED so its own test can prove the gate still bites: with the six
 *  shipping frameworks listed, "the check works" and "the check is
 *  unreachable" look identical from outside, and the only honest way to tell
 *  them apart is to remove one and watch the diagnostic come back — the same
 *  discipline `CHART_FRAMEWORKS` uses. */
export const TABLE_FILTER_FRAMEWORKS: ReadonlySet<string> = new Set([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
]);

/** True when a `Table` call carries a `filter:` bound to a page-state ref —
 *  exactly what `emitTable`'s `refArgName(call, "filter")` reads. */
function tableFilterRef(e: Extract<ExprIR, { kind: "call" }>): string | undefined {
  const i = (e.argNames ?? []).indexOf("filter");
  if (i < 0) return undefined;
  const arg = e.args[i];
  return arg?.kind === "ref" ? arg.name : undefined;
}

/** True when the call declares `serverPaged: true` — the flag `emitTable` reads
 *  and `auto-paged-table.ts` stamps on the rewritten hand-written table. */
function tableIsServerPaged(e: Extract<ExprIR, { kind: "call" }>): boolean {
  const i = (e.argNames ?? []).indexOf("serverPaged");
  if (i < 0) return false;
  const arg = e.args[i];
  return arg?.kind === "literal" && arg.lit === "bool" && arg.value === "true";
}

function checkTableFilterSupport(
  host: PageIR | ComponentIR,
  where: string,
  framework: string,
  deployable: string,
  diags: LoomDiagnostic[],
): void {
  let flaggedUnsupported = false;
  let flaggedPaged = false;
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      if (e.name !== "Table") return;
      const filter = tableFilterRef(e);
      if (filter === undefined) return;
      if (!TABLE_FILTER_FRAMEWORKS.has(framework)) {
        if (flaggedUnsupported) return;
        flaggedUnsupported = true;
        diags.push({
          severity: "error",
          code: "loom.table-filter-unsupported",
          message: diagMessage("loom.table-filter-unsupported", {
            where,
            filter,
            framework,
            deployable,
          }),
          source: where,
        });
        return;
      }
      if (!tableIsServerPaged(e) || flaggedPaged) return;
      flaggedPaged = true;
      diags.push({
        severity: "error",
        code: "loom.table-filter-server-paged",
        message: diagMessage("loom.table-filter-server-paged", { where, filter }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.modal-controlled-op-form-unsupported` (F2-CFE-12)
//
// `Modal { open: <stateBool>, OperationForm { … } }` combines the two modal
// shapes: the STATE-CONTROLLED shell (`emitControlledModal`) and the
// OPERATION-FORM dialog (`emitModal`'s trigger + generated field set).
// `emitModal` only reaches the controlled path when there is NO form child, so
// with both present and no `trigger:` control falls through to
// `renderComment("Modal: expects trigger: Button(...) and an
// OperationForm(<instance>.<operation>) child")` — the whole modal, form
// included, becomes a comment.  A `Tab` whose only child is that modal renders
// an empty panel, and `ddd parse` reports no error.
//
// It is NOT universal: Angular and Feliz fork the primitive and render the
// operation form (ignoring the `open:` binding, driving the dialog from their
// own trigger), and HEEx's `renderModal` handles it too.  So this is a
// per-target gap on the four that drop it, not a rejected shape.
// -------------------------------------------------------------------------

/** Frontends whose modal emitter renders an `OperationForm` child alongside an
 *  `open:` binding.  EXPORTED for the same reason as
 *  `TABLE_FILTER_FRAMEWORKS`: a gate whose Set names every target that can do
 *  the thing is indistinguishable from a dead one unless a test removes an
 *  entry and watches the diagnostic return. */
export const CONTROLLED_MODAL_OP_FORM_FRAMEWORKS: ReadonlySet<string> = new Set([
  "angular",
  "feliz",
  "phoenixLiveView",
]);

function checkControlledModalOpForm(
  host: PageIR | ComponentIR,
  where: string,
  framework: string,
  deployable: string,
  diags: LoomDiagnostic[],
): void {
  if (CONTROLLED_MODAL_OP_FORM_FRAMEWORKS.has(framework)) return;
  let flagged = false;
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      if (flagged || e.name !== "Modal") return;
      if ((e.argNames ?? []).indexOf("open") < 0) return;
      const hasOpForm = positionalArgsOf(e).some(
        (a) => a.kind === "call" && a.name === "OperationForm",
      );
      if (!hasOpForm) return;
      flagged = true;
      diags.push({
        severity: "error",
        code: "loom.modal-controlled-op-form-unsupported",
        message: diagMessage("loom.modal-controlled-op-form-unsupported", {
          where,
          framework,
          deployable,
        }),
        source: where,
      });
    });
  }
}

/** Reject positionals no pack renders.  One diagnostic per (host, primitive):
 *  a body over-filling `Stat` twice made one mistake. */
function checkFixedSlotArity(
  host: PageIR | ComponentIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      const spec = WALKER_PRIMITIVE_SLOTS.get(e.name);
      if (spec) {
        if (positionalArgsOf(e).length <= spec.max || flagged.has(e.name)) return;
        flagged.add(e.name);
        diags.push({
          severity: "error",
          code: "loom.page-primitive-extra-children",
          message: diagMessage("loom.page-primitive-extra-children", {
            where,
            name: e.name,
            max: spec.max,
            slots: spec.slots ?? "its declared slots",
          }),
          source: where,
        });
        return;
      }
      // The op-form `Modal` shape: `primitive-modal` emits the trigger button
      // and nothing else, so every positional besides the `OperationForm`
      // child is dropped.  The state-controlled shape (`open: <state>`) IS a
      // children container and walks all of them — leave it alone.
      if (e.name !== "Modal" || flagged.has("Modal")) return;
      const positionals = positionalArgsOf(e);
      const hasOpForm = positionals.some((a) => a.kind === "call" && a.name === "OperationForm");
      if (!hasOpForm || positionals.length <= 1) return;
      flagged.add("Modal");
      diags.push({
        severity: "error",
        code: "loom.page-primitive-extra-children",
        message: diagMessage("loom.page-primitive-extra-children#modal-op-form", { where }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.unresolved-page-ref` — the last silent-drop door in a page body.
//
// A bare name in a rendered position resolves at emit time against the route
// params, the `state { }` fields, the `derived` bindings, an enclosing
// lambda's parameter, a `<Store>.<field>` read, or a `let`.  Anything else
// lowers to `refKind: "unknown"` and the walker emits a COMMENT —
// `{/* ref: nosuchthing */}` on the four JS frontends, `Html.none` on Feliz,
// `SizedBox.shrink()` on Flutter.  `Text { nosuchthing }` therefore compiles
// green on all six with its content gone: a typo deletes the content, exactly
// like the `Text(Fooo(x))` case `loom.unknown-page-element` closed for the
// CALL spelling.  The REF spelling had no gate at any tier — this is it.
//
// Scope is deliberately the walker's own: the direct positional arguments of a
// rendered call (and the operand/arm sub-expressions inside one), never a
// member or method-call RECEIVER — `Status.Open` and `Shop.Thing.all` root at
// an `unknown` ref by design (an enum name, an api handle), and those are
// resolved by the member walk, not by the ref.
// -------------------------------------------------------------------------

/** Collect the refs a rendered slot resolves DIRECTLY, stopping at any
 *  receiver-rooted shape (member / method-call / nested call). */
function directlyRenderedRefs(e: ExprIR, out: Extract<ExprIR, { kind: "ref" }>[]): void {
  switch (e.kind) {
    case "ref":
      out.push(e);
      return;
    case "paren":
      directlyRenderedRefs(e.inner, out);
      return;
    case "unary":
      directlyRenderedRefs(e.operand, out);
      return;
    case "binary":
      directlyRenderedRefs(e.left, out);
      directlyRenderedRefs(e.right, out);
      return;
    case "ternary":
      directlyRenderedRefs(e.cond, out);
      directlyRenderedRefs(e.then, out);
      directlyRenderedRefs(e.otherwise, out);
      return;
    default:
      return;
  }
}

/** Named primitive slots whose argument is a VALUE the frontend reads and
 *  renders — as opposed to the structural slots (`of:` / `op:` / `workflow:` /
 *  `to:` / `data:` …) that name a DECLARATION the walker resolves against the
 *  model.  Only these carry the silent-drop / `undefined`-emitting failure the
 *  ref gate exists to close, so only these are scanned for unresolved refs. */
const VALUE_SLOT_ARGS: ReadonlySet<string> = new Set([
  "value",
  "label",
  "text",
  "title",
  "subtitle",
  "caption",
  "placeholder",
  "help",
  "hint",
  "alt",
  "message",
  "description",
  "emptyText",
]);

/** Reject an unresolved bare ref in a rendered slot.  One diagnostic per
 *  (host, name): a page spelling the same typo three times made one mistake. */
function checkUnresolvedPageRefs(
  host: PageIR | ComponentIR,
  where: string,
  names: CallableNames,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free") return;
      // Only calls the walker RENDERS: a stdlib primitive or a declared
      // component.  Anything else is `loom.unknown-page-element`'s business.
      if (!isWalkerPrimitive(e.name) && !names.components.has(e.name)) return;
      const slots: Extract<ExprIR, { kind: "ref" }>[] = [];
      e.args.forEach((arg, i) => {
        const argName = e.argNames?.[i];
        // A POSITIONAL arg is a rendered slot outright.  A NAMED arg is a
        // rendered slot only when the name is a VALUE slot: `Text { value:
        // nosuchthing }` emits `<Text></Text>` with the content silently gone,
        // and `Money { value: alsomissing }` emits `<MoneyValue value={ /*
        // unresolved: alsomissing */ undefined } />` — a guaranteed TypeError
        // that also fails `tsc --noEmit` / `svelte-check` / `vue-tsc`.  Scanning
        // positionals ONLY let that identical defect through on the spelling
        // authors actually use for a value.
        //
        // The other named slots are STRUCTURAL: `of:` / `op:` / `workflow:` name
        // a DECLARATION (an aggregate, an operation, a workflow), which lowers
        // to `refKind: "unknown"` by design because the walker resolves it
        // against the model rather than the page's value scope — the same class
        // as the `Status.Open` enum receiver this walk already stops at.  Every
        // scaffolded page in the corpus spells them, so reading them as value
        // slots would reject shipped output.  Keyed on the slot NAME rather than
        // on "is this a declared name?" because the latter has to enumerate
        // every declaration namespace and silently reopens the hole for the one
        // it forgets.
        if (argName !== undefined && !VALUE_SLOT_ARGS.has(argName)) return;
        directlyRenderedRefs(arg, slots);
      });
      for (const ref of slots) {
        if (ref.refKind !== "unknown" || flagged.has(ref.name)) continue;
        flagged.add(ref.name);
        diags.push({
          severity: "error",
          code: "loom.unresolved-page-ref",
          message: diagMessage("loom.unresolved-page-ref", { where, name: ref.name }),
          source: where,
        });
      }
    });
  }
}

/** F3 — reject a stdlib collection op anywhere the frontend walker renders it.
 *  One diagnostic per (host, op name): a body reading `rows.count` twice is one
 *  authoring mistake, not two. */
function checkFrontendCollectionOps(
  host: PageIR | ComponentIR | StoreIR,
  where: string,
  mapRendered: boolean,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  const report = (op: string): void => {
    if (flagged.has(op)) return;
    flagged.add(op);
    diags.push({
      severity: "error",
      code: "loom.frontend-collection-op-unsupported",
      message: diagMessage("loom.frontend-collection-op-unsupported", { where, op }),
      source: where,
    });
  };
  // Scope-tracking walk: `rowSetBindings` grows as we descend into a
  // `QueryView`'s `data:` lambda, so `rows` is recognised as a collection
  // inside that lambda and nowhere else.  (`walkExprDeep` can't thread scope,
  // hence the explicit recursion over `walkExprChildren`.)
  const visitStmt = (s: StmtIR, scope: ReadonlySet<string>): void =>
    walkStmtChildren(
      s,
      (c) => visit(c, scope),
      (n) => visitStmt(n, scope),
    );
  const visit = (e: ExprIR, rowSetBindings: ReadonlySet<string>): void => {
    const op = unsupportedCollectionOp(e, rowSetBindings, mapRendered);
    if (op !== undefined) report(op);
    const rowParam = rowSetLambdaParam(e);
    const inner: ReadonlySet<string> = rowParam
      ? new Set<string>([...rowSetBindings, rowParam])
      : rowSetBindings;
    walkExprChildren(e, {
      expr: (c) => visit(c, inner),
      stmt: (s) => visitStmt(s, inner),
    });
  };
  const empty: ReadonlySet<string> = new Set<string>();
  // `lifetime` is StoreIR's discriminator — a page/component never carries one.
  const roots = "lifetime" in host ? storeRenderedExprs(host) : walkerRenderedExprs(host);
  for (const e of roots) visit(e, empty);
  for (const action of host.actions) for (const s of action.body) visitStmt(s, empty);
}

/** The aggregate + op a `variant-match` subject awaits, when it is an aggregate
 *  INSTANCE operation — `<apiParam>.<Agg>.<op>(…)` (Pattern B) or a bare
 *  `<Agg>.<op>(…)` (Pattern E); otherwise null.  Mirrors `detectAwaitedInstanceOp`
 *  in the Feliz classifier, target-neutral. */
function resolveInstanceOpSubject(
  subject: ExprIR,
  apiParamNames: ReadonlySet<string>,
  aggNames: ReadonlySet<string>,
): { aggregate: string; op: string } | null {
  if (subject.kind !== "method-call") return null;
  const recv = subject.receiver;
  if (
    recv.kind === "member" &&
    recv.receiver.kind === "ref" &&
    apiParamNames.has(recv.receiver.name) &&
    aggNames.has(recv.member)
  ) {
    return { aggregate: recv.member, op: subject.member };
  }
  if (recv.kind === "ref" && aggNames.has(recv.name)) {
    return { aggregate: recv.name, op: subject.member };
  }
  return null;
}

/** Walk a `variant-match` subject at every depth in an action body. */
function forEachVariantMatch(
  stmts: readonly StmtIR[],
  visit: (s: Extract<StmtIR, { kind: "variant-match" }>) => void,
): void {
  for (const s of stmts) {
    if (s.kind === "variant-match") {
      visit(s);
      for (const arm of s.arms) forEachVariantMatch(arm.body, visit);
      forEachVariantMatch(s.elseBody ?? [], visit);
    }
  }
}

/** Reject an instance-op `match await` on a page with no `:id` route. */
function checkInstanceEffectRouteId(
  page: PageIR,
  aggNames: ReadonlySet<string>,
  apiParamNames: ReadonlySet<string>,
  diags: LoomDiagnostic[],
): void {
  if (pageRouteHasParam(page.route)) return;
  for (const action of page.actions) {
    forEachVariantMatch(action.body, (s) => {
      if (!resolveInstanceOpSubject(s.subject, apiParamNames, aggNames)) return;
      diags.push({
        severity: "error",
        code: "loom.instance-effect-needs-route-id",
        message: diagMessage("loom.instance-effect-needs-route-id", {
          name: page.name,
          route: page.route ?? "/",
        }),
        source: `page '${page.name}'`,
      });
    });
  }
}

/** `loom.match-await-arg-mismatch` — the awaited op call's arguments must match
 *  the operation signature.  The request payload every frontend POSTs is built by
 *  index-aligning the call's args with the op's params, so a wrong count silently
 *  ships a broken request (React emits `{ note: undefined }`; Feliz fails the
 *  Fable compile).  Validate the arity here, target-agnostically: at most one arg
 *  per param, and every un-supplied trailing param must be `optional`. */
function checkAsyncEffectArgs(
  where: string,
  actions: readonly ActionIR[],
  aggByName: ReadonlyMap<string, AggregateIR>,
  apiParamNames: ReadonlySet<string>,
  aggNames: ReadonlySet<string>,
  diags: LoomDiagnostic[],
): void {
  for (const action of actions) {
    forEachVariantMatch(action.body, (s) => {
      if (s.subject.kind !== "method-call") return;
      const resolved = resolveInstanceOpSubject(s.subject, apiParamNames, aggNames);
      const agg = resolved && aggByName.get(resolved.aggregate);
      const op = agg?.operations.find((o) => o.name === resolved!.op);
      if (!op) return; // not a resolvable aggregate op — nothing to arity-check
      const args = s.subject.args;
      const params = op.params;
      const sig = params.map((p) => `${p.name}: ${typeLabel(p.type)}`).join(", ");
      // Arity — the request payload index-aligns args → params.
      const tooMany = args.length > params.length;
      const missingRequired = params.slice(args.length).some((p) => p.type.kind !== "optional");
      if (tooMany || missingRequired) {
        diags.push({
          severity: "error",
          code: "loom.match-await-arg-mismatch",
          message: diagMessage("loom.match-await-arg-mismatch", {
            where,
            aggregate: resolved!.aggregate,
            op: resolved!.op,
            length: args.length,
            sig,
            paramsLength: params.length,
            length2: params.filter((p) => p.type.kind !== "optional").length,
          }),
          source: where,
        });
      }
      // Type — for the args we can PROVE a type of (literals), the family must
      // match the param's.  Refs / computed exprs are skipped (no false positive);
      // full expr-type inference over the args is the language-type-checker's job.
      for (let i = 0; i < Math.min(args.length, params.length); i++) {
        const arg = args[i]!;
        if (arg.kind !== "literal") continue;
        const argFam = literalFamily(arg.lit);
        const paramFam = typeFamily(params[i]!.type);
        if (!argFam || !paramFam || argFam === paramFam) continue;
        diags.push({
          severity: "error",
          code: "loom.match-await-arg-type",
          message: diagMessage("loom.match-await-arg-type", {
            where,
            aggregate: resolved!.aggregate,
            op: resolved!.op,
            argFam,
            value: arg.value,
            name: params[i]!.name,
            type: typeLabel(params[i]!.type),
            paramFam,
          }),
          source: where,
        });
      }
    });
  }
}

/** Coarse type family of a literal, or undefined when it doesn't constrain
 *  (`null` / `now`).  Used for a low-false-positive arg/param type check. */
function literalFamily(lit: string): "numeric" | "string" | "bool" | undefined {
  switch (lit) {
    case "int":
    case "long":
    case "decimal":
    case "money":
      return "numeric";
    case "string":
      return "string";
    case "bool":
      return "bool";
    default:
      return undefined; // null / now — don't constrain
  }
}

/** Coarse type family of a param type (peeling `optional`), or undefined when a
 *  literal can't be meaningfully family-checked against it (VO / entity / array).
 *  Enum + id + datetime are string-ish on the wire, so a string literal fits. */
function typeFamily(t: TypeIR): "numeric" | "string" | "bool" | undefined {
  const base = t.kind === "optional" ? t.inner : t;
  if (base.kind === "id" || base.kind === "enum") return "string";
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
      case "decimal":
      case "money":
        return "numeric";
      case "bool":
        return "bool";
      case "string":
      case "json":
      case "datetime":
        return "string";
      default:
        return undefined;
    }
  }
  return undefined;
}

/** A short type label for an arg-mismatch message (`string`, `int`, `Money?`). */
interface BodyCheckCtx {
  aggByName: Map<string, AggregateIR>;
  /** Every declared `projection` name in the model — F3's lookup set. */
  projectionNames: ReadonlySet<string>;
  /** The subset a frontend can actually read (`isFrontendReadableProjection`).
   *  F3 rejects a read of a projection OUTSIDE this set on every target; a read
   *  INSIDE it is a per-framework question (only some frontends have the
   *  client), decided by `validateUiProjectionReadFramework` in system-checks. */
  readableProjections: ReadonlySet<string>;
  /** Receiver-root names the walker resolves to an api / workflow-
   *  instance hook (`tryDetectApiHook`) or a declared handle — a valid
   *  method-call receiver root even though it lowers to an `unknown` ref. */
  handles: ReadonlySet<string>;
  /** Names bound in the current lexical scope (lambda params + form
   *  shell-locals) that resolve cleanly even though they lower to an
   *  `unknown` ref. */
  scope: ReadonlySet<string>;
  where: string;
  /** Named `action`s declared on the enclosing page/component, by name —
   *  used by the payload-conformance check to look up the referenced action's
   *  declared arity / param type (named-actions-and-stores.md, Proposal A). */
  actionsByName: ReadonlyMap<string, ActionIR>;
  /** UI extern-function names (`function f(…) extern from "…"`) in scope — a
   *  bare call to one is a legitimate `private-operation`-shaped call in an
   *  action body, not an unresolved action reference. */
  functionNames: ReadonlySet<string>;
  /** Component name → set of its `action`-typed param names.  A lambda passed
   *  to such a slot is the extern-component Tier 2 behaviour callback
   *  (extern-component-escape-hatch.md §3): it legitimately carries effects that
   *  walk in the CALLER's scope, so it is EXEMPT from `loom.effect-in-lambda`. */
  componentActionParams: ReadonlyMap<string, ReadonlySet<string>>;
  /** Lambdas the `call` arm has marked exempt from the purity check because they
   *  fill an `action`-typed component-param slot.  Shared by reference (object
   *  identity) across the whole body walk. */
  exemptLambdas: Set<ExprIR>;
  /** True while walking inside an action body (Fix 4/5).  Drives the
   *  action-body call checks: a bare call that lowered to `private-operation`
   *  is an unresolved action reference here (no such backend op exists on a
   *  frontend surface), and a BARE remote/mutating op call wants the `await`
   *  effect marker (`loom.missing-effect-marker` — async-actions-and-effects.md
   *  Stage 2; a `match await` subject is accepted). */
  inActionBody?: boolean;
}

function pageWhere(p: PageIR): string {
  return `page '${p.name}'`;
}

// -------------------------------------------------------------------------
// `loom.datagrid-selection-not-state` / `loom.datagrid-selection-not-array` —
// `DataGrid(selection: <field>)` is the one piece of grid view-state the page
// can read, and the walker wires it by NAME: it emits
// `onSelectionChange={set<Field>}` against the page shell's
// `useState<...>` for that field.  The walker has no types, so it can only
// check that the name is a declared state field — and silently drops the
// selection column when it isn't.  Both halves are gated here instead, where
// the declared `TypeIR` is resolved and the diagnostic can name the field:
//
//   - not a state field  → the checkbox column vanishes with no explanation
//     (the ref might be a page param, a `let`, or a typo);
//   - not `String[]`     → the emitted `setX(ids: string[])` is assigned a
//     `string[]` against e.g. `useState<string>`, surfacing as a tsc error in
//     generated code, far from its cause in the `.ddd`.
// -------------------------------------------------------------------------

function checkDataGridSelection(
  body: ExprIR | undefined,
  state: readonly StateFieldIR[],
  where: string,
  diags: LoomDiagnostic[],
): void {
  const byName = new Map(state.map((f) => [f.name, f.type]));
  walkExprDeep(body, (e) => {
    if (e.kind !== "call" || e.name !== "DataGrid") return;
    const arg = namedArg(e, "selection");
    if (!arg) return;
    if (arg.kind !== "ref" || !byName.has(arg.name)) {
      const label = arg.kind === "ref" ? `'${arg.name}'` : "that expression";
      diags.push({
        severity: "error",
        code: "loom.datagrid-selection-not-state",
        message: diagMessage("loom.datagrid-selection-not-state", {
          where,
          where2: where.startsWith("component") ? "component" : "page",
          label,
        }),
        source: where,
      });
      return;
    }
    const t = byName.get(arg.name)!;
    if (!isStringArray(t)) {
      diags.push({
        severity: "error",
        code: "loom.datagrid-selection-not-array",
        message: diagMessage("loom.datagrid-selection-not-array", {
          where,
          name: arg.name,
          t: typeLabel(t),
        }),
        source: where,
      });
    }
  });
}

/** True for exactly `String[]` — the selected-row-id list shape the walker
 *  emits (`onSelectionChange: (ids: string[]) => void`). */
function isStringArray(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "primitive" && t.element.name === "string";
}

// -------------------------------------------------------------------------
// `loom.chart-of-not-grouped` / `loom.chart-kind-invalid` /
// `loom.chart-accessor-not-field` — the `Chart` primitive's arg shapes.
// The walker resolves each arg by NAME with no types in
// scope, so a wrong shape would emit a chart keyed on an empty string or
// bound to a one-object singleton read (`.data ?? []` of an object → `[]`, a
// permanently empty chart with no diagnostic).  Gated here instead, where the
// projection inventory and its `wireShape` are resolved and the diagnostic
// can name the fix.  Whether the TARGET can render a chart at all is
// `validateChartSupport` (system-checks.ts) — same flavour/framework split as
// the projection-read gates above.
// -------------------------------------------------------------------------

function checkChartArgs(
  body: ExprIR | undefined,
  handles: ReadonlySet<string>,
  groupedReadable: ReadonlySet<string>,
  projections: ReadonlyMap<string, ProjectionIR>,
  where: string,
  diags: LoomDiagnostic[],
): void {
  walkExprDeep(body, (e) => {
    if (e.kind !== "call" || e.name !== "Chart") return;
    const kindArg = namedArg(e, "kind");
    const kind =
      kindArg?.kind === "literal" && kindArg.lit === "string" ? kindArg.value : undefined;
    if (kind !== "line" && kind !== "bar") {
      diags.push({
        severity: "error",
        code: "loom.chart-kind-invalid",
        message: diagMessage("loom.chart-kind-invalid", {
          where,
          kind: kind !== undefined ? ` — got "${kind}"` : "",
        }),
        source: where,
      });
    }
    // `of:` must be `<ApiHandle>.<Projection>` naming a readable GROUPED
    // projection — the LIST-shaped read the chart plots one point/bar per row
    // of.  A singleton returns ONE object (nothing to plot); a keyed/folded
    // projection has no frontend client at all (F3 above).
    const of = namedArg(e, "of");
    const projName =
      of?.kind === "member" && of.receiver.kind === "ref" && handles.has(of.receiver.name)
        ? of.member
        : undefined;
    const proj = projName !== undefined ? projections.get(projName) : undefined;
    const grouped = projName !== undefined && groupedReadable.has(projName);
    if (!grouped) {
      const why =
        proj !== undefined
          ? `projection '${projName}' is not a grouped query-time projection — it has no ` +
            `'group by', so its read is not the one-row-per-group list a chart plots. Add ` +
            `\`group by <column>\` to '${projName}' (with the matching key in its 'select'), ` +
            `or bind a singleton through \`QueryView\`/\`Stat\` instead`
          : `'of:' must be \`<ApiHandle>.<Projection>\` naming a grouped (\`group by\`) ` +
            `query-time projection declared in a served context`;
      diags.push({
        severity: "error",
        code: "loom.chart-of-not-grouped",
        message: diagMessage("loom.chart-of-not-grouped", { where, why }),
        source: where,
      });
    }
    // `x:`/`y:` must be simple accessor lambdas (`r => r.status`) naming a
    // declared row field — that is what unwraps to the chart's `dataKey` /
    // series string.  A computed body has no field name to key on.
    for (const slot of ["x", "y"] as const) {
      const lam = namedArg(e, slot);
      const field =
        lam?.kind === "lambda" && lam.body?.kind === "member" && lam.body.receiver.kind === "ref"
          ? lam.body.member
          : undefined;
      if (field === undefined) {
        diags.push({
          severity: "error",
          code: "loom.chart-accessor-not-field",
          message: diagMessage("loom.chart-accessor-not-field#not-a-simple-accessor", {
            where,
            slot,
            slot2: slot === "x" ? "category axis" : "series",
          }),
          source: where,
        });
      } else if (grouped && proj && !(proj.wireShape ?? []).some((f) => f.name === field)) {
        diags.push({
          severity: "error",
          code: "loom.chart-accessor-not-field",
          message: diagMessage("loom.chart-accessor-not-field#not-a-row-field", {
            where,
            slot,
            field,
            projName,
            wireShape: (proj.wireShape ?? []).map((f) => `'${f.name}'`).join(", "),
          }),
          source: where,
        });
      }
    }
  });
}

/** Fix 4 — run the same IR body checks over every named action's body, with
 *  the action's params in scope: the F1/F2/payload checks and, via the
 *  `inActionBody` flag, the action-only purity checks (Fix 3 body-call +
 *  Fix 5 await-floor). */
function checkActionBodies(
  actions: readonly ActionIR[],
  baseCtx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  for (const action of actions) {
    const scope = new Set<string>([...baseCtx.scope, ...action.params.map((p) => p.name)]);
    const ctx: BodyCheckCtx = {
      ...baseCtx,
      scope,
      inActionBody: true,
      where: `${baseCtx.where} action '${action.name}'`,
    };
    for (const s of action.body) checkStmt(s, ctx, diags);
  }
}

/** Walk a body expression, applying F1 (Action) and F2 (method-call
 *  receiver) checks and threading lambda / form shell-local scope. */
function checkBody(e: ExprIR | undefined, ctx: BodyCheckCtx, diags: LoomDiagnostic[]): void {
  if (!e) return;
  switch (e.kind) {
    case "call": {
      // F1 — `Action(<inst>.<op>)` with a parameterized operation.
      if (e.callKind === "free" && e.name === "Action") checkActionParams(e, ctx, diags);
      // Named-action payload conformance — a bare `onSubmit:`/`onRowClick:`
      // action reference must match (arity) what the primitive supplies.
      checkActionPayload(e, ctx, diags);
      // Fix 3 — an unresolved bare ref in an action-handler slot
      // (`onRowClick: ghost`) names no sibling action and nothing else.
      checkHandlerSlotRefs(e, ctx, diags);
      // Descend, extending scope for any form primitive's lambda args.
      // Exempt lambdas filling an `action`-typed param of a user component
      // (extern-component Tier 2 behaviour callbacks) from the purity check.
      const actionParams = ctx.componentActionParams.get(e.name);
      if (actionParams) {
        const names = e.argNames ?? [];
        for (let i = 0; i < e.args.length; i++) {
          const a = e.args[i];
          const n = names[i];
          if (a?.kind === "lambda" && n && actionParams.has(n)) ctx.exemptLambdas.add(a);
        }
      }
      const shellLocals = FORM_SHELL_LOCALS[e.name];
      const childScope = shellLocals ? new Set<string>([...ctx.scope, ...shellLocals]) : ctx.scope;
      for (const a of e.args) checkBody(a, { ...ctx, scope: childScope }, diags);
      return;
    }
    case "method-call": {
      // F2 — the receiver must resolve to a binding.
      checkMethodCallReceiver(e, ctx, diags);
      // Fix 5 — a remote/mutating backend command in action-body position
      // needs an `await` marker (Proposal B) that doesn't exist yet.
      if (ctx.inActionBody) checkMissingEffectMarker(e, ctx, diags);
      checkBody(e.receiver, ctx, diags);
      for (const a of e.args) checkBody(a, ctx, diags);
      return;
    }
    case "lambda": {
      const childScope = new Set<string>([...ctx.scope, e.param]);
      // A render-tree lambda must be PURE — an inline effect handler
      // (`onClick: e => { count := count + 1 }`) is rejected in favour of a
      // named `action` (loom.effect-in-lambda).  Effects live only in an
      // `action` body (walked via `checkActionBodies`, never through this arm),
      // so any effectful statement reached here is an inline handler.
      checkLambdaPurity(e, ctx, diags);
      checkBody(e.body, { ...ctx, scope: childScope }, diags);
      for (const s of e.block ?? []) checkStmt(s, { ...ctx, scope: childScope }, diags);
      return;
    }
    case "member":
      // F3 — a ui read of a `projection` has no frontend path yet.
      checkProjectionRead(e, ctx, diags);
      checkBody(e.receiver, ctx, diags);
      return;
    case "binary":
      checkBody(e.left, ctx, diags);
      checkBody(e.right, ctx, diags);
      return;
    case "unary":
      checkBody(e.operand, ctx, diags);
      return;
    case "paren":
      checkBody(e.inner, ctx, diags);
      return;
    case "ternary":
      checkBody(e.cond, ctx, diags);
      checkBody(e.then, ctx, diags);
      checkBody(e.otherwise, ctx, diags);
      return;
    case "convert":
      checkBody(e.value, ctx, diags);
      return;
    case "list":
      for (const el of e.elements) checkBody(el, ctx, diags);
      return;
    case "match":
      for (const arm of e.arms) {
        checkBody(arm.cond, ctx, diags);
        checkBody(arm.value, ctx, diags);
      }
      checkBody(e.otherwise, ctx, diags);
      return;
    case "new":
    case "object":
      for (const f of e.fields) checkBody(f.value, ctx, diags);
      return;
    default:
      return;
  }
}

/** Statement bodies inside block lambdas (StmtIR) — descend into every
 *  child expression so an Action / method-call nested in a block lambda
 *  (`onClick: e => { Orders.create(draft) }`) is still checked.  Covers the
 *  single-expr slots (`expr` / `value`) and the `args` array of a call
 *  statement; `emit` field values are recursed too. */
function checkStmt(
  s: { kind: string } & Record<string, unknown>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // Action-body call statement (Fix 3 / Fix 5).  Only reachable with
  // `inActionBody` set; `target: "action"` is a resolved sibling call, but a
  // `private-operation`/`function` fall-through inside a frontend action body
  // is a bare call that resolved to nothing local — there are no backend ops on
  // a UI surface, so it's an unresolved action reference.
  if (ctx.inActionBody && s.kind === "call") {
    const stmt = s as Extract<StmtIR, { kind: "call" }>;
    if (
      stmt.target !== "action" &&
      // A `<Store>.<action>()` call is a resolved cross-surface dispatch
      // (Stage 5) — not an unresolved sibling-action reference.
      stmt.target !== "store-action" &&
      !ctx.actionsByName.has(stmt.name) &&
      !ctx.functionNames.has(stmt.name) &&
      !VIEW_EFFECT_BUILTINS.has(stmt.name)
    ) {
      diags.push({
        severity: "error",
        code: "loom.unresolved-action-ref",
        message: diagMessage("loom.unresolved-action-ref#call-references-no-sibling", {
          where: ctx.where,
          name: stmt.name,
        }),
        source: ctx.where,
      });
    }
  }
  // Effect-form variant-`match` (async-actions-and-effects.md Stage 2): walk the
  // awaited subject (its `awaited` flag makes the effect-marker check accept it)
  // and recurse each arm / else body so nested calls are still checked.
  if (s.kind === "variant-match") {
    const vm = s as unknown as Extract<StmtIR, { kind: "variant-match" }>;
    checkBody(vm.subject, ctx, diags);
    for (const arm of vm.arms) for (const b of arm.body) checkStmt(b, ctx, diags);
    for (const b of vm.elseBody ?? []) checkStmt(b, ctx, diags);
    return;
  }
  for (const key of ["expr", "value"] as const) {
    const v = s[key];
    if (v && typeof v === "object" && "kind" in (v as object)) {
      checkBody(v as ExprIR, ctx, diags);
    }
  }
  if (Array.isArray(s.args)) {
    for (const a of s.args as ExprIR[]) checkBody(a, ctx, diags);
  }
  if (Array.isArray(s.fields)) {
    for (const f of s.fields as { value: ExprIR }[]) checkBody(f.value, ctx, diags);
  }
}

/** Effectful `StmtIR` kinds — a statement that mutates state, dispatches a
 *  command, or drives navigation.  A render-tree lambda body containing any of
 *  these is an inline effect handler and must become a named `action`; the pure
 *  kinds (`let` binding, trailing `expression`, `return`, `precondition`/
 *  `requires`) are legitimate inside a value lambda block. */
const EFFECT_STMT_TOKEN: Record<string, string> = {
  assign: ":=",
  add: "+=",
  remove: "-=",
  emit: "emit",
  call: "call",
  "variant-match": "match await",
};

/** `loom.effect-in-lambda` — reject an inline effect handler in a page/component
 *  body (`onClick: e => { count := count + 1 }`).  Named actions
 *  (named-actions-and-stores.md) are the only home for an effect; this makes the
 *  language uniform (one effect-handler form) and, for the MVU/Elmish study
 *  (`docs/old/proposals/fable-elmish-frontend.md` §8), keeps the `Model → Html` view
 *  pure so `Msg`/`update` project straight off the `ActionIR` list.  Fires only
 *  through `checkBody`'s `lambda` arm — an `action` body is walked via
 *  `checkActionBodies` and never reaches here, so effects there are untouched.
 *
 *  Scope: two arms, both raising `loom.effect-in-lambda`.
 *    1. Effect StmtIR kinds (`:=`/`+=`/`emit`/bare `call`/`match await`) + a
 *       single-expression view-effect (`navigate`/`toast`) call.
 *    2. A direct remote MUTATION reachable in the lambda body (`onClick: e => {
 *       X.create(v) }`).  This lowers to an `expression`-statement wrapping a
 *       `method-call` — a *pure* StmtIR kind the arm-1 token scan skips — so it
 *       needs its own detection (`firstMutatingCallInLambda`), reusing the same
 *       remote-write classifier as the action-body await-floor.  Closes the last
 *       inline-effect form so the MVU `Model → Html` view is pure BY
 *       CONSTRUCTION on every target (fable-elmish-frontend.md §2.2 / §8). */
function checkLambdaPurity(
  lambda: Extract<ExprIR, { kind: "lambda" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // Extern-component `action`-typed param callback — effects are legitimate and
  // walk in the caller's scope; the call arm marked it exempt.
  if (ctx.exemptLambdas.has(lambda)) return;
  const arrow = lambda.param ? `${lambda.param} => …` : `() => …`;
  // Arm 1 — effect StmtIR / view-effect.
  // Block form (`e => { count := count + 1 }`): any effectful StmtIR kind.
  // Single-expression form (`e => navigate("/x")`): a bare view-effect call
  // (`navigate`/`toast`) — the only effect an expression body can carry (a
  // value lambda's expression is a render/projection like `Text { … }`, not an
  // effect).  A `let`/trailing-expression block stays pure and is not flagged.
  const blockEffect = (lambda.block ?? []).find((s) => s.kind in EFFECT_STMT_TOKEN);
  const body = lambda.body;
  const singleExprEffect =
    body?.kind === "call" && body.callKind === "free" && VIEW_EFFECT_BUILTINS.has(body.name);
  const token = blockEffect
    ? EFFECT_STMT_TOKEN[blockEffect.kind]
    : singleExprEffect
      ? body.name
      : undefined;
  if (token) {
    diags.push({
      severity: "error",
      code: "loom.effect-in-lambda",
      message: diagMessage("loom.effect-in-lambda#effect", { where: ctx.where, arrow, token }),
      source: ctx.where,
    });
    return;
  }
  // Arm 2 — a direct remote mutation inline in the view (no effect StmtIR token,
  // so arm 1 missed it).  Reads (`.all`/`.byId`/finders) inside a value lambda
  // stay legal — only a mutating command is rejected.
  const mut = firstMutatingCallInLambda(lambda, ctx);
  if (!mut) return;
  diags.push({
    severity: "error",
    code: "loom.effect-in-lambda",
    message: diagMessage("loom.effect-in-lambda#remote-mutation", {
      where: ctx.where,
      arrow,
      aggName: mut.aggName,
      op: mut.op,
    }),
    source: ctx.where,
  });
}

/** F1 — flag an `Action(<inst>.<op>)` whose resolved public operation
 *  takes parameters (the walker drops them, emitting `mutateAsync({})`). */
function checkActionParams(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const arg0 = call.args[0];
  if (arg0?.kind !== "member") return;
  const recv = arg0.receiver;
  // The instance ref carries its declared aggregate type.
  if (recv.kind !== "ref" || recv.type?.kind !== "entity") return;
  const agg = ctx.aggByName.get(recv.type.name);
  if (!agg) return;
  const opName = arg0.member;
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) return;
  if (op.params.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.action-op-has-params",
      message: diagMessage("loom.action-op-has-params", {
        where: ctx.where,
        name: recv.name,
        opName,
        aggName: agg.name,
        length: op.params.length,
        params: op.params.map((p) => p.name).join(", "),
      }),
      source: ctx.where,
    });
  }
}

/** Value of a named arg on a primitive call (parallel `argNames`). */
function namedArg(call: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  const names = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (names[i] === name) return call.args[i];
  }
  return undefined;
}

/** Named-action payload conformance (named-actions-and-stores.md, Proposal A
 *  Stage 1).  A bare action reference in a handler slot must match (arity)
 *  what the call-site primitive supplies:
 *    - a Form with a two-way `into:` binding supplies NO value → the
 *      `onSubmit:` action must be NULLARY (arity-1 ⇒ hard error);
 *    - a Form WITHOUT `into:` supplies its value → the action should take one
 *      payload param (arity-0 ⇒ the supplied value has nowhere to land);
 *    - a Table `onRowClick:` supplies the clicked row → arity-0 or arity-1 are
 *      both admissible (the handler may ignore the row), so only an over-arity
 *      action is flagged.
 *  One stable code: `loom.action-payload-mismatch`. */
function checkActionPayload(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const flag = (handlerSlot: string, action: ActionIR, supplied: boolean): void => {
    const arity = action.params.length;
    if (supplied && arity === 0) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message: diagMessage("loom.action-payload-mismatch#supplies-a-payload-value", {
          where: ctx.where,
          name: call.name,
          handlerSlot,
          actionName: action.name,
        }),
        source: ctx.where,
      });
    } else if (!supplied && arity > 0) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message: diagMessage("loom.action-payload-mismatch#into-binding-arity", {
          where: ctx.where,
          name: call.name,
          handlerSlot,
          actionName: action.name,
          arity,
          params: action.params.map((p) => p.name).join(", "),
        }),
        source: ctx.where,
      });
    } else if (arity > 1) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message: diagMessage("loom.action-payload-mismatch#action-referenced-by-declares", {
          where: ctx.where,
          name: action.name,
          callName: call.name,
          handlerSlot,
          arity,
        }),
        source: ctx.where,
      });
    }
  };

  // Form family — `onSubmit:` action.  A two-way `into:` binding means the
  // form supplies no value to the handler (it mutates the bound state
  // directly), so the action must be nullary.
  const FORM_PRIMITIVES = new Set(["CreateForm", "Form", "WorkflowForm", "OperationForm"]);
  if (FORM_PRIMITIVES.has(call.name)) {
    const onSubmit = namedArg(call, "onSubmit");
    if (onSubmit?.kind === "action-ref") {
      const action = ctx.actionsByName.get(onSubmit.actionName);
      if (action) flag("onSubmit", action, namedArg(call, "into") === undefined);
    }
  }
  // Table — `onRowClick:` supplies the clicked row.  Over-arity is the only
  // hard error (a nullary handler may legitimately ignore the row).
  if (call.name === "Table") {
    const onRowClick = namedArg(call, "onRowClick");
    if (onRowClick?.kind === "action-ref") {
      const action = ctx.actionsByName.get(onRowClick.actionName);
      if (action && action.params.length > 1) flag("onRowClick", action, true);
    }
  }
}

/** The named-arg slots that bind a page/component action handler — a bare
 *  reference here is an `action-ref` when it resolves, or an unresolved ref
 *  when it names nothing (`src/generator/_walker/shared/args.ts:actionRefArg`,
 *  enumerated from the primitives' `actionRefArg(call, …)` slots). */
const ACTION_HANDLER_SLOTS = ["onClick", "onRowClick", "onSubmit"] as const;

/** Fix 3 (handler position) — a bare reference in an action-handler slot that
 *  lowered to an unresolved `unknown` ref names no sibling action (it would
 *  have lowered to an `action-ref`) and isn't a declared handle.  Flag it as an
 *  unresolved action reference rather than letting it render a dangling
 *  identifier. */
function checkHandlerSlotRefs(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  for (const slot of ACTION_HANDLER_SLOTS) {
    const arg = namedArg(call, slot);
    if (arg?.kind !== "ref" || arg.refKind !== "unknown") continue;
    if (
      ctx.actionsByName.has(arg.name) ||
      ctx.handles.has(arg.name) ||
      ctx.scope.has(arg.name) ||
      ctx.functionNames.has(arg.name)
    ) {
      continue;
    }
    diags.push({
      severity: "error",
      code: "loom.unresolved-action-ref",
      message: diagMessage("loom.unresolved-action-ref#references-which-is-not", {
        where: ctx.where,
        name: call.name,
        slot,
        argName: arg.name,
      }),
      source: ctx.where,
    });
  }
}

/** F2 — flag a method-call whose receiver root doesn't resolve to a known
 *  binding.  A clean receiver is anything except an `unknown`-rooted chain
 *  whose root is neither a ui api-handle nor an in-scope lambda / form
 *  shell-local. */
function checkMethodCallReceiver(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const root = rootRef(call.receiver);
  // The receiver root is well-resolved unless it's an `unknown` ref.
  if (root?.refKind !== "unknown") return;
  // `unknown` is fine when the root is a resolvable handle (api /
  // aggregate / workflow — `Sales.Customer.create(…)`, `Customer.byId(…)`,
  // `Views.x`) or an in-scope lambda param / form shell-local.
  if (ctx.handles.has(root.name) || ctx.scope.has(root.name)) return;
  diags.push({
    severity: "error",
    code: "loom.method-call-unresolved-receiver",
    message: diagMessage("loom.method-call-unresolved-receiver", {
      where: ctx.where,
      receiver: describeReceiver(call.receiver),
      member: call.member,
      name: root.name,
    }),
    source: ctx.where,
  });
}

/** F3 — `loom.ui-projection-read-unsupported`, the FLAVOUR half.
 *
 *  An unreadable `projection` read (`QueryView { of:
 *  <ApiHandle>.<Projection> }`) would otherwise emit
 *  `/* unresolved: <Handle> *␣/ undefined.<Projection>` — a runtime `TypeError`
 *  AND a build break, from a model with no diagnostic.  F2 above exempts an
 *  api-handle receiver root, correct for an aggregate (`Sales.Customer`), but
 *  that exemption lets a PROJECTION member through and nothing downstream
 *  resolves it.
 *
 *  Two flavours ARE readable and pass: the SINGLETON QUERY-TIME one (one object
 *  out — the dashboard KPI shape), and the GROUPED (`group by`) one, whose LIST
 *  response list-binds through `QueryView` exactly like a find-all (the
 *  query-shape derivation answers `single: false`, so the collection arms read
 *  `.length` of a real array) or feeds a `Chart`.  Every other flavour is
 *  rejected here, on every
 *  target: a KEYED projection returns an array parameterised by key, and a
 *  FOLDED one is read by key off its materialized row table.  Whether a
 *  *readable* projection's frontend has the client is a per-framework
 *  question with no platform in scope here — that is
 *  `validateUiProjectionReadFramework` (system-checks.ts). */
function checkProjectionRead(
  e: Extract<ExprIR, { kind: "member" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  if (!ctx.projectionNames.has(e.member)) return;
  // A readable projection is handled by the per-framework gate, not here.
  if (ctx.readableProjections.has(e.member)) return;
  // Only flag the read shape: the member names a projection AND the receiver is
  // a handle-rooted chain the walker will fail to resolve.  A same-named field
  // on a resolved receiver (`row.SalesTotals`) is not a projection read.
  const root = rootRef(e.receiver);
  if (root?.refKind !== "unknown") return;
  if (!ctx.handles.has(root.name)) return;
  diags.push({
    severity: "error",
    code: "loom.ui-projection-read-unsupported",
    message: diagMessage("loom.ui-projection-read-unsupported#not-ui-consumable", {
      where: ctx.where,
      member: e.member,
      name: root.name,
    }),
    source: ctx.where,
  });
}

/** `loom.missing-effect-marker` (async-actions-and-effects.md Stage 2, was
 *  `loom.action-requires-await`).  A BARE (unmarked) call in action-body
 *  position that lowers to a REMOTE, MUTATING backend command
 *  (`Sales.Order.placeOrder(o)` / `Order.placeOrder(o)`) has an invisible async
 *  boundary — it must be `await`-marked so its `Result` is handled by a
 *  `match`.  Stage 2b makes this an ERROR (was a warning during the Stage-2
 *  ramp; the corpus carried zero unmarked sites at flip time, so no codemod was
 *  needed); an `await`-marked call (the awaited subject of a variant-`match`) is
 *  ACCEPTED and skipped here.  CONSERVATIVE — only flags
 *  a `method-call` we can positively identify as an aggregate-rooted mutating
 *  command:
 *    Pattern E:  `Order.placeOrder(o)`         — `method-call(ref:<Aggregate>, op)`
 *    Pattern B:  `api.Order.placeOrder(o)`     — `method-call(member(ref:apiParam, agg), op)`
 *  whose `op` resolves to a public mutate-kind operation (or a create/destroy)
 *  on the aggregate.  Reads (`byId`, finders), sibling-action calls, pure
 *  helpers, and view-effects (`navigate`/`toast`) are deliberately NOT flagged
 *  (the await-floor boundary — see the report). */
function checkMissingEffectMarker(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // An `await`-marked call (the subject of a `match await <op>() { … }`) is the
  // explicit, handled form — accept it (async-actions-and-effects.md Stage 2).
  if (call.awaited) return;
  const m = mutatingAggCommand(call, ctx);
  if (!m) return;
  diags.push({
    severity: "error",
    code: "loom.missing-effect-marker",
    message: diagMessage("loom.missing-effect-marker", {
      where: ctx.where,
      aggName: m.aggName,
      op: m.op,
    }),
    source: ctx.where,
  });
}

/** Classify a `method-call` as a REMOTE, MUTATING aggregate command
 *  (`Order.placeOrder(o)` / `api.Order.placeOrder(o)`) — the one shape both the
 *  action-body await-floor (`checkMissingEffectMarker`) and the render-tree
 *  lambda-purity gate (`checkLambdaPurity`, the api-mutation arm) must reject.
 *  Returns the aggregate + op when the receiver resolves to an aggregate (bare
 *  Pattern E, or api-handle-rooted Pattern B) and `op` is a public operation /
 *  create / destroy; `undefined` for reads (`byId`, finders), non-aggregate
 *  receivers, and view-effects.  Shared so the two gates classify identically —
 *  a single source of truth for "this is a remote write". */
function mutatingAggCommand(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
): { aggName: string; op: string } | undefined {
  let aggName: string | undefined;
  // Pattern E: receiver is a bare aggregate ref.
  if (call.receiver.kind === "ref" && ctx.aggByName.has(call.receiver.name)) {
    aggName = call.receiver.name;
  }
  // Pattern B: receiver is `apiParam.Aggregate` (member rooted at an api handle).
  else if (
    call.receiver.kind === "member" &&
    call.receiver.receiver.kind === "ref" &&
    ctx.handles.has(call.receiver.receiver.name) &&
    ctx.aggByName.has(call.receiver.member)
  ) {
    aggName = call.receiver.member;
  }
  if (!aggName) return undefined;
  const agg = ctx.aggByName.get(aggName);
  if (!agg) return undefined;
  const op = call.member;
  const isMutating =
    agg.operations.some((o) => o.name === op && o.visibility === "public") ||
    (agg.creates ?? []).some((o) => o.name === op) ||
    (agg.destroys ?? []).some((o) => o.name === op);
  return isMutating ? { aggName, op } : undefined;
}

/** The first REMOTE MUTATING aggregate command reachable anywhere inside a
 *  render-tree lambda's body/block — WITHOUT descending into nested lambdas
 *  (each is checked by its own `checkLambdaPurity` pass, so recursing here would
 *  double-report).  Drives the api-mutation arm of `loom.effect-in-lambda`: a
 *  bare `onClick: e => { X.create(v) }` inline handler performs a remote write in
 *  the view, so it must move to a named `action` (awaited + Result-matched).
 *  The AWAITED form (`match await X.create(v)`) is a `variant-match` StmtIR
 *  already caught by the effect-token scan, so the caller only reaches here for
 *  lambdas that carry no effect StmtIR at all. */
function firstMutatingCallInLambda(
  lambda: Extract<ExprIR, { kind: "lambda" }>,
  ctx: BodyCheckCtx,
): { aggName: string; op: string } | undefined {
  let found: { aggName: string; op: string } | undefined;
  const visitExpr = (e: ExprIR | undefined): void => {
    if (!e || found) return;
    switch (e.kind) {
      case "method-call": {
        const m = mutatingAggCommand(e, ctx);
        if (m) {
          found = m;
          return;
        }
        visitExpr(e.receiver);
        for (const a of e.args) visitExpr(a);
        return;
      }
      case "call":
        for (const a of e.args) visitExpr(a);
        return;
      case "member":
        visitExpr(e.receiver);
        return;
      case "binary":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "unary":
        visitExpr(e.operand);
        return;
      case "paren":
        visitExpr(e.inner);
        return;
      case "ternary":
        visitExpr(e.cond);
        visitExpr(e.then);
        visitExpr(e.otherwise);
        return;
      case "convert":
        visitExpr(e.value);
        return;
      case "list":
        for (const el of e.elements) visitExpr(el);
        return;
      case "match":
        for (const arm of e.arms) {
          visitExpr(arm.cond);
          visitExpr(arm.value);
        }
        visitExpr(e.otherwise);
        return;
      case "new":
      case "object":
        for (const f of e.fields) visitExpr(f.value);
        return;
      // "lambda" is intentionally NOT descended — a nested lambda self-checks.
      default:
        return;
    }
  };
  const visitStmt = (s: StmtIR): void => {
    if (found) return;
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        visitExpr(s.expr);
        return;
      case "assign":
      case "add":
      case "remove":
        visitExpr(s.value);
        return;
      case "emit":
        for (const f of s.fields) visitExpr(f.value);
        return;
      case "call":
        for (const a of s.args) visitExpr(a);
        return;
      case "return":
        visitExpr(s.value);
        return;
      case "variant-match":
        visitExpr(s.subject);
        for (const arm of s.arms) for (const b of arm.body) visitStmt(b);
        for (const b of s.elseBody ?? []) visitStmt(b);
        return;
      default:
        return;
    }
  };
  visitExpr(lambda.body);
  for (const s of lambda.block ?? []) visitStmt(s);
  return found;
}

/** The deepest root ref of a member / method-call receiver chain. */
function rootRef(e: ExprIR): Extract<ExprIR, { kind: "ref" }> | undefined {
  let cur: ExprIR = e;
  for (;;) {
    if (cur.kind === "ref") return cur;
    if (cur.kind === "member") cur = cur.receiver;
    else if (cur.kind === "method-call") cur = cur.receiver;
    else if (cur.kind === "paren") cur = cur.inner;
    else return undefined;
  }
}

/** Best-effort dotted description of a receiver chain for the diagnostic. */
function describeReceiver(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "member") return `${describeReceiver(e.receiver)}.${e.member}`;
  if (e.kind === "method-call") return `${describeReceiver(e.receiver)}.${e.member}(…)`;
  if (e.kind === "paren") return describeReceiver(e.inner);
  return "<expr>";
}

// -------------------------------------------------------------------------
// PAGE EMIT IDENTITY — `loom.ui-page-path-collision` /
// `loom.ui-page-slot-collision`.
//
// A page's identity is its `area` path + name, which lowering has already
// resolved into `emitPath`.  Two pages that resolve to the SAME emit path, or
// that fill the SAME conventional archetype slot, are indistinguishable to
// every downstream emitter — and every emitter resolved that the same silent
// way: last write wins on the file map, first write wins on the page-object
// map.  A duplicated `area Ops { … }` block in one scope parses clean
// (`checkPageScope` scopes page uniqueness per area NODE, not per area NAME),
// both areas compute `src/pages/ops/…`, and one page's body simply vanishes
// from the build with no diagnostic anywhere.
//
// Checking it HERE, on `emitPath`, covers every frontend at once (React, Vue,
// Svelte, Angular, Feliz, Flutter and Phoenix all key their emission on the
// same derivation) rather than seven per-frontend guards that each catch their
// own topology's half of the problem.
// -------------------------------------------------------------------------

export function validateUiPageIdentity(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const nameCtx = {
    aggregateNames: allContexts(loom).flatMap((c) => c.aggregates.map((a) => a.name)),
    workflowNames: allContexts(loom).flatMap((c) => c.workflows.map((w) => w.name)),
  };
  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      const byPath = new Map<string, PageIR>();
      const bySlot = new Map<string, PageIR>();
      for (const page of ui.pages) {
        const path = page.emitPath;
        if (path !== undefined) {
          const prior = byPath.get(path);
          if (prior) {
            diags.push({
              severity: "error",
              message: diagMessage("loom.ui-page-path-collision", {
                ui: ui.name,
                first: pageLabel(prior),
                second: pageLabel(page),
                path,
              }),
              source: sys.name,
              code: "loom.ui-page-path-collision",
            });
          } else {
            byPath.set(path, page);
          }
        }
        const slot = pageSlotKey(classifyPage(page, nameCtx));
        if (slot === undefined) continue;
        const priorSlot = bySlot.get(slot);
        if (priorSlot) {
          diags.push({
            severity: "error",
            message: diagMessage("loom.ui-page-slot-collision", {
              ui: ui.name,
              first: pageLabel(priorSlot),
              second: pageLabel(page),
              slot: slotLabel(slot),
            }),
            source: sys.name,
            code: "loom.ui-page-slot-collision",
          });
        } else {
          bySlot.set(slot, page);
        }
      }
    }
  }
}

/** `page 'List'` / `page 'List' (in area ops/orders)` — enough for the author
 *  to find which of the two declarations to change. */
function pageLabel(p: PageIR): string {
  const area = p.area ?? [];
  return area.length === 0 ? `page '${p.name}'` : `page '${p.name}' in area ${area.join("/")}`;
}

/** Human name for a conventional archetype slot key. */
function slotLabel(slot: string): string {
  const parts = slot.split(":");
  if (parts[0] === "agg") return `the ${parts[2]} page of aggregate '${parts[1]}'`;
  if (parts[0] === "wf") return `the ${parts[2]} page of workflow '${parts[1]}'`;
  return `the '${slot}' page`;
}

// -------------------------------------------------------------------------
// `loom.user-component-deferred-target` — a user `component` whose SHAPE the
// Feliz / Angular component emitter defers.
//
// THE SILENT VANISH.  Both emitters build their emitted set by FILTERING:
// `emitFelizUserComponents` / `emitAngularUserComponents` keep only the
// components whose walked shape their shell can assemble, and a filtered
// component is not merely degraded — it is not emitted AT ALL.  Its name never
// enters the walker's `userComponents` map either, so every call site falls
// through to `walk()`'s give-up comment (`(* unknown layout component: X *)` /
// `<!-- unknown layout component: X -->`).  Declaration and use disappear
// together: `ddd parse` clean, codegen clean, `dotnet fable` / `ng build`
// clean, and the component is simply not in the app.
//
// The two emitters gate their OWN async-effect shape honestly already
// (`loom.feliz-async-effect-unsupported`, `loom.flutter-async-effect-
// unsupported` for the Flutter twin) — every other filtered shape was silent.
//
// EACH ARM MIRRORS A FILTER, and says which.  The arms below were not read off
// the emitter source alone: every one was MEASURED on this HEAD by generating
// the shape and confirming the `unknown layout component` sentinel appears (and
// the companion negative shapes confirming it does not) — see
// `test/ir/user-component-deferred.test.ts`, which re-asserts both halves so an
// arm cannot outlive the filter it mirrors.
//
// NOT mirrored, deliberately:
//   • `component-emit.ts`'s `derivedNeedsPageScope` `currentUser` leg and its
//     `emittedRecords` param check.  The first does not reproduce (a `derived`
//     reading `currentUser` emits fine today, measured); the second is a
//     function of which wire RECORDS App.fs happens to emit — a generator-side
//     fact the IR cannot derive without re-running the read collector.
//   • the Feliz `needsMvuScope` backstop (a surviving bare `model`/`dispatch`
//     in the rendered F#).  It is a scan of GENERATED text, not a shape.
//   • an async-effect action on either frontend — already gated (see above).
// -------------------------------------------------------------------------

/** Frameworks whose component emitter FILTERS its emitted set.  Keyed by the
 *  resolved ui framework, which is what actually renders (`ui.framework` wins
 *  over the deployable's platform-derived default — a `platform: static` host
 *  serves whichever bundle the ui declares). */
const COMPONENT_FILTERING_FRAMEWORKS = new Set(["feliz", "angular"]);

/** One deferral: what the emitter filtered on, in the emitter's own terms. */
interface ComponentDeferral {
  reason: string;
  /** The emitter site this arm mirrors — quoted in the diagnostic so the next
   *  reader can check the arm against the filter rather than trusting it. */
  emitter: string;
}

/** Lookups the deferral arms need — the ui's api handles plus the domain
 *  vocabulary the api-read patterns resolve against. */
interface DeferCtx {
  aggByName: ReadonlyMap<string, AggregateIR>;
  apiParamNames: ReadonlySet<string>;
  aggNames: ReadonlySet<string>;
  /** aggregate name → its repository's user finds, by name.  A read that
   *  resolves to one is hoisted as a REACTIVE query on Angular (its args are
   *  re-read lazily), which is what exempts it from the input-fed-read arm. */
  findsByAggregate: ReadonlyMap<string, ReadonlyMap<string, FindIR>>;
}

/** The api read a walked expression denotes, mirroring the walker's
 *  `tryDetectApiHook` patterns A/B (`<handle>.<Agg>.<op>`) and D/E
 *  (`<Agg>.<op>`, no handle) — the aggregate-rooted ones, which are the only
 *  patterns the arms below key on.  Returns `undefined` for anything else. */
function detectAggregateRead(
  e: ExprIR,
  ctx: DeferCtx,
): { aggregate: string; operation: string; args: readonly ExprIR[] } | undefined {
  if (e.kind === "member" && e.receiver.kind === "member") {
    const inner = e.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return { aggregate: inner.member, operation: e.member, args: [] };
    }
  }
  if (e.kind === "method-call" && e.receiver.kind === "member") {
    const inner = e.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return { aggregate: inner.member, operation: e.member, args: e.args };
    }
  }
  if (e.kind === "member" && e.receiver.kind === "ref" && ctx.aggNames.has(e.receiver.name)) {
    return { aggregate: e.receiver.name, operation: e.member, args: [] };
  }
  if (e.kind === "method-call" && e.receiver.kind === "ref" && ctx.aggNames.has(e.receiver.name)) {
    return { aggregate: e.receiver.name, operation: e.member, args: e.args };
  }
  return undefined;
}

/** The walker's standard aggregate operations (`walker-core.ts`
 *  `STANDARD_AGG_OPS`) — the ops whose hook args are NOT rewritten into a
 *  reactive query bag. */
const STANDARD_AGG_OPS: ReadonlySet<string> = new Set([
  "all",
  "byId",
  "create",
  "update",
  "delete",
]);

/** True when a read is hoisted as a REACTIVE query — a user `find`, or a
 *  paged `all`, whose rendered args become a query bag the query re-reads
 *  (`adjustFindHookArgs` in `src/generator/_walker/walker-core.ts`).  Such a
 *  read is exempt from the Angular input-fed-read filter: its args are wrapped
 *  in a `() => (…)`, so an `@Input()` is read lazily rather than in the
 *  constructor. */
function isReactiveQueryRead(aggregate: string, operation: string, ctx: DeferCtx): boolean {
  const find = ctx.findsByAggregate.get(aggregate)?.get(operation);
  if (!find) return false;
  const paged = pagedReturn(find.returnType) !== null;
  return !STANDARD_AGG_OPS.has(operation) || paged;
}

/** Names read by an expression — every `ref`, at any depth.  Used to ask
 *  whether a read's ARGUMENT reaches for a component parameter, which is what
 *  the Angular filter asks of the RENDERED argument text. */
function refNamesIn(e: ExprIR): Set<string> {
  const out = new Set<string>();
  walkExprDeep(e, (x) => {
    if (x.kind === "ref") out.add(x.name);
  });
  return out;
}

/** True when the expression tree reaches for the magic route `id`
 *  (`{ kind: "id" }` — what `walker-core.ts` sets `ctx.usesRouteId` on). */
function readsRouteId(e: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(e, (x) => {
    if (x.kind === "id") found = true;
  });
  return found;
}

/** Params the Feliz / Angular props layer has no spelling for. */
function paramDeferrals(c: ComponentIR, framework: string): ComponentDeferral[] {
  const out: ComponentDeferral[] = [];
  for (const p of c.params) {
    const inner = p.type.kind === "optional" ? p.type.inner : p.type;
    if (inner.kind === "slot") {
      out.push({
        reason: `parameter '${p.name}' is a \`slot\``,
        emitter:
          framework === "feliz"
            ? "src/generator/feliz/component-emit.ts `propType` — a slot has no props-record spelling"
            : "src/generator/angular/components-emit.ts `hasSlotOrActionParam` — `ngComponentOutletInputs` sets INPUTS and has no content-projection channel",
      });
    } else if (inner.kind === "action") {
      out.push({
        reason: `parameter '${p.name}' is an \`action\` callback`,
        emitter:
          framework === "feliz"
            ? "src/generator/feliz/component-emit.ts `propType` — an action has no props-record spelling"
            : "src/generator/angular/components-emit.ts `hasSlotOrActionParam` — a callback through the inputs object loses `this`",
      });
    } else if (framework === "feliz" && p.type.kind === "optional") {
      out.push({
        reason: `parameter '${p.name}' is optional`,
        emitter:
          "src/generator/feliz/component-emit.ts `propType` — an F# anonymous record is EXACT, so a call site omitting the field would not typecheck",
      });
    }
  }
  return out;
}

/** The Feliz filters, in `component-emit.ts` order: the `isCandidate` param /
 *  derived gates, then the post-walk `renderOne` gates. */
function felizDeferrals(c: ComponentIR, ctx: DeferCtx): ComponentDeferral[] {
  const out = [...paramDeferrals(c, "feliz")];
  // `isCandidate` → `derivedNeedsPageScope`: the route `id` is bound by a PAGE
  // view fn, not by a component function.
  for (const d of c.derived) {
    if (readsRouteId(d.expr)) {
      out.push({
        reason: `\`derived ${d.name}\` reads the route \`id\`, which only a PAGE view binds`,
        emitter: "src/generator/feliz/component-emit.ts `derivedNeedsPageScope`",
      });
    }
  }
  // `renderOne` → `result.usesRouteId`.  Three body shapes set it: an explicit
  // `id`, and the two primitives the Feliz target forks onto a dispatch that
  // carries the route id (`felizTarget.renderAction` / `renderDestroyForm` both
  // set `ctx.usesRouteId = true` before returning their F#).
  const routeIdCauses: string[] = [];
  walkExprDeep(c.body, (e) => {
    if (e.kind === "id") routeIdCauses.push("reads the route `id`");
    if (e.kind !== "call") return;
    if (e.name === "DestroyForm") {
      const ofIdx = (e.argNames ?? []).indexOf("of");
      const ofArg = ofIdx >= 0 ? e.args[ofIdx] : undefined;
      if (ofArg?.kind === "ref") {
        routeIdCauses.push("renders `DestroyForm`, which deletes the record at the route `id`");
      }
    }
    if (e.name === "Action") {
      // `felizTarget.renderAction` resolves the receiver through the walk's
      // aggregate-typed params and requires a PARAMETERLESS public op; anything
      // else renders a comment instead (and never touches `usesRouteId`).
      const argNames = e.argNames ?? [];
      const opRef = (e.args ?? []).find((_, i) => !argNames[i]);
      if (opRef?.kind !== "member" || opRef.receiver.kind !== "ref") return;
      const paramType = c.params.find(
        (p) => p.name === (opRef.receiver as { name: string }).name,
      )?.type;
      const aggName = paramType?.kind === "entity" ? paramType.name : undefined;
      const agg = aggName ? ctx.aggByName.get(aggName) : undefined;
      const op = agg?.operations.find(
        (o) => o.name === opRef.member && o.visibility === "public" && o.params.length === 0,
      );
      if (op) {
        routeIdCauses.push(
          `renders \`Action { ${opRef.receiver.name}.${opRef.member} }\`, which dispatches with the route \`id\``,
        );
      }
    }
  });
  for (const cause of [...new Set(routeIdCauses)]) {
    out.push({
      reason: `its body ${cause} — a component function has no route of its own`,
      emitter:
        "src/generator/feliz/component-emit.ts `renderOne` (`result.usesRouteId`); the route `id` is bound by a page view fn",
    });
  }
  // `renderOne` → `(result.usedStores?.size ?? 0) > 0`.
  const stores = new Set<string>();
  walkExprDeep(c.body, (e) => {
    if (e.kind === "ref" && e.refKind === "store-field" && e.storeName) stores.add(e.storeName);
    if (e.kind === "call" && e.storeAction) stores.add(e.storeAction.store);
    if (e.kind === "action-ref" && e.storeName) stores.add(e.storeName);
  });
  for (const store of [...stores].sort()) {
    out.push({
      reason: `its body reads store '${store}'`,
      emitter: "src/generator/feliz/component-emit.ts `renderOne` (`result.usedStores`)",
    });
  }
  // `renderOne` → `needsMvuScope`: a `byId` read renders `model.<Agg>ById`, a
  // Model field `collectComponentReads` deliberately does NOT declare (its
  // fetch is fired by `pageCmd` on ROUTE entry, keyed to the hosting page's
  // `Page` case — which a component has none of).
  const byIdAggs = new Set<string>();
  walkExprDeep(c.body, (e) => {
    const read = detectAggregateRead(e, ctx);
    if (read?.operation === "byId") byIdAggs.add(read.aggregate);
  });
  for (const agg of [...byIdAggs].sort()) {
    out.push({
      reason: `its body issues a \`${agg}.byId(…)\` read, whose fetch a PAGE fires on route entry`,
      emitter:
        "src/generator/feliz/wire.ts `collectBodyReads` (a component passes no `pageCase`, so no Model field is declared) + `component-emit.ts` `needsMvuScope`",
    });
  }
  return out;
}

/** The Angular filters, in `components-emit.ts` order. */
function angularDeferrals(c: ComponentIR, ctx: DeferCtx): ComponentDeferral[] {
  const out = [...paramDeferrals(c, "angular")];
  // `renderOne` → the input-fed-read guard.  The page shell hoists an api read
  // as a class FIELD initializer, which runs in the constructor — before
  // Angular has set any `@Input()` — so the read would fire on `undefined`.
  // A REACTIVE query is exempt: a user `find`'s args are wrapped in a
  // `() => (…)` the query re-reads, so the input is read lazily.
  const inputNames = new Set(c.params.map((p) => p.name));
  const seen = new Set<string>();
  walkExprDeep(c.body, (e) => {
    const read = detectAggregateRead(e, ctx);
    if (!read || read.args.length === 0) return;
    if (isReactiveQueryRead(read.aggregate, read.operation, ctx)) return;
    const fed = read.args.flatMap((a) => [...refNamesIn(a)]).filter((n) => inputNames.has(n));
    if (fed.length === 0) return;
    const key = `${read.aggregate}.${read.operation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      reason:
        `its body issues a \`${key}(…)\` read whose argument reads the \`@Input()\` ` +
        `'${fed[0]}' — the hoisted read runs in the constructor, before Angular sets inputs`,
      emitter: "src/generator/angular/components-emit.ts `renderOne` (the `readsAnInput` guard)",
    });
  });
  return out;
}

/** Raise one diagnostic per (component, deferred shape) for every ui rendered
 *  by a filtering frontend. */
function checkUserComponentSupport(
  ui: UiIR,
  framework: string,
  dName: string,
  ctx: DeferCtx,
  diags: LoomDiagnostic[],
): void {
  for (const c of ui.components) {
    // An `extern` component is a hand-written shim the emitter always wires,
    // and a bodyless one has nothing to walk.
    if (c.extern || c.body === undefined) continue;
    const deferrals = framework === "feliz" ? felizDeferrals(c, ctx) : angularDeferrals(c, ctx);
    for (const d of deferrals) {
      diags.push({
        severity: "error",
        code: "loom.user-component-deferred-target",
        message: diagMessage("loom.user-component-deferred-target", {
          name: c.name,
          uiName: ui.name,
          framework,
          dName,
          reason: d.reason,
          emitter: d.emitter,
        }),
        source: `component '${c.name}'`,
      });
    }
  }
}

// -------------------------------------------------------------------------
// `loom.toast-message-unsupported` — an `on <chan>.<Event>(e) { toast(<expr>) }`
// message expression outside the v1 subset every realtime renderer implements.
//
// THE SILENT CRASH.  The AST validator (`checkUiNotification`,
// `src/language/validators/ui.ts`) bounds the handler STATEMENT vocabulary —
// `toast(<one expression>)` / `refetch(<Agg>…)` — but accepts ANY expression
// inside the `toast(…)`.  All three renderers then implement the SAME narrow
// v1 subset and `throw` on anything else:
//
//   src/generator/_frontend/realtime.ts   `renderMessageExpr`      (React/Vue/Svelte/Angular)
//   src/generator/feliz/realtime.ts       `renderFsToastMessage`   (Feliz)
//   src/generator/elixir/realtime-liveview.ts `renderMessageExprElixir` (LiveView)
//
// so `toast(e.order.id)` / `toast(x ? "a" : "b")` / `toast(string(e.at))` parses
// and validates, then aborts `ddd generate system` with a raw `Error` and a
// stack trace — no `loom.*` code, no source location.  Measured on this HEAD
// for all three renderers.  This check makes the throw a defensive backstop.
//
// The gate is the INTERSECTION of the three, which is also their union: the
// three `switch`es are arm-for-arm identical (literal / the event binding /
// single-level member off it / paren / binary), so one target-agnostic rule
// covers every frontend rather than three per-framework arms.
// -------------------------------------------------------------------------

/** Why `e` is outside the toast subset, or `undefined` when it is inside.
 *  Mirrors the three renderers' `switch` arms exactly. */
function toastMessageProblem(
  e: ExprIR,
  bind: string,
): { kind: string; detail: string } | undefined {
  switch (e.kind) {
    case "literal":
      return undefined;
    case "ref":
      return e.name === bind
        ? undefined
        : {
            kind: "ref",
            detail:
              `reads '${e.name}', which is not in scope — only the handler's event ` +
              `binding '${bind}' is`,
          };
    case "member":
      if (e.receiver.kind === "ref" && e.receiver.name === bind) return undefined;
      return {
        kind: "member",
        detail:
          `reads \`${describeReceiver(e)}\` — a toast message admits SINGLE-LEVEL member ` +
          `access off the event binding '${bind}' only`,
      };
    case "paren":
      return toastMessageProblem(e.inner, bind);
    case "binary":
      return toastMessageProblem(e.left, bind) ?? toastMessageProblem(e.right, bind);
    default:
      return {
        kind: e.kind,
        detail: `uses a \`${e.kind}\` expression`,
      };
  }
}

function checkToastMessages(ui: UiIR, diags: LoomDiagnostic[]): void {
  for (const n of ui.notifications ?? []) {
    const where = `ui '${ui.name}': \`on ${n.paramName}.${n.eventType}\` handler`;
    for (const t of n.toasts) {
      const problem = toastMessageProblem(t, n.bind);
      if (!problem) continue;
      diags.push({
        severity: "error",
        code: "loom.toast-message-unsupported",
        message: diagMessage("loom.toast-message-unsupported", {
          where,
          kind: problem.kind,
          detail: problem.detail,
        }),
        source: where,
      });
    }
  }
}
