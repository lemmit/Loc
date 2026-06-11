import { platformFor } from "../../platform/registry.js";
import { plural, snake } from "../../util/naming.js";
import { defaultInterfaceFor } from "../../util/source-types.js";
import { forEachGenericInstance, genericInstanceName, genericShape } from "../stdlib/generics.js";
import { forEachUnion, unionInstanceName } from "../stdlib/unions.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ChannelIR,
  CodeRefKind,
  DataSourceKind,
  DeployableIR,
  DerivedIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EnrichedLoomModel,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  EnrichedValueObjectIR,
  EntityPartIR,
  EnumIR,
  EventSubscriptionIR,
  ExprIR,
  FieldIR,
  FindIR,
  GenericCtorName,
  LoomInterface,
  LoomModel,
  NeedIR,
  OperationIR,
  PayloadIR,
  RawLoomModel,
  RepositoryIR,
  SystemIR,
  TraceabilityIR,
  TypeIR,
  ValueObjectIR,
  WireField,
  WorkflowIR,
  WorkflowStmtIR,
} from "../types/loom-ir.js";
import { buildCreateInput } from "./wire-projection.js";

// ---------------------------------------------------------------------------
// Loom IR enrichments — pure derivations layered on top of the IR
// produced by Layer ③ (lowering).  Lowering produces a faithful AST
// projection; this module computes the cross-cutting derivations
// every backend needs.
//
// Why not in lowering: lowering used to mutate the IR in two places
// (auto-`findAll` injection, react deployable's `moduleNames` copy
// from its target).  Hidden side-effects on a structure callers
// think is faithful.  Pulling the derivations out makes the IR
// read-only after lowering and gives downstream layers a single
// "fully computed" entry point: `enrichLoomModel(lowerModel(ast))`.
//
// Derivations applied (in order):
//
//   1. Wire-shape on every aggregate / part / value object.
//   2. Auto-included `findAll` on every aggregate's repository.
//   3. Associations per aggregate from `X id[]` reference-collection
//      fields (computed during `enrichAggregate`).
//   4. React deployable `moduleNames` ← target deployable's modules
//      (in `enrichDeployables`).
//   5. Per-module `migrationsOwner` — picks one backend deployable
//      per module to own schema migrations (`assignMigrationsOwner`,
//      after deployables are enriched).
//
// Idempotent: `enrich(enrich(m))` deep-equals `enrich(m)`.  Pinned
// by `test/ir/enrichments.test.ts`.
// ---------------------------------------------------------------------------

export function enrichLoomModel(loom: RawLoomModel): EnrichedLoomModel {
  // Root-level VOs / enums are visible from every context as an
  // implicit shared kernel (see docs/multi-file-source.md).  We fold
  // them into each context's effective VO / enum list so every
  // downstream consumer (backends, wire-spec, validators) sees them
  // uniformly through the existing per-context surface.  Output
  // duplicates root types across contexts inside a single deployable
  // — acceptable for Stage A; a future stage may centralise emission
  // into a shared module per deployable.
  const enrichedRootVOs = loom.rootValueObjects.map(enrichValueObject);
  const rootEnums = loom.rootEnums;
  const rootPayloads = loom.rootPayloads;
  return {
    systems: loom.systems.map((s) => enrichSystem(s, enrichedRootVOs, rootEnums, rootPayloads)),
    contexts: loom.contexts.map((c) =>
      enrichContext(c, enrichedRootVOs, rootEnums, "literal", rootPayloads),
    ),
    rootValueObjects: enrichedRootVOs,
    rootEnums,
    rootPayloads,
    components: loom.components,
    requirements: loom.requirements,
    solutions: loom.solutions,
    testCases: loom.testCases,
    traceability: computeTraceability(loom),
  } as EnrichedLoomModel;
}

/** Read the populated wire shape for an aggregate / part / value-object.
 *
 * Every backend's response-DTO emitter walks this list to stay in
 * sync with peers — `wireShape` is populated by `enrichLoomModel`
 * during the enrichment pass.  Callers used to write
 * `entity.wireShape!` with a non-null assertion at the consumer
 * site, scattering the same precondition across four files.  This
 * helper centralises the assumption.
 *
 * Enriched-only by signature: `EnrichedAggregateIR` /
 * `EnrichedEntityPartIR` / `EnrichedValueObjectIR` make `wireShape`
 * non-optional at the type level, so passing a raw entity is a
 * compile error.  The earlier raw-union overload + `!` non-null
 * cast is gone — every production caller flows enriched IR through.
 *
 * Brand cascade: `PlatformSurface.emitProject` now takes
 * `EnrichedBoundedContextIR[]`, and the per-platform entry points
 * (`generate<Plat>ForContexts`) + per-aggregate helpers
 * (`buildApiModule`, `renderPartResponseSchema`, etc.) thread the
 * enriched brand inward, so every caller of `wireShapeFor` is
 * type-checked at the call site — no `as Enriched...` local casts
 * remain. */
export function wireShapeFor(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR | EnrichedValueObjectIR,
): WireField[] {
  return entity.wireShape;
}

function enrichSystem(
  sys: SystemIR,
  rootValueObjects: EnrichedValueObjectIR[],
  rootEnums: EnumIR[],
  rootPayloads: PayloadIR[] = [],
): EnrichedSystemIR {
  // Resolve each subdomain's lifecycle URL style from the api(s) that
  // surface it (`api X from <subdomain>`).  An aggregate belongs to one
  // subdomain, so this uniquely determines its actions' route slugs.
  // First-declared api wins if two surface the same subdomain with
  // differing styles (the validator warns — see checkApiUrlStyle).
  const urlStyleBySubdomain = new Map<string, "literal" | "resource">();
  for (const a of sys.apis) {
    if (!urlStyleBySubdomain.has(a.sourceModule))
      urlStyleBySubdomain.set(a.sourceModule, a.urlStyle);
  }
  // Merge each subdomain's per-error HTTP status overrides from every api that
  // surfaces it (`httpStatus <Error> <Code>`).  First-declared api wins on a
  // conflicting code for the same error (mirrors urlStyle).  Consumed by the
  // route translator as `ctx.errorStatusOverrides` (exception-less.md A1).
  const errorStatusesBySubdomain = new Map<string, Record<string, number>>();
  for (const a of sys.apis) {
    const merged = errorStatusesBySubdomain.get(a.sourceModule) ?? {};
    for (const [err, code] of Object.entries(a.errorStatuses))
      if (!(err in merged)) merged[err] = code;
    errorStatusesBySubdomain.set(a.sourceModule, merged);
  }
  // First enrich each subdomain's contexts (auto-findAll, wire-shape,
  // routeSlug).
  const subdomains: EnrichedSubdomainIR[] = sys.subdomains.map((m) => ({
    ...m,
    contexts: m.contexts.map((c) => ({
      ...enrichContext(
        c,
        rootValueObjects,
        rootEnums,
        urlStyleBySubdomain.get(m.name) ?? "literal",
        rootPayloads,
      ),
      errorStatusOverrides: errorStatusesBySubdomain.get(m.name),
    })),
  }));
  // Then propagate react deployables' context sets from their targets.
  // Done after subdomain enrichment so frontends see the same enriched
  // contexts every other consumer sees.
  const deployables = enrichDeployables(sys.deployables);
  // Derive `migrationsOwner` per subdomain — the deployable responsible
  // for emitting schema migrations.  Runs last because it consults
  // the (now enriched) deployable list.  See `assignMigrationsOwner`.
  const subdomainsWithOwner = subdomains.map((m) => assignMigrationsOwner(m, deployables));
  // Derive the implicit logical needs (RFC §3.3): one per (context,
  // required kind), read off how each context's aggregates persist.
  const needs = deriveNeeds(subdomainsWithOwner);
  // Resolve each resource's default access interface (RFC §3.5) from
  // its sourceType + kind.  Per-operation overrides land with the
  // consumption surface (Phase 4).
  const resourceInterfaces = deriveResourceInterfaces(sys);
  // Scaffold expansion now runs at the AST
  // level via `src/language/ddd-scaffold-ast-expander.ts` (a
  // `DocumentState.IndexedContent` hook on the shared
  // DocumentBuilder).  By the time lowering runs, every page is
  // already an explicit AST node, so `ui.pages` carries the full
  // canonical set straight from `lowerUi` — no IR-level pass
  // needed.  The IR-level expander remains as a no-op shim for
  // any caller that constructs a `LoomModel` outside the standard
  // `parseHelper` / `DocumentBuilder` pipeline (it just returns
  // the existing pages unchanged).
  return { ...sys, subdomains: subdomainsWithOwner, deployables, needs, resourceInterfaces };
}

// Resolve the default access interface for every resource from its
// sourceType (via the storage it `use:`s) and kind.  RFC §3.5.
function deriveResourceInterfaces(sys: SystemIR): Record<string, LoomInterface> {
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const out: Record<string, LoomInterface> = {};
  for (const r of sys.dataSources) {
    const sourceType = storeType.get(r.storageName);
    if (!sourceType) continue;
    const iface = defaultInterfaceFor(sourceType, r.kind);
    if (iface) out[r.name] = iface;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Need derivation — the implicit "need" layer (RFC §3.3).
//
// A context's aggregates determine which data kinds it requires:
//   - `state`    when at least one aggregate is persistedAs(state) (the
//                default) — it needs a primary state store;
//   - `eventLog` when at least one aggregate is persistedAs(eventLog) —
//                it needs an event stream.
// (snapshot / cache / replica are optional secondary stores, never
// *required* by an aggregate, so they are not needs.)  Capabilities are
// the base set each kind implies; a `resource`'s sourceType must offer
// them (checked in IR validation).  Mirrors `coverageGapReason` in
// `src/ir/validate/validate.ts`.
// ---------------------------------------------------------------------------

function deriveNeeds(subdomains: EnrichedSubdomainIR[]): NeedIR[] {
  const needs: NeedIR[] = [];
  for (const sub of subdomains) {
    for (const ctx of sub.contexts) {
      if (ctx.aggregates.length > 0) {
        const hasState = ctx.aggregates.some((a) => (a.persistedAs ?? "state") === "state");
        const hasEventLog = ctx.aggregates.some((a) => a.persistedAs === "eventLog");
        if (hasState) {
          needs.push({
            contextName: ctx.name,
            kind: "state",
            capabilities: ["state", "crud", "query"],
          });
        }
        if (hasEventLog) {
          needs.push({ contextName: ctx.name, kind: "eventLog", capabilities: ["append", "read"] });
        }
      }
      // Usage-derived needs (Phase 4): a resource-op `files.put(...)` in
      // a workflow body means the context requires the verb's capability
      // of its `(context, kind)` resource.  Union per kind so a context
      // using several verbs of one resource needs all their capabilities.
      const byKind = new Map<DataSourceKind, Set<string>>();
      for (const wf of ctx.workflows) {
        for (const st of wf.statements) {
          const call =
            st.kind === "resource-call" ? st.call : st.kind === "expr-let" ? st.expr : undefined;
          if (call?.kind === "call" && call.callKind === "resource-op" && call.resourceOp) {
            const { resourceKind, capability } = call.resourceOp;
            if (!capability) continue;
            const set = byKind.get(resourceKind) ?? new Set<string>();
            set.add(capability);
            byKind.set(resourceKind, set);
          }
        }
      }
      for (const [kind, caps] of byKind) {
        needs.push({ contextName: ctx.name, kind, capabilities: [...caps].sort() });
      }
    }
  }
  return needs;
}

// ---------------------------------------------------------------------------
// Migrations ownership — which deployable is responsible for emitting
// schema migrations against a given subdomain.
//
// Rule (walk `sys.deployables` in declaration order): the first deployable
// that hosts any context belonging to the subdomain AND whose platform
// owns a database wins.  Failing that, leave `migrationsOwner` undefined —
// no backend emits migrations for the subdomain (frontend-only
// subdomains, etc.).
//
// Database-bearing platforms are read from `PlatformSurface.needsDb` via
// `platformFor()` — single source of truth, mirrors the `isFrontend` check
// in `applyTargetsInheritance` below.
// ---------------------------------------------------------------------------

function assignMigrationsOwner(
  m: EnrichedSubdomainIR,
  deployables: DeployableIR[],
): EnrichedSubdomainIR {
  const contextNames = m.contexts.map((c) => c.name);
  const owner = deployables.find(
    (d) => platformFor(d.platform).needsDb && contextNames.some((c) => d.contextNames.includes(c)),
  );
  if (owner) return { ...m, migrationsOwner: owner.name };
  return m;
}

export function enrichContext(
  ctx: BoundedContextIR,
  rootValueObjects: EnrichedValueObjectIR[] = [],
  rootEnums: EnumIR[] = [],
  urlStyle: "literal" | "resource" = "literal",
  rootPayloads: PayloadIR[] = [],
): EnrichedBoundedContextIR {
  // Fold the ambient root-level VOs / enums into the context's
  // effective set so every per-context emitter sees them as if they
  // were declared locally.  A root-level VO / enum with the same
  // name as a context-local one would shadow; the validator should
  // reject collisions before we get here (Stage A check).
  const ownVoNames = new Set(ctx.valueObjects.map((v) => v.name));
  const ownEnumNames = new Set(ctx.enums.map((e) => e.name));
  const valueObjects: EnrichedValueObjectIR[] = [
    ...ctx.valueObjects.map(enrichValueObject),
    ...rootValueObjects.filter((v) => !ownVoNames.has(v.name)),
  ];
  const enums = [...ctx.enums, ...rootEnums.filter((e) => !ownEnumNames.has(e.name))];
  // Aggregate-inheritance (I2 foundation): a concrete `extends Base` inherits
  // the abstract base's declared fields into its own field list — base fields
  // first (after id), then own — so its `wireShape` and every backend DTO
  // carry the shared shape.  Backend-neutral: both `sharedTable` (TPH) and
  // `ownTable` (TPC) need the merged shape.  Resolved within the context (the
  // common case); a cross-context base is left to the emission slice.  Own
  // fields shadow a like-named base field (no overriding semantics; a
  // redeclaration validator can tighten this later).  Storage emission of the
  // hierarchy itself (table strategy, discriminator, polymorphic queries) is
  // not wired yet — see the `inheritance-storage-unwired` IR-validate warning.
  const byName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const withInheritance = ctx.aggregates.map((a) => {
    if (!a.extendsAggregate) return a;
    const base = byName.get(a.extendsAggregate);
    if (!base) return a;
    const ownNames = new Set(a.fields.map((f) => f.name));
    const inherited = base.fields.filter((f) => !ownNames.has(f.name));
    return inherited.length > 0 ? { ...a, fields: [...inherited, ...a.fields] } : a;
  });
  const aggregates = withInheritance.map((a) => enrichAggregate(a, valueObjects, urlStyle));
  const repositories = ensureFindAll(aggregates, ctx.repositories);
  // P2 (payload-transport-layer.md): give every concrete aggregate's wire
  // shape a named, referenceable `<Agg>Wire` payload.  Purely additive IR
  // surface — backends keep consuming `wireShape` directly, so emission is
  // unchanged.  Abstract bases (aggregate-inheritance.md, #749) emit no
  // table/DTO and are dropped from codegen, so they get no `<Base>Wire`;
  // the `isAbstract` guard is forward-compatible (the field is absent on
  // this branch and becomes a real flag once the inheritance track lands).
  const wirePayloads = aggregates
    .filter((a) => !(a as { isAbstract?: boolean }).isAbstract)
    .map(synthesizeWirePayload);
  // Idempotent: drop any synthesized payloads from a prior enrichment pass
  // before re-appending, so `enrich(enrich(m))` deep-equals `enrich(m)`.
  // Author-declared payloads (no `synthesized` flag) are preserved.  The
  // `?? []` tolerates IR hand-constructed outside the standard lowering
  // pipeline (test fixtures, the IR-level expander shim) that predate the
  // `payloads` field — lowering always populates it for real sources.
  // Ambient root-level payloads (exception-less.md A1) fold in like root VOs:
  // a context-local payload of the same name shadows.  Folded before generic /
  // union monomorphization so an `or`-union naming an ambient `NotFound`
  // resolves its fields here.
  const ownPayloadNames = new Set(
    (ctx.payloads ?? []).filter((p) => !p.synthesized).map((p) => p.name),
  );
  const basePayloads = [
    ...(ctx.payloads ?? []).filter((p) => !p.synthesized),
    ...rootPayloads.filter((p) => !ownPayloadNames.has(p.name)),
    ...wirePayloads,
  ];
  // P3b (payload-transport-layer.md): monomorphize every distinct generic
  // carrier instantiation (`string paged`, `Customer envelope`) reachable from
  // a type position into a concrete, named `PayloadIR` — sibling to the
  // `<Agg>Wire` synthesis above.  Backends map a `genericInstance` reference to
  // this payload's name and emit its DTO.  Deduped per context by name.
  const mono = monomorphizeGenericInstances(aggregates, valueObjects, repositories, basePayloads);
  const withGenerics = [...basePayloads, ...mono];
  // P4 (payload-transport-layer.md): monomorphize every distinct *anonymous*
  // union (`A or B`, `T option`) reachable from a type position into a named
  // `PayloadIR` carrying `variants` — sibling to the generic monomorphization
  // above.  Named unions (`payload Foo = A | B`) already carry `variants` from
  // lowering, so they pass through `withGenerics` and are skipped here by name.
  const unions = monomorphizeUnions(aggregates, valueObjects, repositories, withGenerics);
  const payloads = [...withGenerics, ...unions];
  // Slice 4 (static-analysis-followups.md): derive each workflow's tail-
  // position success type once, so the backends can narrow `{:ok, term()}`
  // to a concrete `{:ok, T}` instead of re-walking the body per emitter.
  const workflows = ctx.workflows.map(enrichWorkflowReturnType).map(enrichWorkflowInstanceShape);
  // In-process dispatch slice: the channel-routed subscription join.
  const eventSubscriptions = deriveEventSubscriptions(ctx.channels, workflows);
  return {
    ...ctx,
    valueObjects,
    enums,
    aggregates,
    repositories,
    payloads,
    workflows,
    eventSubscriptions,
  };
}

/** Attach `returnType` (the tail-position success type) to a workflow, idempotently. */
function enrichWorkflowReturnType(wf: WorkflowIR): WorkflowIR {
  const returnType = computeWorkflowReturnType(wf);
  return returnType ? { ...wf, returnType } : wf;
}

/** Attach `instanceWireShape` (the persisted correlation-state row's wire
 *  shape) to a correlation-bearing workflow, idempotently — the
 *  workflow-instance analogue of an aggregate's `wireShape`
 *  (workflow-instance-visibility.md).  No-op for stateless / `eventSourced`
 *  workflows (no correlation field ⇒ no state table to read). */
function enrichWorkflowInstanceShape(wf: WorkflowIR): WorkflowIR {
  if (!wf.correlationField) return wf;
  return { ...wf, instanceWireShape: wireFieldsForWorkflow(wf) };
}

/** The wire shape of a persisted workflow instance: the correlation field as
 *  the `id`-shaped `token` row (mirroring an aggregate's synthetic `id`),
 *  then the remaining `stateFields` as `property` rows in declaration order.
 *  Order is the contract, exactly like `wireFieldsForAggregate`.  The
 *  correlation field keeps its declared name (it is a real column on the
 *  state table `workflowStateTableShape` derives), unlike an aggregate's
 *  always-`"id"` key. */
function wireFieldsForWorkflow(wf: WorkflowIR): WireField[] {
  const corr = wf.correlationField;
  const fields = wf.stateFields ?? [];
  const corrField = fields.find((f) => f.name === corr);
  const out: WireField[] = [];
  if (corrField) {
    out.push({
      name: corrField.name,
      type: corrField.type,
      optional: corrField.optional,
      source: "id",
      access: "token",
    });
  }
  for (const f of fields) {
    if (f.name === corr) continue;
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  return out;
}

/** The value a workflow's primary `run` body yields on the happy path — the
 *  result of its last value-binding statement, mirroring the `last-bind` rule
 *  the backends use to pick the `{:ok, <bind>}` return.  Returns `undefined`
 *  (keep the conservative `{:ok, term()}`) when the body has no value bind,
 *  ends in a loop/sequence whose tail type isn't a single bind, or the bound
 *  type isn't a safely-renderable leaf.  Pure — testable on synthetic IR. */
export function computeWorkflowReturnType(wf: WorkflowIR): TypeIR | undefined {
  const stmts = wf.statements;
  // A `repo-run` / `for-each` makes the body a sequence/loop, not a `with`-
  // chain — its tail is the loop's own `{:ok, _}`, not a named bind — so the
  // success type can't be pinned precisely.  Stay conservative.
  if (stmts.some((s) => s.kind === "repo-run" || s.kind === "for-each")) return undefined;
  // The return value is the LAST statement that binds a usable value, in
  // declaration order: `factory-let` / `repo-let` / `expr-let` (an `op-call`
  // binds `_`, so it never becomes the return — matching the emitter, which
  // only tracks statements carrying a `bindName`).
  for (let i = stmts.length - 1; i >= 0; i--) {
    const t = tailBindType(stmts[i]!);
    if (t) return isNarrowableType(t) ? t : undefined;
  }
  return undefined;
}

/** The type a binding statement contributes as a `with`-chain return value, or
 *  `undefined` if it binds nothing returnable. */
function tailBindType(stmt: WorkflowStmtIR): TypeIR | undefined {
  switch (stmt.kind) {
    case "factory-let":
      return { kind: "entity", name: stmt.aggName };
    case "repo-let":
      // The `{:ok, name} <-` clause unwraps the loaded aggregate; strip any
      // declared `optional` so the success arm is the non-nil value.
      return stmt.returnType.kind === "optional" ? stmt.returnType.inner : stmt.returnType;
    case "expr-let":
      return stmt.type;
    default:
      return undefined;
  }
}

/** Whether a type renders to a precise, non-widening backend typespec.  The
 *  transport-only carriers (`union` / `none` / `genericInstance`) and the
 *  UI-only `slot` collapse to `map()` — too loose to be worth narrowing to —
 *  so they fall back to the conservative `term()` arm. */
function isNarrowableType(t: TypeIR): boolean {
  switch (t.kind) {
    case "primitive":
    case "id":
    case "enum":
    case "valueobject":
    case "entity":
      return true;
    case "array":
      return isNarrowableType(t.element);
    case "optional":
      return isNarrowableType(t.inner);
    default:
      return false;
  }
}

/** Join workflow consumers (`on(e: Event)` reactors and event-triggered
 *  `create(e: Event) by` starters) against the channels that `carries:` each
 *  event (channels.md; the in-process dispatch slice).  Only events a channel
 *  carries are routable — the channel-routed rule — so an empty-or-uncarried
 *  set yields `[]` and stays byte-identical (Noop dispatcher).  When several
 *  channels carry one event the first by declaration order wins; diagnosing the
 *  ambiguity is a deferred validation rule.
 *
 *  Takes `channels` + `workflows` rather than a whole context so a backend can
 *  re-derive over its *merged* deployable context (every hosted context's
 *  channels ∪ workflows) — that union is what makes cross-context choreography
 *  fall out for free, since a reactor in one context can match a channel in
 *  another within the same deployable. */
export function deriveEventSubscriptions(
  channels: ChannelIR[],
  workflows: WorkflowIR[],
): EventSubscriptionIR[] {
  // Tolerate hand-built IR fixtures that predate the `channels` / `creates`
  // fields (the real lowering pipeline always populates them).
  if (!channels || channels.length === 0) return [];
  const carrier = (event: string): string | undefined =>
    channels.find((ch) => ch.carries.includes(event))?.name;
  const subs: EventSubscriptionIR[] = [];
  for (const wf of workflows ?? []) {
    for (const on of wf.subscriptions ?? []) {
      const channel = carrier(on.event);
      if (channel) {
        subs.push({ event: on.event, channel, workflow: wf.name, trigger: "on", param: on.param });
      }
    }
    for (const create of wf.creates ?? []) {
      if (create.triggerKind !== "event" || !create.eventRef || !create.eventBinding) continue;
      const channel = carrier(create.eventRef);
      if (channel) {
        subs.push({
          event: create.eventRef,
          channel,
          workflow: wf.name,
          trigger: "create",
          param: create.eventBinding,
          createName: create.name,
        });
      }
    }
  }
  return subs;
}

/** Collect every distinct anonymous-union shape reachable from the context's
 *  type positions and synthesize a named `PayloadIR` (with `variants`) for each
 *  (deduped by `unionInstanceName`).  The union analogue of
 *  `monomorphizeGenericInstances`: backends map an inline-union reference to
 *  this payload's name and emit its tagged-wire `z.discriminatedUnion` DTO. */
function monomorphizeUnions(
  aggregates: EnrichedAggregateIR[],
  valueObjects: EnrichedValueObjectIR[],
  repositories: RepositoryIR[],
  existing: PayloadIR[],
): PayloadIR[] {
  const found = new Map<string, TypeIR[]>();
  const scan = (type: TypeIR): void =>
    forEachUnion(type, (variants) => {
      found.set(unionInstanceName(variants), variants);
    });
  const scanAggregateLike = (node: {
    fields: FieldIR[];
    derived: DerivedIR[];
    functions: { params: { type: TypeIR }[]; returnType: TypeIR }[];
  }): void => {
    for (const f of node.fields) scan(f.type);
    for (const d of node.derived) scan(d.type);
    for (const fn of node.functions) {
      scan(fn.returnType);
      for (const p of fn.params) scan(p.type);
    }
  };
  for (const agg of aggregates) {
    scanAggregateLike(agg);
    for (const op of agg.operations) for (const p of op.params) scan(p.type);
    for (const part of agg.parts) scanAggregateLike(part);
  }
  for (const vo of valueObjects) scanAggregateLike(vo);
  for (const repo of repositories) {
    for (const find of repo.finds) {
      scan(find.returnType);
      for (const p of find.params) scan(p.type);
    }
  }
  for (const p of existing) {
    for (const f of p.fields) scan(f.type);
    for (const v of p.variants ?? []) scan(v);
  }

  const taken = new Set(existing.map((p) => p.name));
  const out: PayloadIR[] = [];
  for (const [name, variants] of found) {
    if (taken.has(name)) continue;
    taken.add(name);
    out.push({ name, kind: "payload", fields: [], variants, synthesized: true });
  }
  return out;
}

/** Collect every distinct generic-carrier instantiation reachable from the
 *  context's type positions and synthesize a concrete `PayloadIR` for each
 *  (deduped by monomorphized name).  Purely additive: the returned payloads
 *  name the instantiated shapes so backends can emit them as DTOs and resolve
 *  a `genericInstance` reference to the concrete name. */
function monomorphizeGenericInstances(
  aggregates: EnrichedAggregateIR[],
  valueObjects: EnrichedValueObjectIR[],
  repositories: RepositoryIR[],
  existing: PayloadIR[],
): PayloadIR[] {
  const found = new Map<string, { ctor: GenericCtorName; arg: TypeIR }>();
  const scan = (type: TypeIR): void =>
    forEachGenericInstance(type, (inst) => {
      found.set(genericInstanceName(inst.ctor, inst.arg), inst);
    });
  const scanAggregateLike = (node: {
    fields: FieldIR[];
    derived: DerivedIR[];
    functions: { params: { type: TypeIR }[]; returnType: TypeIR }[];
  }): void => {
    for (const f of node.fields) scan(f.type);
    for (const d of node.derived) scan(d.type);
    for (const fn of node.functions) {
      scan(fn.returnType);
      for (const p of fn.params) scan(p.type);
    }
  };
  for (const agg of aggregates) {
    scanAggregateLike(agg);
    for (const op of agg.operations) for (const p of op.params) scan(p.type);
    for (const part of agg.parts) scanAggregateLike(part);
  }
  for (const vo of valueObjects) scanAggregateLike(vo);
  for (const repo of repositories) {
    for (const find of repo.finds) {
      scan(find.returnType);
      for (const p of find.params) scan(p.type);
    }
  }
  for (const p of existing) for (const f of p.fields) scan(f.type);

  const taken = new Set(existing.map((p) => p.name));
  const out: PayloadIR[] = [];
  for (const [name, inst] of found) {
    if (taken.has(name)) continue;
    taken.add(name);
    out.push({
      name,
      kind: "payload",
      fields: genericShape(inst.ctor).fields(inst.arg),
      synthesized: true,
      generic: { ctor: inst.ctor, arg: inst.arg },
    });
  }
  return out;
}

/** Derive the named `<Agg>Wire` payload (P2) from an enriched aggregate's
 *  already-computed `wireShape`.  The wire shape is the single source of
 *  truth for the cross-backend DTO; this just names it as a `PayloadIR`
 *  so later phases (and authors, eventually) can reference it.  A
 *  `WireField` maps to a `FieldIR` one-to-one on `{name, type, optional,
 *  access}` — `source` is wire-shape bookkeeping the payload doesn't need. */
function synthesizeWirePayload(agg: EnrichedAggregateIR): PayloadIR {
  const fields: FieldIR[] = agg.wireShape.map((w) => ({
    name: w.name,
    type: w.type,
    optional: w.optional,
    access: w.access,
  }));
  return { name: `${agg.name}Wire`, kind: "payload", fields, synthesized: true };
}

/** Derive an action's HTTP path segment from the surfacing api's
 * urlStyle (D-URLSTYLE).  Canonical (unnamed) actions resolve to the
 * bare collection / canonical-id URL, signalled by `undefined`. */
function routeSlugFor(op: OperationIR, urlStyle: "literal" | "resource"): string | undefined {
  if (op.canonical) return undefined;
  return urlStyle === "resource" ? plural(op.name) : op.name;
}

function enrichAggregate(
  agg: AggregateIR,
  contextVOs: ValueObjectIR[],
  urlStyle: "literal" | "resource" = "literal",
): EnrichedAggregateIR {
  const parts = agg.parts.map(enrichPart);
  const fields = agg.fields.map(resolveFieldAccess);
  // Synthesize a `derived inspect: string = <structural>` when the user
  // didn't declare one.  Always-present after enrichment so backends
  // can emit a `ToString()` / `Inspect` / `util.inspect.custom` hook
  // unconditionally.
  //
  // The VO lookup gives synth visibility into nested fields so a
  // `price: Money` field can expand to `price: <Money(amount: ...,
  // currency: '...')>` rather than the opaque `[Money]` placeholder
  // the first cut emitted.
  const voLookup = new Map(contextVOs.map((v) => [v.name, v] as const));
  const userInspect = agg.derived.find((d) => d.name === "inspect");
  const inspectDerived = userInspect ?? synthesizeInspect(agg, voLookup);
  const derived = userInspect ? agg.derived : [...agg.derived, inspectDerived];
  // Compute wireShape on the post-synthesis, post-access-resolution
  // agg so the wire spec is idempotent (second enrichment finds the
  // synthesized inspect already in `derived` and doesn't double-add,
  // and `resolveFieldAccess` skips fields that already carry access).
  // Stamp routeSlug on every lifecycle action.  New objects (don't
  // mutate shared refs); canonicalCreate/Destroy are re-pointed at the
  // freshly-stamped array entries.
  const stamp = (o: OperationIR): OperationIR => ({ ...o, routeSlug: routeSlugFor(o, urlStyle) });
  const operations = agg.operations.map(stamp);
  const creates = agg.creates?.map(stamp);
  const destroys = agg.destroys?.map(stamp);
  const resolved: AggregateIR = { ...agg, derived, fields };
  return {
    ...resolved,
    operations,
    creates,
    destroys,
    canonicalCreate: creates?.find((c) => c.canonical) ?? null,
    canonicalDestroy: destroys?.find((d) => d.canonical) ?? null,
    parts,
    wireShape: wireFieldsForAggregate(resolved),
    associations: associationsForAggregate(resolved),
    createInput: buildCreateInput(resolved),
    displayDerived: derived.find((d) => d.name === "display"),
    inspectDerived,
  };
}

/** Build a default `derived inspect: string` expression for an aggregate
 * that didn't declare one.  Shape: `"User(id: " + id + ", name: '" + name
 * + "', ssn: <redacted>)"` — structural form with field names + values,
 * sensitive fields redacted by literal text rather than value reference.
 *
 * Built directly in IR (no AST roundtrip) to avoid threading a new
 * factory through the macro layer.  Composes `binary` nodes with
 * `lit("string", ...)` left/right ends and `ref`/`id` field accesses
 * in between; the existing `string + X` implicit-concat rule lowers
 * non-string operands via `convert` IR for us if needed, but because
 * we control the structure we emit the conversion explicitly so
 * downstream backends see a fully-typed tree from the start. */
function synthesizeInspect(agg: AggregateIR, voLookup: Map<string, ValueObjectIR>): DerivedIR {
  const STRING: TypeIR = { kind: "primitive", name: "string" };
  const lit = (value: string): ExprIR => ({ kind: "literal", lit: "string", value });
  const concat = (left: ExprIR, right: ExprIR): ExprIR => ({
    kind: "binary",
    op: "+",
    left,
    right,
    leftType: STRING,
    resultType: STRING,
  });
  const redacted = lit("<redacted>");

  /** Stringify a single primitive/id/enum/string LEAF access node.
   * Caller picks the access (top-level `ref` to a stored property,
   * or `member` access through a containing VO).  Out-of-scope
   * shapes (entity refs, arrays, optionals) return the placeholder
   * — see the type-shorthand fallback at the bottom. */
  const stringifyLeaf = (access: ExprIR, fieldType: TypeIR, sensitive: boolean): ExprIR => {
    if (sensitive) return redacted;
    if (fieldType.kind === "primitive" && fieldType.name === "string") {
      // Wrap as `'<value>'` — open quote, value, close quote.
      return concat(concat(lit("'"), access), lit("'"));
    }
    if (fieldType.kind === "primitive" || fieldType.kind === "id" || fieldType.kind === "enum") {
      const fromPrimitive =
        fieldType.kind === "primitive"
          ? fieldType.name
          : fieldType.kind === "id"
            ? fieldType.valueType
            : undefined;
      return { kind: "convert", target: "string", from: fromPrimitive, value: access };
    }
    return lit(`[${typeShorthand(fieldType)}]`);
  };

  /** Inline a VO field's structural inspect: each VO field becomes a
   * `member` access through `parentRef`, formatted as `VOName(f1:
   * <v1>, f2: <v2>)`.  Nested VOs / arrays / optionals inside the
   * inlined VO fall back to a placeholder (depth-1 — keeps the
   * expression bounded and avoids cycles for self-recursive VO
   * shapes, which are rare but possible). */
  const inlineVO = (
    parentFieldName: string,
    voType: TypeIR & { kind: "valueobject" },
    vo: ValueObjectIR,
  ): ExprIR => {
    const parentRef: ExprIR = {
      kind: "ref",
      name: parentFieldName,
      refKind: "this-prop",
      type: voType,
    };
    const pieces: ExprIR[] = [lit(`${vo.name}(`)];
    let first = true;
    for (const f of vo.fields) {
      if (!first) pieces.push(lit(", "));
      pieces.push(lit(`${f.name}: `));
      const isSensitive = !!f.sensitivity && f.sensitivity.length > 0;
      const access: ExprIR = {
        kind: "member",
        receiver: parentRef,
        member: f.name,
        receiverType: voType,
        memberType: f.type,
      };
      pieces.push(stringifyLeaf(access, f.type, isSensitive));
      first = false;
    }
    pieces.push(lit(")"));
    let expr: ExprIR = pieces[0]!;
    for (let i = 1; i < pieces.length; i++) {
      expr = concat(expr, pieces[i]!);
    }
    return expr;
  };

  const valueForField = (fieldName: string, fieldType: TypeIR, sensitive: boolean): ExprIR => {
    if (sensitive) return redacted;
    // Single (non-array, non-optional) VO with a known definition →
    // inline the VO's structural form so debug strings show the
    // contents rather than `[Money]`.  Sensitive marker on the field
    // itself was already handled above (redact wholesale); per-VO-
    // field sensitivity is honoured inside `inlineVO`.
    if (fieldType.kind === "valueobject") {
      const vo = voLookup.get(fieldType.name);
      if (vo) return inlineVO(fieldName, fieldType, vo);
    }
    // Plain `ref` to a stored property — same shape `lower-expr` would
    // produce for a bare property name inside a derived body.
    const ref: ExprIR = {
      kind: "ref",
      name: fieldName,
      refKind: "this-prop",
      type: fieldType,
    };
    return stringifyLeaf(ref, fieldType, false);
  };

  const pieces: ExprIR[] = [lit(`${agg.name}(`)];
  let first = true;

  const pushField = (label: string, value: ExprIR) => {
    if (!first) pieces.push(lit(", "));
    pieces.push(lit(`${label}: `));
    pieces.push(value);
    first = false;
  };

  // ID first.
  pushField("id", {
    kind: "convert",
    target: "string",
    from: agg.idValueType,
    value: { kind: "id" },
  });

  // Stored properties.
  for (const f of agg.fields) {
    const isSensitive = !!f.sensitivity && f.sensitivity.length > 0;
    pushField(f.name, valueForField(f.name, f.type, isSensitive));
  }

  // Containments: short structural placeholder.  Not recursed into —
  // keeps the inspect string compact and avoids cycles for
  // self-containing parts (rare but possible).
  for (const c of agg.contains) {
    pushField(c.name, lit(`[${c.partName}${c.collection ? "[]" : ""}]`));
  }

  pieces.push(lit(")"));

  // Fold the pieces into a left-leaning binary chain: ((((p0 + p1) + p2) + p3) ...)
  let expr: ExprIR = pieces[0]!;
  for (let i = 1; i < pieces.length; i++) {
    expr = concat(expr, pieces[i]!);
  }

  return {
    name: "inspect",
    type: STRING,
    expr,
  };
}

/** Short structural name for a TypeIR — used as the placeholder text
 * for non-stringifiable field types in the synthesized inspect form. */
function typeShorthand(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "id":
      return `${t.targetName} id`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `${typeShorthand(t.element)}[]`;
    case "optional":
      return `${typeShorthand(t.inner)}?`;
    case "action":
    case "slot":
      return "slot";
    case "genericInstance":
      // Enrichment runs before the IR-validate gate, so a `paged` /
      // `envelope` instance can legitimately reach here; render readable
      // postfix text rather than throwing.
      return `${typeShorthand(t.arg)} ${t.ctor}`;
    case "union":
      // Likewise reachable pre-gate (`A or B`, `T option`) — readable text.
      return t.variants.map(typeShorthand).join(" or ");
    case "none":
      return "none";
  }
}

/** Derive a join-table association for every field whose type is a
 * collection of references to another aggregate (`field: T id[]`).
 * Containment collections never reach here — they are `ContainmentIR`,
 * not `FieldIR`. */
function associationsForAggregate(agg: AggregateIR): AssociationIR[] {
  const out: AssociationIR[] = [];
  for (const f of agg.fields) {
    if (f.type.kind !== "array" || f.type.element.kind !== "id") continue;
    const target = f.type.element;
    let ownerFk = `${snake(agg.name)}_id`;
    let targetFk = `${snake(target.targetName)}_id`;
    // Self-referential collection (`Self id[]`): both FKs would
    // collapse to the same column name.  Disambiguate generically.
    if (ownerFk === targetFk) {
      ownerFk = "owner_id";
      targetFk = "target_id";
    }
    out.push({
      fieldName: f.name,
      ownerAgg: agg.name,
      targetAgg: target.targetName,
      valueType: target.valueType,
      joinTable: `${snake(agg.name)}_${snake(f.name)}`,
      ownerFk,
      targetFk,
    });
  }
  return out;
}

function enrichPart(part: EntityPartIR): EnrichedEntityPartIR {
  const fields = part.fields.map(resolveFieldAccess);
  const resolved: EntityPartIR = { ...part, fields };
  return { ...resolved, wireShape: wireFieldsForPart(resolved) };
}

function enrichValueObject(vo: ValueObjectIR): EnrichedValueObjectIR {
  const fields = vo.fields.map(resolveFieldAccess);
  const resolved: ValueObjectIR = { ...vo, fields };
  return { ...resolved, wireShape: wireFieldsForValueObject(resolved) };
}

/** Resolve a field's access role.  Precedence:
 *   1. Declared modifier in the source (`lowerField` carried it through).
 *   2. Default — `editable`.
 *
 * NOTE: there is intentionally no type-driven inference for `X id`
 * fields.  A declared `X id` is a foreign-key reference — the client
 * supplies it (e.g. `holder: Customer id` on `Account.create(holder)`)
 * so it must default to editable, not `token`.  The aggregate's own
 * synthetic identity is added separately by `wireFieldsForAggregate`
 * with `access: "token"` hardcoded.  Explicit token semantics for a
 * declared field (e.g. `version: int token` for optimistic concurrency)
 * are opt-in via the `token` modifier in source.
 *
 * Idempotent: a field that already carries `access` (set on a previous
 * enrichment pass or by a declared modifier) is returned unchanged. */
function resolveFieldAccess(f: FieldIR): FieldIR {
  if (f.access) return f;
  return { ...f, access: "editable", accessSource: "default" };
}

/** Every aggregate gets a repository with an implicit `find all():
 * T[]` query, mirroring how `findById` is implicit.  If the user
 * already declared a `find all(...)` of any shape, theirs wins. */
function ensureFindAll(
  aggregates: EnrichedAggregateIR[],
  existing: RepositoryIR[],
): RepositoryIR[] {
  const out = existing.map((r) => ({ ...r, finds: [...r.finds] }));
  for (const agg of aggregates) {
    // Abstract bases (aggregate-inheritance.md) are never instantiated and
    // own no repository — `loom.abstract-repository` rejects an explicit one,
    // and we must not synthesise an implicit `findAll` repo for them either
    // (it would dangle against a base that emits no table). Concretes carry
    // the base's fields via the wireShape merge and keep their own findAll.
    if (agg.isAbstract) continue;
    let repo = out.find((r) => r.aggregateName === agg.name);
    if (!repo) {
      repo = { name: `${agg.name}s`, aggregateName: agg.name, finds: [] };
      out.push(repo);
    }
    if (!repo.finds.some((f) => f.name === "all")) {
      const all: FindIR = {
        name: "all",
        params: [],
        returnType: { kind: "array", element: { kind: "entity", name: agg.name } },
      };
      repo.finds = [all, ...repo.finds];
    }
  }
  return out;
}

/** React frontends inherit their context set from `targets:` so every
 * place that walks `contextNames` sees the same surface the backend
 * exposes.  No-op if the target isn't found (validator already
 * rejects that case). */
function enrichDeployables(deployables: DeployableIR[]): DeployableIR[] {
  return deployables.map((d) => {
    // `static` deployables share the legacy `react` context-
    // inheritance behaviour — they're frontend deployables that
    // serve a built bundle and need to know about every context the
    // target backend exposes (so the page-IR emitter has every
    // aggregate's wire shape in scope).
    //
    // Routed through `PlatformSurface.isFrontend` so there is one
    // source of truth.  The registry import is safe: `registry.ts`
    // only imports per-platform `Surface` impls (none of which
    // import back into `ir/`), so no cycle.  The `needsDb` check in
    // `assignMigrationsOwner` above is routed through the same
    // registry — no hardcoded platform-name lists remain.
    if (!platformFor(d.platform).isFrontend || !d.targetName) return d;
    const target = deployables.find((t) => t.name === d.targetName);
    if (!target) return d;
    return { ...d, contextNames: [...target.contextNames] };
  });
}

// ---------------------------------------------------------------------------
// Wire-shape derivation.
//
// The single source of truth for the canonical JSON shape an
// aggregate / part / value object takes on the network.  Every wire
// emitter (Hono routes, Hono `toWire`, .NET DTOs + projection,
// React Zod schemas) walks this list — order is the contract:
//
//   1. `id`              — always first (aggregates / parts only)
//   2. each `Property`   — declaration order
//   3. each `Containment` — declaration order, array vs single
//   4. each `Derived`    — declaration order
//
// Value objects skip steps 1 + 3 (no identity, no containment).
// ---------------------------------------------------------------------------

function wireFieldsForAggregate(agg: AggregateIR): WireField[] {
  const out: WireField[] = [
    { name: "id", type: idTypeFor(agg.name), optional: false, source: "id", access: "token" },
  ];
  for (const f of agg.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const c of agg.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: !!c.optional && !c.collection,
      source: "containment",
      access: "editable",
    });
  }
  for (const d of agg.derived) {
    // `inspect` is the host-language debug-string hook (ToString /
    // util.inspect.custom / Inspect protocol) — emitted as a getter on
    // the domain class but kept out of JSON DTOs.  Exposing the
    // structural form on the wire would leak internal field layout to
    // every API client.
    if (d.name === "inspect") continue;
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

function wireFieldsForPart(part: EntityPartIR): WireField[] {
  const out: WireField[] = [
    { name: "id", type: idTypeFor(part.name), optional: false, source: "id", access: "token" },
  ];
  for (const f of part.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const c of part.contains) {
    out.push({
      name: c.name,
      type: containmentTypeFor(c.partName, c.collection),
      optional: !!c.optional && !c.collection,
      source: "containment",
      access: "editable",
    });
  }
  for (const d of part.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

function wireFieldsForValueObject(vo: ValueObjectIR): WireField[] {
  const out: WireField[] = [];
  for (const f of vo.fields) {
    out.push({
      name: f.name,
      type: f.type,
      optional: f.optional,
      source: "property",
      access: f.access ?? "editable",
    });
  }
  for (const d of vo.derived) {
    out.push({
      name: d.name,
      type: d.type,
      optional: false,
      source: "derived",
      access: "editable",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Traceability index — derived in one pure pass, exactly
// like wireShape.  Every report generator reads these maps rather than
// recomputing coverage.
// ---------------------------------------------------------------------------

/** One executable test (aggregate `test` / system `test e2e`) flattened
 *  out of the model with its optional `verifies <TestCase>` back-link. */
interface ExecTest {
  name: string;
  /** Runner-reported suite: aggregate name (unit) or `"<System> e2e"`. */
  suite: string;
  kind: "unit" | "api" | "ui";
  verifiesTestCase?: string;
}

function collectExecTests(loom: LoomModel): ExecTest[] {
  const out: ExecTest[] = [];
  // Aggregate `test "..."` blocks → `describe("<agg>")` in the
  // generated `domain/<agg>.test.ts`, so the runner reports
  // `suite = agg.name`.
  const fromContext = (ctx: BoundedContextIR): void => {
    for (const agg of ctx.aggregates) {
      for (const t of agg.tests) {
        out.push({
          name: t.name,
          suite: agg.name,
          kind: "unit",
          verifiesTestCase: t.verifiesTestCase,
        });
      }
    }
  };
  for (const sys of loom.systems) {
    for (const mod of sys.subdomains) for (const ctx of mod.contexts) fromContext(ctx);
    // System `test e2e "..."` → `describe("<System> e2e")`, so the
    // runner reports `suite = "<sys.name> e2e"`.
    for (const t of sys.e2eTests) {
      out.push({
        name: t.name,
        suite: `${sys.name} e2e`,
        kind: t.kind,
        verifiesTestCase: t.verifiesTestCase,
      });
    }
  }
  for (const ctx of loom.contexts) fromContext(ctx);
  return out;
}

function computeTraceability(loom: LoomModel): TraceabilityIR {
  const childrenOf: Record<string, string[]> = {};
  for (const r of loom.requirements) childrenOf[r.id] ??= [];
  for (const r of loom.requirements) {
    // biome-ignore lint/suspicious/noAssignInExpressions: `(map[k] ??= []).push(v)` is the canonical bucket-push idiom used throughout this file
    if (r.parentId) (childrenOf[r.parentId] ??= []).push(r.id);
  }

  // Transitive descendants of every requirement (id included excluded).
  const descendantsOf = (id: string): string[] => {
    const acc: string[] = [];
    const stack = [...(childrenOf[id] ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue; // guard against accidental cycles
      seen.add(cur);
      acc.push(cur);
      stack.push(...(childrenOf[cur] ?? []));
    }
    return acc;
  };

  // TestCases keyed by the requirement they directly verify.
  const directTests: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    // biome-ignore lint/suspicious/noAssignInExpressions: `(map[k] ??= []).push(v)` is the canonical bucket-push idiom used throughout this file
    (directTests[tc.verifies] ??= []).push(tc.id);
  }

  const testsByRequirement: Record<string, string[]> = {};
  for (const r of loom.requirements) {
    const ids = new Set<string>(directTests[r.id] ?? []);
    for (const d of descendantsOf(r.id)) {
      for (const t of directTests[d] ?? []) ids.add(t);
    }
    testsByRequirement[r.id] = [...ids];
  }

  const solutionByRequirement: Record<string, string | null> = {};
  for (const r of loom.requirements) solutionByRequirement[r.id] = null;
  for (const s of loom.solutions) {
    if (
      s.forRequirement in solutionByRequirement &&
      solutionByRequirement[s.forRequirement] === null
    ) {
      solutionByRequirement[s.forRequirement] = s.id;
    }
  }

  const codeElements: Record<string, CodeRefKind> = {};
  for (const s of loom.solutions)
    for (const c of s.entitles) codeElements[c.qualifiedName] = c.kind;
  for (const tc of loom.testCases)
    for (const c of tc.covers) codeElements[c.qualifiedName] = c.kind;

  const testsByCodeElement: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    for (const c of tc.covers) {
      // biome-ignore lint/suspicious/noAssignInExpressions: `(map[k] ??= []).push(v)` is the canonical bucket-push idiom used throughout this file
      (testsByCodeElement[c.qualifiedName] ??= []).push(tc.id);
    }
  }

  // Executable-test back-links: TestCase id → exec test names, plus a
  // flat provenance list (suite + kind) for the verification join.
  const allExecTests = collectExecTests(loom);
  const execTestsByTestCase: Record<string, string[]> = {};
  for (const tc of loom.testCases) execTestsByTestCase[tc.id] = [];
  for (const ex of allExecTests) {
    if (ex.verifiesTestCase && ex.verifiesTestCase in execTestsByTestCase) {
      execTestsByTestCase[ex.verifiesTestCase].push(ex.name);
    }
  }
  const execTests = allExecTests.map((ex) => ({
    name: ex.name,
    suite: ex.suite,
    kind: ex.kind,
    testCaseId: ex.verifiesTestCase ?? null,
  }));

  // Propagate exec tests to the code elements their TestCase covers.
  const execTestsByCodeElement: Record<string, string[]> = {};
  for (const tc of loom.testCases) {
    const execs = execTestsByTestCase[tc.id] ?? [];
    if (execs.length === 0) continue;
    for (const c of tc.covers) {
      // biome-ignore lint/suspicious/noAssignInExpressions: bind the bucket once before the inner loop dedupes-and-pushes
      const bucket = (execTestsByCodeElement[c.qualifiedName] ??= []);
      for (const e of execs) if (!bucket.includes(e)) bucket.push(e);
    }
  }

  return {
    childrenOf,
    testsByRequirement,
    solutionByRequirement,
    codeElements,
    testsByCodeElement,
    execTestsByCodeElement,
    execTestsByTestCase,
    execTests,
  };
}

function idTypeFor(targetName: string): TypeIR {
  return { kind: "id", targetName, valueType: "guid" };
}

function containmentTypeFor(partName: string, collection: boolean): TypeIR {
  return collection
    ? { kind: "array", element: { kind: "entity", name: partName } }
    : { kind: "entity", name: partName };
}
