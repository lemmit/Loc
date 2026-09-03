// -------------------------------------------------------------------------
// UI page-body checks — `validateUiBodies` orchestrator.  Packet 2.6
// (wave-2) split the former 3.0k-line monolith's private per-primitive
// check helpers into the per-theme leaves below (plus a small `ui-checks-
// shared.ts` hub for the handful of helpers used across more than one
// theme); every name this module exported before the split is still
// exported from here (either defined in place or re-exported), so
// `from "./checks/ui-checks.js"` call sites (validate.ts, tests) needed no
// edits.  `validateUiBodies` itself stays here — it IS the orchestrator,
// dispatching into every leaf below, the ui-theme analogue of
// `validate.ts`'s `validateLoomModel`.
// -------------------------------------------------------------------------

export {
  CONTROLLED_MODAL_OP_FORM_FRAMEWORKS,
  TABLE_FILTER_FRAMEWORKS,
} from "./ui-collection-display-checks.js";
export { validateUiPageIdentity } from "./ui-page-identity-checks.js";

import type { AggregateIR, EnrichedLoomModel, FindIR, ProjectionIR } from "../../types/loom-ir.js";
import { allAggregates, allContexts } from "../../types/loom-ir.js";
import { classifyPage } from "../../util/page-kind.js";
import { groupedProjectionNames, readableProjectionNames } from "../../util/projection-read.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import {
  type BodyCheckCtx,
  checkActionBodies,
  checkBody,
  checkToastMessages,
} from "./ui-action-body-checks.js";
import {
  checkChartArgs,
  checkControlledModalOpForm,
  checkDataGridSelection,
  checkFixedSlotArity,
  checkFrontendCollectionOps,
  checkPrimitiveNamedArgs,
  checkTableFilterSupport,
} from "./ui-collection-display-checks.js";
import { checkUserComponentSupport } from "./ui-component-deferral-checks.js";
import {
  type CallableNames,
  checkAsyncEffectArgs,
  checkInstanceEffectRouteId,
  checkOpFormRouteId,
  checkScaffoldFilterParams,
  checkSlotOutsideComponent,
  checkSubPrimitivePlacement,
  checkUnknownPageElements,
  checkUnresolvedPageRefs,
  pageWhere,
} from "./ui-page-structure-checks.js";

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
        checkOpFormRouteId(page, diags);
        checkFrontendCollectionOps(page, pageWhere(page), mapRendered, diags);
        checkUnknownPageElements(page, pageWhere(page), callableNames, diags);
        checkSlotOutsideComponent(page, pageWhere(page), diags);
        checkUnresolvedPageRefs(page, pageWhere(page), callableNames, diags);
        checkFixedSlotArity(page, pageWhere(page), diags);
        checkPrimitiveNamedArgs(page, pageWhere(page), diags);
        // The scaffolded list page is the only one whose filter bar the macro
        // builds, so the drop is only reportable there.
        const pageKind = classifyPage(page, {
          aggregateNames: [...aggNames],
          workflowNames: [...workflowNames],
        });
        if (pageKind.kind === "aggregate-list") {
          checkScaffoldFilterParams(
            page,
            pageKind.aggregateName,
            findsByAggregate.get(pageKind.aggregateName),
            pageWhere(page),
            diags,
          );
        }
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
        checkPrimitiveNamedArgs(comp, `component '${comp.name}'`, diags);
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

/** …with ONE framework carved out.  The walker has no `exprLambda` seam: a
 *  `.map(λ)` falls through to `<recv>.map(<args>)` with a hardcoded JS arrow
 *  (`(x) => …`).  That is real code on React/Vue/Svelte/Angular, valid Dart on
 *  Flutter, and HEEx routes it through its own engine — but on FELIZ it emits
 *  verbatim JS into an F# file, which `dotnet fable` rejects.  So `map` keeps
 *  its exemption everywhere except Feliz, where it joins the gated ops rather
 *  than shipping unbuildable output.  Delete this carve-out when the walker
 *  grows a lambda seam and `feliz-target.ts` renders `List.map`. */

const MAP_UNRENDERED_FRAMEWORK = "feliz";

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
