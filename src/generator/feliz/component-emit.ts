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
// nothing else to place it in:
//
//     let TierBadge (props: {| label: string; level: int |}) =
//         let label = props.label
//         let level = props.level
//         Html.div [ … ]
//
// The single anonymous-record parameter is what keeps ONE call form for both
// flavours: `felizTarget.renderUserComponent` already emits
// `TierBadge {| label = …; level = … |}` for an extern component, and an F#
// anonymous record is structurally typed, so a walked component whose props
// record has exactly the declared fields accepts that identical call.  Only the
// USED params are re-bound as locals (the walker reports them), so the body's
// bare `label` resolves without introducing unused bindings.
//
// WHY THE ACCEPTED SET IS NARROWER THAN REACT'S
// ---------------------------------------------
// A Feliz app is ONE Elmish program: state lives on a single flat `Model`,
// updates are `Msg` cases, and a page view is `model -> dispatch -> element`.  A
// component that owns `state {}` / `derived` / named `action`s, or that issues
// reads / mounts a form, therefore needs Model + Msg + update arms wired for it
// — a genuine MVU design question (per-component sub-models), not a rendering
// gap.  Those shapes stay OUT of the emitted set, so their call sites keep the
// existing comment rather than referencing a function that was never written, and
// the render-degradation ratchet keeps them visible.  Deferred:
//   • `state {}` / `derived` / named `action`s, and any body the walk shows
//     reaching for `model` / `dispatch` (the mechanical backstop for a shape not
//     enumerated here — never broken F#).
//   • api reads / forms / action mutations in the body (same reason).
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
import { felizPack } from "./pack.js";
import { wireFieldType } from "./wire.js";

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

/** Does the rendered F# reach for an MVU binding a props-only function has no
 *  way to supply?  Word-boundary matched, so `model`/`dispatch` inside a longer
 *  identifier (`modelName`) doesn't trip it. */
function needsMvuScope(fs: string): boolean {
  return /\bmodel\b/.test(fs) || /\bdispatch\b/.test(fs);
}

/** Walk one component body and render its F# declaration, or `undefined` when
 *  the walked body needs MVU scope (see the header). */
function renderOne(
  c: ComponentIR,
  componentParams: ReadonlyMap<string, readonly ParamIR[]>,
  ctx: FelizComponentCtx,
): string | undefined {
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
    needsMvuScope(body) ||
    result.usedApiHooks.size > 0 ||
    result.formOfs.length > 0 ||
    result.actionMutations.length > 0
  ) {
    return undefined;
  }
  const fields = c.params.map((p) => `${p.name}: ${propType(p, ctx.emittedRecords)}`);
  const head =
    fields.length > 0
      ? `let ${c.name} (props: {| ${fields.join("; ")} |}) =`
      : `let ${c.name} () =`;
  // Only the params the body actually reads are re-bound — an unbound param is
  // still part of the props type (the call site fills it), it just has no local.
  const binds = c.params
    .filter((p) => result.usedParams.has(p.name))
    .map((p) => `    let ${p.name} = props.${p.name}`);
  return [
    head,
    ...binds,
    body
      .split("\n")
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join("\n"),
  ].join("\n");
}

/** Emit every walked (non-`extern`) user component of this ui.
 *
 *  Returns the F# declarations (spliced into `App.fs` ahead of the page views)
 *  plus the name→params map of what actually emitted — merged into the extern
 *  map and threaded through every page / component walk, so ONLY an emitted
 *  component resolves at a call site. */
export function emitFelizUserComponents(
  components: readonly ComponentIR[],
  ctx: FelizComponentCtx,
): { decls: string[]; params: Map<string, readonly ParamIR[]> } {
  let candidates = components.filter((c) => isCandidate(c, ctx.emittedRecords));
  // Nested components make emittability TRANSITIVE (a body may only call a
  // function that is itself emitted), so iterate to a fixpoint: each round either
  // drops at least one candidate or is the last.
  let rendered: { name: string; decl: string; component: ComponentIR }[] = [];
  for (;;) {
    const inScope = new Map<string, readonly ParamIR[]>(candidates.map((c) => [c.name, c.params]));
    const round: typeof rendered = [];
    for (const c of candidates) {
      const decl = renderOne(c, inScope, ctx);
      if (decl === undefined) continue;
      round.push({ name: c.name, decl, component: c });
    }
    rendered = round;
    if (round.length === candidates.length) break;
    candidates = round.map((r) => r.component);
  }
  return {
    decls: rendered.map((r) => r.decl),
    params: new Map(rendered.map((r) => [r.name, r.component.params] as const)),
  };
}
