import { platformFor } from "../platform/registry.js";
import { snake } from "../util/naming.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  CodeRefKind,
  DeployableIR,
  DerivedIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EnrichedLoomModel,
  EnrichedModuleIR,
  EnrichedSystemIR,
  EnrichedValueObjectIR,
  EntityPartIR,
  EnumIR,
  ExprIR,
  FieldIR,
  FindIR,
  LoomModel,
  ModuleIR,
  Platform,
  RawLoomModel,
  RepositoryIR,
  SystemIR,
  TraceabilityIR,
  TypeIR,
  ValueObjectIR,
  WireField,
} from "./loom-ir.js";

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
// Derivations applied (in order — each is independent):
//
//   1. Wire-shape on every aggregate / part / value object.
//   2. Auto-included `findAll` on every aggregate's repository.
//   3. React deployable `moduleNames` ← target deployable's modules.
//
// Idempotent: `enrich(enrich(m))` deep-equals `enrich(m)`.
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
  return {
    systems: loom.systems.map((s) => enrichSystem(s, enrichedRootVOs, rootEnums)),
    contexts: loom.contexts.map((c) => enrichContext(c, enrichedRootVOs, rootEnums)),
    rootValueObjects: enrichedRootVOs,
    rootEnums,
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
 * Note on the brand cascade: the surface contract still types
 * `emitProject(contexts: BoundedContextIR[])`, and the symmetric
 * `system/index.ts` helpers (`collectContextsFor`, `emitDeployable`)
 * use the raw structural type, so internal emitters that walk
 * `ctx.aggregates[i]` see `AggregateIR | EntityPartIR` at compile
 * time even though the runtime value is enriched.  Each of those
 * callers asserts the brand locally where it invokes `wireShapeFor`
 * (see grep "as EnrichedAggregateIR" — five sites).  Threading the
 * brand all the way through `surface.ts` + every `<platform>/emit.ts`
 * + every emitter helper (~224 typed sites) is a follow-up of its
 * own; until that lands, the local casts record the runtime invariant. */
export function wireShapeFor(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR | EnrichedValueObjectIR,
): WireField[] {
  return entity.wireShape;
}

function enrichSystem(
  sys: SystemIR,
  rootValueObjects: EnrichedValueObjectIR[],
  rootEnums: EnumIR[],
): EnrichedSystemIR {
  // First enrich each module's contexts (auto-findAll, wire-shape).
  const modules: EnrichedModuleIR[] = sys.modules.map((m) => ({
    ...m,
    contexts: m.contexts.map((c) => enrichContext(c, rootValueObjects, rootEnums)),
  }));
  // Then propagate react deployables' module sets from their targets.
  // Done after module enrichment so frontends see the same enriched
  // contexts every other consumer sees.
  const deployables = enrichDeployables(sys.deployables);
  // Derive `migrationsOwner` per module — the deployable responsible
  // for emitting schema migrations.  Runs last because it consults
  // the (now enriched) deployable list.  See `assignMigrationsOwner`.
  const modulesWithOwner = modules.map((m) => assignMigrationsOwner(m, deployables));
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
  return { ...sys, modules: modulesWithOwner, deployables };
}

// ---------------------------------------------------------------------------
// Migrations ownership — which deployable is responsible for emitting
// schema migrations against a given module.
//
// Rule (walk `sys.deployables` in declaration order):
//   1. First deployable with an explicit `primary` storage binding for
//      this module wins (`moduleBindings[].storages[].role === "primary"`).
//   2. Failing that, first deployable that includes the module in
//      `moduleNames` AND whose platform owns a database.
//   3. Failing both, leave `migrationsOwner` undefined — no backend
//      emits migrations for the module (frontend-only modules, etc.).
//
// Hardcoded `platformNeedsDb` list mirrors the `PlatformSurface.needsDb`
// flags in `src/platform/registry.ts` — kept in sync manually because
// `enrichments.ts` is platform-agnostic and can't import from registry.
// ---------------------------------------------------------------------------

function assignMigrationsOwner(m: EnrichedModuleIR, deployables: DeployableIR[]): EnrichedModuleIR {
  const explicit = deployables.find((d) =>
    d.moduleBindings.some(
      (mb) => mb.moduleName === m.name && mb.storages.some((s) => s.role === "primary"),
    ),
  );
  if (explicit) return { ...m, migrationsOwner: explicit.name };
  const implicit = deployables.find(
    (d) => d.moduleNames.includes(m.name) && platformNeedsDb(d.platform),
  );
  if (implicit) return { ...m, migrationsOwner: implicit.name };
  return m;
}

function platformNeedsDb(p: Platform): boolean {
  return p === "dotnet" || p === "hono" || p === "phoenixLiveView";
}

function enrichContext(
  ctx: BoundedContextIR,
  rootValueObjects: EnrichedValueObjectIR[],
  rootEnums: EnumIR[],
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
  const aggregates = ctx.aggregates.map((a) => enrichAggregate(a, valueObjects));
  const repositories = ensureFindAll(aggregates, ctx.repositories);
  return { ...ctx, valueObjects, enums, aggregates, repositories };
}

function enrichAggregate(agg: AggregateIR, contextVOs: ValueObjectIR[]): EnrichedAggregateIR {
  const parts = agg.parts.map(enrichPart);
  const fields = agg.fields.map(resolveFieldAccess);
  // Synthesize a `derived inspect: string = <structural>` when the user
  // didn't declare one.  Always-present after enrichment so backends
  // can emit a `ToString()` / `Inspect` / `util.inspect.custom` hook
  // unconditionally.  See plan
  // `/root/.claude/plans/i-think-we-have-glittery-lecun.md`.
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
  const resolved: AggregateIR = { ...agg, derived, fields };
  return {
    ...resolved,
    parts,
    wireShape: wireFieldsForAggregate(resolved),
    associations: associationsForAggregate(resolved),
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

  // Containments: short structural placeholder.  Recursing into the
  // contained inspect is a follow-up — keeps this first cut simple
  // and avoids cycles for self-containing parts (which are rare but
  // possible).
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

/** React frontends inherit their module set from `targets:` so every
 * place that walks `moduleNames` sees the same surface the backend
 * exposes.  No-op if the target isn't found (validator already
 * rejects that case). */
function enrichDeployables(deployables: DeployableIR[]): DeployableIR[] {
  return deployables.map((d) => {
    // `static` deployables share the legacy `react` module-
    // inheritance behaviour — they're frontend deployables that
    // serve a built bundle and need to know about every context the
    // target backend exposes (so the page-IR emitter has every
    // aggregate's wire shape in scope).
    //
    // Routed through `PlatformSurface.isFrontend` so there is one
    // source of truth.  The registry import is safe: `registry.ts`
    // only imports per-platform `Surface` impls (none of which
    // import back into `ir/`), so no cycle.  `platformNeedsDb`
    // above still mirrors `PlatformSurface.needsDb` inline only
    // because pulling it through the registry there would force an
    // identical import — kept consistent as a follow-up.
    if (!platformFor(d.platform).isFrontend || !d.targetName) return d;
    const target = deployables.find((t) => t.name === d.targetName);
    if (!target) return d;
    return { ...d, moduleNames: [...target.moduleNames] };
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
    for (const mod of sys.modules) for (const ctx of mod.contexts) fromContext(ctx);
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
