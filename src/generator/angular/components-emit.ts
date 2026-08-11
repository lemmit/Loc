// User (non-`extern`) frontend components — Angular flavour.
//
// A `component TierBadge(label: string, level: int) { body: … }` in the ui DSL
// is a REUSABLE walked region: react emits `src/components/<Name>.tsx`, vue a
// `.vue`, svelte a `.svelte`, flutter a widget in `lib/components.dart`.  Angular
// emitted NOTHING — only the `extern` flavour was wired — so the name never
// entered the walker's `userComponents` map and every use site fell through to
// `walk()`'s `<!-- unknown layout component: TierBadge -->` give-up comment.
// Declaration and use vanished together (the last two rows of the
// `KNOWN_DEGRADATIONS` ratchet in `test/generator/_walker/render-degradation.test.ts`).
//
// WHAT IS EMITTED
// ---------------
// One standalone component class per walked component, at
// `src/app/components/<Name>.ts`, assembled by the SAME shell that assembles a
// page (`renderAngularPage` in `walker/page-shell.ts`, in `componentMode`).  That
// reuse is the whole design: state → `signal()`, `derived` → `computed()`, named
// `action`s → methods, api reads → hoisted `inject()`-ed query fields, forms →
// Reactive `FormGroup`s, i18n / format-helper / `Decimal` member lifts — a
// component gets every one of them because the page shell already does, instead
// of a second half-featured assembler drifting alongside it.
//
// `src/app/components/` (not react's `src/components/`) is deliberate: it is a
// SIBLING of `src/app/pages/`, so every relative path the shell bakes in
// (`../../api/…`, `../../lib/format`, `../stores/…`, `../auth/session.service`)
// resolves identically from a component file and a page file.  It is also where
// the hoisted `DataGrid` child already lives (`<kebab>.component.ts` — no name
// collision with a PascalCase `<Name>.ts`).
//
// HOW A CALL SITE RESOLVES
// ------------------------
// Unchanged from the extern path: `angularTarget.renderUserComponent` renders
// `<ng-container [ngComponentOutlet]="TierBadge" [ngComponentOutletInputs]="…">`
// and the shell imports the class + re-exposes it as a member + registers
// `NgComponentOutlet`.  Angular has no PascalCase element tag, and the outlet is
// selector-free, so one call form covers both flavours; only the IMPORT PATH
// differs (a walked component is a sibling under `src/app/`, an extern shim sits
// at `src/components/`), which the shell resolves from `walkedComponents`.
//
// DEFERRED SHAPES (excluded from the emitted set, so a call site keeps the
// existing comment rather than emitting a dangling reference):
//   • a `slot` param / children — `ngComponentOutletInputs` sets INPUTS; it has
//     no content-projection channel, so a slot has nowhere to land.
//   • an `action(T)` param — the callback would arrive as an unbound method
//     reference through the inputs object, losing `this` at the call.
//   • a body that records onto the shared React-shaped form/mutation sinks
//     (`pageNeedsDeferredFeatures`) — the same guard that stubs such a PAGE.
//   • an api read whose ARG reads an `@Input()` — the shell hoists a read as a
//     class-field initializer, which runs before Angular sets inputs (see
//     `renderOne`).  An arg-less read and a reactive find are unaffected.

import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  PageIR,
  ParamIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";
import { walkBody } from "../_walker/walker-core.js";
import { angularTarget } from "./walker/angular-target.js";
import {
  type AngularComponentMode,
  pageNeedsDeferredFeatures,
  renderAngularPage,
} from "./walker/page-shell.js";

/** Everything a component walk needs — the same lookups the page walk threads
 *  (`generateAngularForContexts` assembles them once and passes them here). */
export interface AngularComponentCtx {
  pack: LoadedPack;
  apiParams: readonly UiApiParamIR[];
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  bcByWorkflow: ReadonlyMap<string, BoundedContextIR>;
  /** Page name → route, so an `Action`'s `then: navigate(<Page>)` resolves. */
  pageRoutes: ReadonlyMap<string, string>;
  /** Extern frontend function names declared on this ui. */
  externFunctions: ReadonlySet<string>;
  /** True when the hosting deployable has `auth: ui` — a component is the
   *  canonical `Action(<inst>.<op>)` host, so the same currentUser-only
   *  operation-`requires` gating applies. */
  authUi: boolean;
  /** True when the ui has extractable user-visible strings (M-T1.11) — the walk
   *  then keys literal text to the catalog under `component.<Name>`. */
  i18nEnabled: boolean;
}

/** A `slot`-typed (or optional-slot) param — no `ngComponentOutletInputs`
 *  analogue, so a component declaring one stays deferred. */
function hasSlotOrActionParam(c: ComponentIR): boolean {
  return c.params.some((p) => {
    const t = p.type.kind === "optional" ? p.type.inner : p.type;
    return t.kind === "slot" || t.kind === "action";
  });
}

/** The emitted file path for a walked component. */
export function angularComponentPath(name: string): string {
  return `src/app/components/${name}.ts`;
}

/** kebab selector for a walked component (`TierBadge` → `app-tier-badge`).
 *  The outlet never uses it, but a `@Component` without one is harder to spot
 *  in devtools. */
function componentSelector(name: string): string {
  return `app-${name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()}`;
}

/** Walk one component body + assemble its standalone component class, or
 *  `undefined` when the walked body needs a feature the shell defers (see the
 *  header) — the caller then leaves the name out of `userComponents`. */
function renderOne(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: AngularComponentCtx,
): string | undefined {
  const result = walkBody(
    c.body!,
    angularTarget,
    ctx.pack,
    new Set(c.params.map((p) => p.name)),
    new Set(c.state.map((s) => s.name)),
    componentParams,
    ctx.apiParams,
    ctx.aggregatesByName,
    ctx.bcByAggregate,
    ctx.workflowsByName,
    ctx.bcByWorkflow,
    // Aggregate-typed params (`component OrderActions(order: Order)`) so
    // `Action(order.confirm)` resolves the receiver's aggregate at walk time.
    new Map(
      c.params.flatMap((p) =>
        p.type.kind === "entity" && ctx.aggregatesByName.has(p.type.name)
          ? [[p.name, p.type.name] as const]
          : [],
      ),
    ),
    ctx.pageRoutes,
    ctx.externFunctions,
    new Set(c.derived.map((d) => d.name)),
    ctx.authUi,
    ctx.i18nEnabled ? `component.${c.name}` : undefined,
  );
  if (pageNeedsDeferredFeatures(result)) return undefined;
  // An api read whose ARG reads an `@Input()` is deferred.  The shell hoists a
  // read as a class FIELD initializer, which runs in the constructor — before
  // Angular has set any input — so `useOrderById(this.order.id)` would throw on
  // `undefined` at construction.  (A *reactive* find is exempt: its args are
  // wrapped in a `() => (…)` the query re-reads, so the input is read lazily.)
  // An arg-less read (`<handle>.<Agg>.all`) is likewise unaffected — the common
  // case, and it stays supported.
  const inputNames = c.params.map((p) => p.name);
  const readsAnInput = [...result.usedApiHooks.values()].some(
    (h) =>
      !h.reactiveQuery &&
      h.argsRendered.some((a) => inputNames.some((n) => new RegExp(`(?<![.\\w])${n}\\b`).test(a))),
  );
  if (readsAnInput) return undefined;
  const mode: AngularComponentMode = {
    className: c.name,
    selector: componentSelector(c.name),
    inputs: c.params,
  };
  // A component is a page-shaped subject with no route / title / `requires`
  // gate: the synthetic `PageIR` carries its state / actions so the shell
  // hoists them, and its params ride `componentMode.inputs` (bound as
  // `@Input()`s instead of off the `ActivatedRoute` snapshot).
  const page: PageIR = {
    name: c.name,
    params: c.params,
    state: c.state,
    derived: c.derived,
    actions: c.actions,
    body: c.body,
  };
  return renderAngularPage({
    page,
    result,
    derived: c.derived,
    pack: ctx.pack,
    authUi: ctx.authUi,
    nameCtx: { aggregateNames: [], workflowNames: [] },
    apiParams: ctx.apiParams,
    aggregatesByName: ctx.aggregatesByName,
    bcByAggregate: ctx.bcByAggregate,
    workflowsByName: ctx.workflowsByName,
    bcByWorkflow: ctx.bcByWorkflow,
    externFunctions: ctx.externFunctions,
    componentMode: mode,
    walkedComponents: new Set(componentParams.keys()),
  });
}

/** One emitted component class file, carrying its declaration back for the
 *  source-map recorder. */
export interface EmittedAngularComponent {
  path: string;
  source: string;
  component: ComponentIR;
}

/** Emit every walked (non-`extern`) user component reachable from this ui.
 *
 *  Returns the emitted files plus the name→params map of what actually
 *  emitted — threaded into every page / component walk as `userComponents`, so
 *  ONLY an emitted component resolves at a call site (a deferred one keeps the
 *  pre-existing give-up comment rather than referencing a class that was never
 *  written). */
export function emitAngularUserComponents(
  components: readonly ComponentIR[],
  ctx: AngularComponentCtx,
): { emitted: EmittedAngularComponent[]; params: Map<string, readonly ParamIR[]> } {
  let candidates = components.filter(
    (c) => !c.extern && c.body !== undefined && !hasSlotOrActionParam(c),
  );
  // Nested components (one component rendering another) make emittability
  // TRANSITIVE: a body may only reference a class that is itself emitted, or the
  // emitted file imports a module that was never written.  So iterate to a
  // fixpoint — every candidate is in scope for the walk, and any that turns out
  // deferred is dropped and the remainder re-walked.  Terminates: each round
  // either removes at least one candidate or is the last.
  let emitted: EmittedAngularComponent[] = [];
  for (;;) {
    const inScope = new Map<string, readonly ParamIR[]>(candidates.map((c) => [c.name, c.params]));
    const round: EmittedAngularComponent[] = [];
    for (const c of candidates) {
      const source = renderOne(c, inScope, ctx);
      if (source === undefined) continue;
      round.push({ path: angularComponentPath(c.name), source, component: c });
    }
    emitted = round;
    if (round.length === candidates.length) break;
    candidates = round.map((e) => e.component);
  }
  return {
    emitted,
    params: new Map(emitted.map((e) => [e.component.name, e.component.params] as const)),
  };
}
