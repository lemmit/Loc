// User (non-`extern`) frontend components — Feliz flavour.
//
// A `component TierBadge(label: string, level: int) { body: … }` in the ui DSL is
// a reusable walked region.  React/Vue/Svelte emit a component FILE for it and
// Flutter a widget; Feliz emitted NOTHING — only the `extern` flavour was wired
// — so the name never entered the walker's `userComponents` map and every use
// site fell through to `walk()`'s `(* unknown layout component: TierBadge *)`
// give-up comment.  Declaration and use vanished together (the last two rows of
// the `KNOWN_DEGRADATIONS` ratchet in
// `test/generator/_walker/render-degradation.test.ts`).
//
// WHAT IS EMITTED
// ---------------
// One F# function per walked component, spliced into `App.fs` ahead of the page
// views (F# is order-sensitive, and the views call these) — the same channel the
// hoisted `DataGrid` child rides.  Feliz has no per-component FILE, so there is
// nothing else to place it in.  The functions go in a NESTED module that is
// immediately `open`ed, which is what keeps a component free to be named after
// anything the rest of App.fs declares (see `renderFelizComponentModule`):
//
//     module Components =
//         let TierBadge (props: {| label: string; level: int |}) =
//             let label = props.label
//             let level = props.level
//             Html.div [ … ]
//
//     open Components
//
// The single anonymous-record parameter is what keeps ONE call form for both
// flavours: `felizTarget.renderUserComponent` already emits
// `TierBadge {| label = …; level = … |}` for an extern component, and an F#
// anonymous record is structurally typed, so a walked component whose props
// record has exactly the declared fields accepts that identical call.  Only the
// USED params are re-bound as locals (the walker reports them), so the body's
// bare `label` resolves without introducing unused bindings.
//
// READS — the function takes the Model
// ------------------------------------
// An Elmish read is not a per-view hook: `QueryView { of: Api.Order.all }`
// resolves to a field on the ONE `Model` that the init `Cmd` fills.  So a
// read-bearing component needs nothing invented — just the Model in scope:
//
//     let RecentOrders (model: Model) (props: {| title: string |}) =
//         View.remoteList model.AllOrders …
//
// and the call site (inside a page view, which was handed `model`) applies it:
// `RecentOrders model {| title = "Recent" |}`.  `readsForUi` collects COMPONENT
// bodies alongside page bodies so the field, the init `Cmd` and the `Loaded`
// `update` arm all exist; `renderUserComponent` recognises the synthetic
// `MODEL_PARAM` marker in `userComponents` and prefixes the application.  Before
// this, a read-bearing component was dropped WHOLE — no `let`, and every call
// site rendered the give-up comment.
//
// WHY THE ACCEPTED SET IS NARROWER THAN REACT'S
// ---------------------------------------------
// A Feliz app is ONE Elmish program: state lives on a single flat `Model`,
// updates are `Msg` cases, and a page view is `model -> dispatch -> element`.  A
// component that owns `state {}` / `derived` / named `action`s, or that mounts a
// form, therefore needs Model + Msg + update arms wired for it — a genuine MVU
// design question (per-component sub-models), not a rendering gap.  Those shapes
// stay OUT of the emitted set, so their call sites keep the existing comment
// rather than referencing a function that was never written, and the
// render-degradation ratchet keeps them visible.  Deferred:
//   • `state {}` / `derived` / named `action`s, and any body the walk shows
//     reaching for `dispatch`, a BARE `model`, or a `model.<Field>` the emitted
//     record does not declare (the mechanical backstop for a shape not
//     enumerated here — never broken F#).
//   • forms / action mutations / store reads in the body (same reason).
//   • a `byId` read: its fetch is fired by `pageCmd` on ROUTE entry, keyed to
//     the hosting page's `Page` case, which a component does not have.
//   • `slot` / `action(T)` params — no props-record spelling in v1.
//   • an OPTIONAL param: a call site may omit it, and F# anonymous-record types
//     are exact, so the omission would not typecheck.
//   • an aggregate / value-object param whose wire RECORD this app does not emit
//     (the record set is read-only-derived from the emitted wire layer, so a type
//     that isn't there is never named).

import type {
  AggregateIR,
  ComponentIR,
  EnrichedBoundedContextIR,
  ParamIR,
  UiApiParamIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { walkBody } from "../_walker/walker-core.js";
import { felizTarget } from "./feliz-target.js";
import { FELIZ_CHILDREN_FIELD, FELIZ_MODEL_PARAM } from "./fs-expr.js";
import { felizPack } from "./pack.js";
import { pageMetaFieldName, wireFieldType } from "./wire.js";

/** Everything a component walk needs — the same lookups a page view walk gets
 *  from `renderAppFs`. */
export interface FelizComponentCtx {
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>;
  workflowsByName: ReadonlyMap<string, WorkflowIR>;
  bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR>;
  apiParams: readonly UiApiParamIR[];
  externFunctionNames: ReadonlySet<string>;
  /** True when the hosting deployable has `auth: ui` — `Action(<inst>.<op>)`
   *  buttons gate on a currentUser-only operation `requires`. */
  authUi: boolean;
  /** True when this ui has extractable user-visible strings (M-T1.11) — literal
   *  text then keys to the catalog under `component.<Name>`. */
  i18nEnabled: boolean;
  /** Wire RECORD type names this App.fs actually emits (read off the rendered
   *  domain records).  A param naming a type outside this set is not spellable
   *  here, so its component stays deferred. */
  emittedRecords: ReadonlySet<string>;
  /** Model FIELDS this App.fs's `Model` record declares for api reads (+ their
   *  `PageMeta` siblings) — `felizModelReadFields` over the same `readsForUi`
   *  collection the record is built from.  A component body may name these and
   *  nothing else off `model`; see `needsMvuScope`. */
  modelFields: ReadonlySet<string>;
}

/** F# type for a component param — the WIRE spelling (a param carries a wire
 *  value: an enum arrives as its string name, a `File` as `FileRef`), or
 *  `undefined` when the type has no props-record spelling in v1. */
function propType(p: ParamIR, emittedRecords: ReadonlySet<string>): string | undefined {
  const t = p.type;
  // Optional: a call site may omit the arg, which an exact anonymous-record type
  // would reject.  Slot / action: no props spelling yet.
  if (t.kind === "optional" || t.kind === "slot" || t.kind === "action") return undefined;
  const named = t.kind === "entity" || t.kind === "valueobject" ? t.name : undefined;
  if (named !== undefined && !emittedRecords.has(named)) return undefined;
  const el = t.kind === "array" ? t.element : undefined;
  const elNamed = el && (el.kind === "entity" || el.kind === "valueobject") ? el.name : undefined;
  if (elNamed !== undefined && !emittedRecords.has(elNamed)) return undefined;
  if (t.kind === "array" && (el?.kind === "optional" || el?.kind === "slot")) return undefined;
  return wireFieldType(t);
}

/** A component whose SHAPE can be a props-only F# function — see the header for
 *  why each exclusion is a real MVU question rather than a rendering gap. */
function isCandidate(c: ComponentIR, emittedRecords: ReadonlySet<string>): boolean {
  return (
    !c.extern &&
    c.body !== undefined &&
    c.state.length === 0 &&
    c.derived.length === 0 &&
    c.actions.length === 0 &&
    c.params.every((p) => propType(p, emittedRecords) !== undefined)
  );
}

/** Does the rendered F# reach for an MVU binding this function has no way to
 *  supply?  Word-boundary matched, so `model`/`dispatch` inside a longer
 *  identifier (`modelName`) doesn't trip it.
 *
 *  `dispatch` is always disqualifying — a `Msg` round-trip is a real MVU design
 *  question (per-component sub-models), not a rendering gap.  A `model.<Field>`
 *  read is allowed EXACTLY when `<Field>` is one the emitted `Model` declares
 *  (`ctx.modelFields`, derived from the SAME `readsForUi` collection that writes
 *  the record): an Elmish read IS a Model field, filled by the init `Cmd`, so a
 *  read-bearing component is emittable the moment its function takes the
 *  `Model`.  Deciding this against the walk's own hooks instead would emit
 *  `model.OrderById` for a component `byId` read — a field the collector
 *  deliberately does NOT declare, because its fetch is fired by `pageCmd` on
 *  route entry and a component has no route.
 *
 *  A BARE `model` (not a field read) also defers: the only shape that produces
 *  one is a component calling a sibling that itself takes the Model, and this
 *  function has no Model of its own to pass on. */
function needsMvuScope(fs: string, modelFields: ReadonlySet<string>): boolean {
  if (/\bdispatch\b/.test(fs)) return true;
  for (const m of fs.matchAll(/\bmodel\.([A-Za-z_]\w*)/g)) {
    if (!modelFields.has(m[1]!)) return true;
  }
  return /\bmodel\b(?!\.)/.test(fs);
}

/** The Model fields a set of collected reads declares — each read's own field
 *  plus its paged-envelope `PageMeta` sibling, which `renderPagedEnvelopeMember`
 *  reaches for on a `rows.total` / `rows.totalPages` read. */
export function felizModelReadFields(reads: readonly { field: string }[]): Set<string> {
  return new Set(reads.flatMap((r) => [r.field, pageMetaFieldName(r.field)]));
}

/** One rendered component: its F# declaration plus the sibling components its
 *  body CALLS — F# resolves top-to-bottom, so the callees have to be declared
 *  first (see `orderByCallGraph`). */
interface RenderedComponent {
  name: string;
  decl: string;
  /** Sibling walked components this body calls. */
  uses: ReadonlySet<string>;
  component: ComponentIR;
  /** True when the body renders `Slot { }` — the props record then carries a
   *  `children` field, and every CALL SITE has to fill it (an F# anonymous
   *  record is exact: an absent field is a type error, not a default). */
  usesChildren: boolean;
  /** True when the body reads a Model field (an api read) — the function then
   *  takes the `Model` as a leading curried parameter and every call site
   *  passes the `model` its page view was handed. */
  takesModel: boolean;
}

/** The synthetic param a `Slot { }`-bearing component gains, so a call site
 *  resolving against `userComponents` knows to fill `children` — with the
 *  caller's markup, or `Html.none` when it passed none.  Typed `slot`, the IR's
 *  own "any walker expression" param kind, which is exactly what it holds. */
const CHILDREN_PARAM: ParamIR = { name: FELIZ_CHILDREN_FIELD, type: { kind: "slot" } };

/** The synthetic marker param a READ-bearing component gains.  It is not a prop
 *  — `renderUserComponent` recognises the name, drops it from the props record,
 *  and emits `<Name> model …` instead — but riding the same `userComponents`
 *  map is what lets the CALL SITE know, with no second channel between the
 *  component emitter and the walker target. */
const MODEL_PARAM: ParamIR = { name: FELIZ_MODEL_PARAM, type: { kind: "none" } };

/** A component's params as a CALL SITE sees them — the declared ones, plus the
 *  synthetic `children` when its body has a slot to fill, plus the `model`
 *  marker when its body reads one. */
function callSiteParams(r: RenderedComponent): readonly ParamIR[] {
  const declared = r.usesChildren ? [...r.component.params, CHILDREN_PARAM] : r.component.params;
  return r.takesModel ? [MODEL_PARAM, ...declared] : declared;
}

/** Walk one component body and render its F# declaration, or `undefined` when
 *  the walked body needs MVU scope (see the header). */
function renderOne(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: FelizComponentCtx,
):
  | { decl: string; uses: ReadonlySet<string>; usesChildren: boolean; takesModel: boolean }
  | undefined {
  const result = walkBody(
    c.body!,
    felizTarget,
    felizPack(),
    new Set(c.params.map((p) => p.name)),
    new Set(), // stateNames — a candidate declares no `state {}`
    componentParams,
    ctx.apiParams,
    ctx.aggregatesByName,
    ctx.bcByAggregate,
    ctx.workflowsByName,
    ctx.bcByWorkflow,
    // Aggregate-typed params, so `Action(order.confirm)` could resolve the
    // receiver — such a body is deferred below, but the map costs nothing.
    new Map(
      c.params.flatMap((p) =>
        p.type.kind === "entity" && ctx.aggregatesByName.has(p.type.name)
          ? [[p.name, p.type.name] as const]
          : [],
      ),
    ),
    new Map(), // pageRoutes — a component has no route of its own
    ctx.externFunctionNames,
    new Set(), // derivedNames — a candidate declares none
    ctx.authUi,
    ctx.i18nEnabled ? `component.${c.name}` : undefined,
  );
  const body = result.tsx.trim();
  if (
    needsMvuScope(body, ctx.modelFields) ||
    result.formOfs.length > 0 ||
    result.actionMutations.length > 0 ||
    (result.usedStores?.size ?? 0) > 0 ||
    // The route `id` (`renderRouteId`) is a local only a PAGE view binds from
    // its `Page` case.
    result.usesRouteId
  ) {
    return undefined;
  }
  // Every `model.` here is now a declared read field, so the function takes the
  // `Model`.
  const takesModel = /\bmodel\./.test(body);
  const fields = c.params.map((p) => `${p.name}: ${propType(p, ctx.emittedRecords)}`);
  // A body containing `Slot { }` reads `props.children` (the `renderChildrenSlot`
  // seam), so the props record has to CARRY it — otherwise the F# names an
  // absent field.  One `ReactElement`, not a list: the slot renders in element
  // position, and `felizTarget.renderUserComponent` folds several passed
  // children into a single `React.fragment`.
  if (result.usesChildren) fields.push(`${FELIZ_CHILDREN_FIELD}: ReactElement`);
  // A read-bearing body names `model.<ReadField>`, so the function takes the
  // `Model` as a LEADING CURRIED parameter — not a props-record field, which
  // would force every non-reading call site to spell it too.  `Model` is
  // declared well above the `Components` module (F# is order-sensitive), and
  // `renderUserComponent` emits the matching `<Name> model …` at the call site.
  const modelParam = takesModel ? "(model: Model) " : "";
  const head =
    fields.length > 0
      ? `let ${c.name} ${modelParam}(props: {| ${fields.join("; ")} |}) =`
      : `let ${c.name} ${modelParam}() =`;
  // Only the params the body actually reads are re-bound — an unbound param is
  // still part of the props type (the call site fills it), it just has no local.
  const binds = c.params
    .filter((p) => result.usedParams.has(p.name))
    .map((p) => `    let ${p.name} = props.${p.name}`);
  return {
    decl: [
      head,
      ...binds,
      body
        .split("\n")
        .map((l) => (l.length > 0 ? `    ${l}` : l))
        .join("\n"),
    ].join("\n"),
    // Only sibling WALKED components matter for ordering; an extern call resolves
    // through an `open`ed module, and a primitive isn't a name at all.
    uses: new Set([...result.usedUserComponents].filter((n) => componentParams.has(n))),
    usesChildren: result.usesChildren,
    takesModel,
  };
}

/** Order the declarations so every callee precedes its caller — F# resolves
 *  names top-to-bottom, so a component calling a sibling declared LATER in the
 *  `.ddd` would not compile.  Depth-first post-order over the call graph; a cycle
 *  (pathological — `A` calling `B` calling `A`) keeps source order for its
 *  members, which F# then rejects rather than the emitter silently reordering
 *  into something that looks fine and isn't. */
function orderByCallGraph(rendered: readonly RenderedComponent[]): RenderedComponent[] {
  const byName = new Map(rendered.map((r) => [r.name, r] as const));
  const out: RenderedComponent[] = [];
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (r: RenderedComponent): void => {
    if (done.has(r.name) || onPath.has(r.name)) return;
    onPath.add(r.name);
    for (const use of [...r.uses].sort()) {
      const dep = byName.get(use);
      if (dep) visit(dep);
    }
    onPath.delete(r.name);
    done.add(r.name);
    out.push(r);
  };
  for (const r of rendered) visit(r);
  return out;
}

/** The nested module the component functions are declared in, `open`ed on the
 *  next line so a call site can keep referencing the bare name.
 *
 *  WHY A MODULE AND NOT TOP-LEVEL `let`s.  `App.fs` is ONE F# module, and Fable
 *  compiles each of its members to a JS binding of the same name — so a
 *  top-level `let Product` beside the emitted wire record `type Product` is a
 *  hard `error FABLE: Cannot have two module members with same name: Product`
 *  (measured, not assumed).  Nothing stops a user from naming a component after
 *  an aggregate, a projection row, a `<X>Form`, a hoisted `DataGrid` child, or
 *  `Model`/`Msg`/`Api`/`View`.  Enumerating those names would be a second copy
 *  of every naming decision the emitter makes, free to drift; a nested module
 *  makes the collision IMPOSSIBLE instead — the members live in their own scope,
 *  and the following `open` re-exposes them to the views.  A PascalCase value
 *  brought into scope beside a same-named TYPE or MODULE is unambiguous in F#
 *  (`Api.foo` still resolves the module, a type annotation still resolves the
 *  type), which is what makes the `open` safe. */
export function renderFelizComponentModule(decls: readonly string[]): string[] {
  if (decls.length === 0) return [];
  const indented = decls.map((d) =>
    d
      .split("\n")
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join("\n"),
  );
  return ["", "module Components =", indented.join("\n\n"), "", "open Components"];
}

/** Emit every walked (non-`extern`) user component of this ui.
 *
 *  Returns the F# declarations (wrapped by `renderFelizComponentModule` and
 *  spliced into `App.fs` ahead of the page views) plus the name→params map of
 *  what actually emitted — merged into the extern map and threaded through every
 *  page / component walk, so ONLY an emitted component resolves at a call
 *  site. */
export function emitFelizUserComponents(
  components: readonly ComponentIR[],
  ctx: FelizComponentCtx,
): { decls: string[]; params: Map<string, readonly ParamIR[]> } {
  let candidates = components.filter((c) => isCandidate(c, ctx.emittedRecords));
  // Nested components make emittability TRANSITIVE (a body may only call a
  // function that is itself emitted), so iterate to a fixpoint: each round either
  // drops at least one candidate or is the last.
  let rendered: RenderedComponent[] = [];
  for (;;) {
    const inScope = new Map<string, readonly ParamIR[]>(candidates.map((c) => [c.name, c.params]));
    const round: RenderedComponent[] = [];
    for (const c of candidates) {
      const one = renderOne(c, inScope, ctx);
      if (one === undefined) continue;
      round.push({
        name: c.name,
        decl: one.decl,
        uses: one.uses,
        component: c,
        usesChildren: one.usesChildren,
        takesModel: one.takesModel,
      });
    }
    rendered = round;
    if (round.length === candidates.length) break;
    candidates = round.map((r) => r.component);
  }
  const ordered = orderByCallGraph(rendered);
  return {
    decls: ordered.map((r) => r.decl),
    params: new Map(ordered.map((r) => [r.name, callSiteParams(r)] as const)),
  };
}
