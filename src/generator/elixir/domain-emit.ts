import { wireCreateDefault } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  FieldIR,
  FunctionIR,
  InvariantIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { discriminatorValue, isTphConcrete, tableOwnerName } from "../../ir/util/inheritance.js";
import { effectiveSavingShape } from "../../ir/util/resolve-datasource.js";
import { singleFieldShape } from "../../ir/validate/invariant-classify.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderActions, renderPolicies, renderPolicyChecks } from "./domain/actions.js";
import {
  ashBuiltinValidate,
  exprRefsNonAttribute,
  exprUsesThis,
  isGuardedOperation,
  isRefCollection,
  isRelationshipCountDerive,
  plural,
} from "./domain/predicates.js";
import { renderJasonEncoderImpl } from "./jason-camel-emit.js";
import { joinEntityName } from "./join-resource-emit.js";
import {
  type RenderCtx,
  relationshipNameFor,
  renderAshType,
  renderExpr,
  renderTypespec,
} from "./render-expr.js";
import {
  criterionCalcName,
  reifiedCriteriaFor,
  reifiedCriterionForRef,
  renderCriterionCalculation,
} from "./repository-emit.js";

/** Per-aggregate dataSource lookup the orchestrator passes in.  When
 *  present, the resource's `postgres do … end` block picks up the
 *  binding's `schema` (defaulted to `snake(context.name)` when DSL
 *  omits it) / `tablePrefix` config.  Returns `undefined` →
 *  byte-identical with the pre-dataSource resource emit. */
export type DataSourceLookup = (
  agg: AggregateIR,
) => import("../../ir/util/resolve-datasource.js").ResolvedDataSource | undefined;

export function emitAggregateResources(
  ctx: EnrichedBoundedContextIR,
  appModule: string,
  appSnake: string,
  options: { resolveDataSource?: DataSourceLookup } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
  const ctxSnake = snake(ctx.name);

  for (const agg of ctx.aggregates) {
    // An abstract TPC (`ownTable`) base owns no table and is never
    // instantiated — it emits no Ash.Resource (the polymorphic read home is a
    // function on the context domain module; see renderDomainModule).  Each
    // concrete subtype is a standalone resource carrying the merged base fields.
    if (agg.isAbstract) continue;
    const ds = options.resolveDataSource?.(agg);
    // `shape(embedded)`: contained parts fold into a jsonb column on the
    // root via Ash embedded resources (`attribute :items, {:array,
    // Part}`) instead of child tables + `has_many`.  The root stays a
    // postgres-backed resource; the part becomes `data_layer: :embedded`.
    const embedded = effectiveSavingShape(agg, ds) === "embedded";
    const aggOpts = { schema: ds?.schema, prefix: ds?.tablePrefix, embedded };
    const path = `lib/${appSnake}/${ctxSnake}/${snake(agg.name)}.ex`;
    out.set(path, renderAggregateResource(agg, ctx, appModule, ctxModule, aggOpts));
    for (const part of agg.parts) {
      const partPath = `lib/${appSnake}/${ctxSnake}/${snake(part.name)}.ex`;
      out.set(partPath, renderEntityPartResource(part, agg, ctx, appModule, ctxModule, aggOpts));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate → Ash.Resource
// ---------------------------------------------------------------------------

function renderAggregateResource(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  appModule: string,
  ctxModule: string,
  options: { schema?: string; prefix?: string; embedded?: boolean } = {},
): string {
  const embedded = !!options.embedded;
  const moduleName = `${ctxModule}.${upperFirst(agg.name)}`;
  // TPH (`sharedTable`): a concrete maps to its base's shared table and carries
  // a `kind` discriminator (value = its own name), `base_filter`'d so it
  // reads/writes only its rows.  `tableOwnerName` returns the base for a TPH
  // concrete and the aggregate itself otherwise, so off the TPH path this is
  // byte-identical.  (Ash has no native STI — see docs/proposals/phoenix-tph-emission.md.)
  const tphConcrete = isTphConcrete(agg, ctx.aggregates);
  const kindValue = tphConcrete ? discriminatorValue(agg, ctx.aggregates) : undefined;
  const baseTable = snake(plural(tableOwnerName(agg, ctx.aggregates)));
  const tableSnake = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const repoModule = `${appModule}.Repo`;
  // AshPostgres `postgres do` block — table + repo always present;
  // `schema "<name>"` only when the dataSource binding declares one.
  // Same pattern Ash docs use for placing a resource in a non-`public`
  // Postgres schema.
  const postgresBlockLines: string[] = [
    `    table "${tableSnake}"`,
    ...(options.schema ? [`    schema "${options.schema}"`] : []),
    `    repo ${repoModule}`,
  ];

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: ctxModule,
    typesModule: `${appModule}.Types`,
    agg,
  };

  // Reference-collection fields (`Id<T>[]`) are persisted via a separate
  // join table (see join-resource-emit.ts), not as a column on this row.
  // Skip them in the attribute list and the @derive Jason list (Jason
  // serialises attributes / loaded calculations; the calculation we
  // emit below is unloaded by default and would surface as nil — so
  // it's intentionally absent from the wire shape until the caller
  // explicitly loads it).
  const associations = agg.associations;
  const persistedFields = agg.fields.filter((f) => !isRefCollection(f.type));

  // Capability filters (`filter <expr>` → contextFilters).  Ash's analog
  // to EF Core's HasQueryFilter is `base_filter` — applied to every read
  // of the resource.  Only non-principal predicates reach codegen here;
  // principal-referencing filters (tenancy) and non-relational shapes are
  // deferred and rejected by the IR validator
  // (`validatePhoenixContextFilterSupport`).  Renders the same
  // `record.<field>` form the find-action filters use (the established,
  // Ash-valid convention).
  // A TPH concrete prepends `kind == "<Concrete>"` to its base_filter so every
  // read of the shared table is scoped to this concrete's rows (Ash's analog to
  // the discriminator filter EF Core / Drizzle apply).
  const kindPredicate = kindValue ? `kind == ${JSON.stringify(kindValue)}` : undefined;
  const baseFilterLine = renderBaseFilter(agg, renderCtx, ctx, kindPredicate);

  // Field list for the `defimpl Jason.Encoder` block: :id, persisted
  // fields only, timestamps.  Reference-collection fields are excluded
  // (lazy-loaded via the join table; would surface as nil otherwise).
  // Embedded (`shape(embedded)`) containment attributes: each `contains`
  // becomes `attribute :<name>, {:array, <Part>}` (collection) /
  // `attribute :<name>, <Part>` (single), where `<Part>` is the
  // `data_layer: :embedded` resource — Ash stores it inline as jsonb.
  const embeddedAttrLines = embedded
    ? agg.contains.map((c) => {
        const partMod = `${ctxModule}.${upperFirst(c.partName)}`;
        return c.collection
          ? `attribute :${snake(c.name)}, {:array, ${partMod}}, default: []`
          : `attribute :${snake(c.name)}, ${partMod}`;
      })
    : [];

  const wireAtoms = [
    ":id",
    // The TPH discriminator is part of the wire shape (tells the client which
    // concrete a row is), mirroring the `kind`/`type` tag on the other backends.
    ...(kindValue ? [":kind"] : []),
    ...persistedFields.map((f) => `:${snake(f.name)}`),
    // Embedded containments serialise inline (each has its own Jason
    // encoder); add them to the wire shape.  Relational containments are
    // separate relationships and stay out of the attribute encoder.
    ...(embedded ? agg.contains.map((c) => `:${snake(c.name)}`) : []),
    ":inserted_at",
    ":updated_at",
  ];

  // `inspect` derived → public `def inspect(record)` module function.
  //
  // Enrichment auto-injects a structural `derived inspect: string = ...`
  // on every aggregate; the .NET and TS backends emit it as `ToString()`
  // / `[util.inspect.custom]` so debugger output / exception messages
  // honour `sensitive(...)` redaction.
  //
  // Phoenix emits this as a regular **module function** rather than a
  // `defimpl Inspect`: a protocol impl would collide with Ash 3.x's
  // auto-derived Inspect (`warning: redefining module
  // Inspect.<App>.<Ctx>.<Agg>` under `--warnings-as-errors`).  Callers
  // invoke it explicitly (`Customer.inspect(record)` from Logger / IEx)
  // instead of relying on `Kernel.inspect/1`.  No collision because the
  // two live in different modules (`MyApp.Catalog.Customer.inspect/1`
  // vs `Inspect.MyApp.Catalog.Customer.inspect/2`).
  //
  // Implemented as a module function rather than an Ash `calculate
  // :inspect`: Ash's `expr()` DSL doesn't admit `<>` / `to_string/1`,
  // but module-function bodies are native Elixir.
  const inspectDerived = agg.derived.find((d) => d.name === "inspect");
  const inspectFn = inspectDerived
    ? `\n  @spec inspect(t()) :: String.t()\n  def inspect(record) do\n    ${renderExpr(inspectDerived.expr, renderCtx)}\n  end\n`
    : "";

  // camelCase wire-shape Jason encoder.  Pairs with the resource
  // module — same struct, separate protocol impl.  Cross-backend
  // parity: matches Hono / .NET key casing without per-resource
  // duplication of the conversion fn.
  const jasonImpl = renderJasonEncoderImpl(moduleName, wireAtoms, appModule);

  // Authorization: aggregates with `requires`-guarded operations opt into
  // Ash.Policy.Authorizer; the `policies` block + per-op SimpleCheck modules
  // enforce the guard, surfacing failures as Ash.Error.Forbidden → 403.
  // The check modules are emitted BEFORE the resource: `authorize_if <Check>`
  // calls `Check.init/1` at the resource's compile time, so the check must
  // already be compiled (a forward reference in the same file fails with
  // "module is not available").
  const hasGuards = agg.operations.some(isGuardedOperation);
  const authorizerLine = hasGuards ? ",\n    authorizers: [Ash.Policy.Authorizer]" : "";
  const policiesBlock = renderPolicies(agg, moduleName);
  const policyChecks = renderPolicyChecks(agg, renderCtx, moduleName);
  const checksPrefix = policyChecks ? `${policyChecks}\n\n` : "";

  // Reified-criterion boolean calculations: each named `criterion` a
  // retrieval targeting this aggregate reifies to becomes a `calculate
  // :<name>, :boolean, expr(…)` the retrieval read action filters by.
  const criterionCalcLines = reifiedCriteriaFor(ctx, agg).map((c) =>
    renderCriterionCalculation(c, agg, ctxModule),
  );

  return `${checksPrefix}defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer${authorizerLine}

  postgres do
${postgresBlockLines.join("\n")}
  end
${baseFilterLine}
  attributes do
    ${renderPrimaryKey(agg.idValueType)}
    ${[...(kindValue ? [`attribute :kind, :string, default: ${JSON.stringify(kindValue)}, allow_nil?: false`] : []), ...persistedFields.map((f) => renderAttribute(f, ctxModule)), ...embeddedAttrLines].join("\n    ")}
    timestamps()
  end
${renderRelationships(embedded ? [] : agg.contains, associations, ctxModule, agg)}${renderAggregates(agg.derived, embedded ? [] : agg.contains)}${renderCalculations(agg.derived, associations, renderCtx, agg, criterionCalcLines)}${renderPreparations(associations, agg)}${renderValidations(agg.invariants, renderCtx, new Set(agg.fields.map((f) => f.name)))}${renderActions(agg, ctx, renderCtx, ctxModule)}${policiesBlock}${renderHelperFunctions(agg.functions, renderCtx)}${inspectFn}end

${jasonImpl}`;
}

// ---------------------------------------------------------------------------
// Entity part → Ash.Resource (embedded)
// ---------------------------------------------------------------------------

function renderEntityPartResource(
  part: EntityPartIR,
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  appModule: string,
  ctxModule: string,
  options: { schema?: string; prefix?: string; embedded?: boolean } = {},
): string {
  const moduleName = `${ctxModule}.${upperFirst(part.name)}`;
  const renderCtxEmbedded: RenderCtx = {
    thisName: "record",
    contextModule: ctxModule,
    typesModule: `${appModule}.Types`,
  };

  // Embedded (`shape(embedded)`): the part has no table of its own — it
  // is stored inline in its parent's jsonb column.  So `data_layer:
  // :embedded`, no `postgres do`, no parent FK / `belongs_to`, no
  // timestamps (the parent row carries those); just id + fields +
  // validations + the standard embedded actions.  Its Jason encoder
  // serialises only id + fields.
  if (options.embedded) {
    const partAtoms = [":id", ...part.fields.map((f) => `:${snake(f.name)}`)];
    const jasonImplEmbedded = renderJasonEncoderImpl(moduleName, partAtoms, appModule);
    return `defmodule ${moduleName} do
  use Ash.Resource,
    data_layer: :embedded

  attributes do
    uuid_primary_key :id
    ${part.fields.map((f) => renderAttribute(f, ctxModule)).join("\n    ")}
  end
${renderValidations(part.invariants, renderCtxEmbedded, new Set(part.fields.map((f) => f.name)))}
  actions do
    defaults [:read, :create, :update, :destroy]
  end
${renderHelperFunctions(part.functions, renderCtxEmbedded)}end

${jasonImplEmbedded}`;
  }

  const baseTable = snake(plural(part.name));
  const tableSnake = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const repoModule = `${appModule}.Repo`;
  const parentFk = `${snake(part.parentName)}_id`;
  // Parts inherit the owning aggregate's `schema` from the same
  // dataSource binding — no separate per-part config today.
  const postgresBlockLines: string[] = [
    `    table "${tableSnake}"`,
    ...(options.schema ? [`    schema "${options.schema}"`] : []),
    `    repo ${repoModule}`,
  ];

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: ctxModule,
    typesModule: `${appModule}.Types`,
  };

  // camelCase wire-shape Jason encoder (matches aggregate behaviour).
  // Excludes the parent FK from the wire — parts are embedded under
  // their parent's containment list, so the parent reference is
  // implicit, same as Hono / .NET strip it from the DTO.
  const partAtoms = [
    ":id",
    ...part.fields.map((f) => `:${snake(f.name)}`),
    ":inserted_at",
    ":updated_at",
  ];
  const jasonImpl = renderJasonEncoderImpl(moduleName, partAtoms, appModule);

  return `defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
${postgresBlockLines.join("\n")}
  end

  attributes do
    uuid_primary_key :id
    attribute :${parentFk}, :uuid, allow_nil?: false
    ${part.fields.map((f) => renderAttribute(f, ctxModule)).join("\n    ")}
    timestamps()
  end

  relationships do
    belongs_to :${snake(part.parentName)}, ${ctxModule}.${upperFirst(agg.name)}
  end
${renderValidations(part.invariants, renderCtx, new Set(part.fields.map((f) => f.name)))}
  actions do
    defaults [:read, :destroy]

    create :create do
      primary? true
      accept [${part.fields.map((f) => `:${snake(f.name)}`).join(", ")}]
    end
  end
${renderHelperFunctions(part.functions, renderCtx)}end

${jasonImpl}`;
}

// ---------------------------------------------------------------------------
// Primary key
// ---------------------------------------------------------------------------

/** Render an Ash `base_filter` from an aggregate's non-principal
 *  capability filters (`filter <expr>` → contextFilters), or "" when it
 *  has none.  `base_filter` is Ash's analog to EF Core's HasQueryFilter:
 *  it applies to every read of the resource.  Multiple predicates are
 *  conjoined with Ash's `and`.  Principal-referencing predicates are
 *  excluded here (the IR validator rejects them on Phoenix), so what
 *  remains renders to a closed Ash expression.  Returns a `resource do
 *  base_filter … end` block that splices after the `postgres do` block
 *  (leading newline so the module template stays readable when absent) —
 *  in Ash 3.x `base_filter` is a DSL entry inside the `resource` section,
 *  not a top-level resource macro.
 *
 *  Ash filter expressions reference the row's own attributes by BARE
 *  name (`is_deleted`), and related attributes by relationship path
 *  (`address.postal_code`) — there is no `record`/`self` receiver. The
 *  shared `renderExpr` threads `thisName` as the receiver, so we render
 *  with `record` and strip the leading `record.` from each reference
 *  (`record.address.postal_code` → `address.postal_code`). */
function renderBaseFilter(
  agg: AggregateIR,
  ctx: RenderCtx,
  bctx: BoundedContextIR,
  extraPredicate?: string,
): string {
  const refs = agg.contextFilterRefs ?? [];
  const capability = (agg.contextFilters ?? [])
    .map((predicate, i) => ({ predicate, ref: refs[i] }))
    .filter(({ predicate }) => !exprUsesCurrentUser(predicate))
    .map(({ predicate, ref }) => {
      // A filter that is *exactly* one named `criterion` reifies: reference
      // its boolean calculation (defined alongside via `reifiedCriteriaFor`)
      // instead of inlining the predicate — the Phoenix analog of Hono's
      // module-level `<name>Criterion` fn, byte-identical in behaviour (the
      // calc body IS the predicate).  Mirrors the find/retrieval use-site:
      // a zero-arg criterion is a bare calc atom, an N-arg one pairs each
      // parameter name with the filter's call-site argument.
      const reified = ref ? reifiedCriterionForRef(ref, bctx) : undefined;
      if (reified) {
        const callArgs = reified.params.map((param, j) => {
          const val = renderExpr(ref!.args[j]!, {
            ...ctx,
            thisName: "record",
            filterArgs: true,
          }).replace(/\brecord\./g, "");
          return `${snake(param.name)}: ${val}`;
        });
        return callArgs.length === 0
          ? criterionCalcName(reified.name)
          : `${criterionCalcName(reified.name)}(${callArgs.join(", ")})`;
      }
      return renderExpr(predicate, { ...ctx, thisName: "record" }).replace(/\brecord\./g, "");
    });
  // The TPH `kind` discriminator (when present) leads the conjunction, then the
  // aggregate's own capability filters.
  const rendered = [...(extraPredicate ? [extraPredicate] : []), ...capability];
  if (rendered.length === 0) return "";
  const body = rendered.length === 1 ? rendered[0]! : `and(${rendered.join(", ")})`;
  // `base_filter` is declared inside the `resource do … end` DSL section in
  // Ash 3.x — it is not a top-level resource macro.
  return `\n  resource do\n    base_filter expr(${body})\n  end\n`;
}

function renderPrimaryKey(idValueType: string): string {
  switch (idValueType) {
    case "int":
      return "integer_primary_key :id";
    case "long":
      return "integer_primary_key :id";
    case "string":
      return "attribute :id, :string, primary_key?: true, allow_nil?: false";
    default:
      return "uuid_primary_key :id";
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function renderAttribute(f: FieldIR, ctxModule: string): string {
  const ashType = renderAshType(f.type, ctxModule);
  const allowNil = f.optional ? "true" : "false";
  // An explicit `= default` makes the field optional input: Ash applies the
  // default when the create action omits it, so it drops from the required
  // set (see `wireCreateDefault`).  Bool/optional optionality is unchanged.
  const d = wireCreateDefault(f);
  const def = d ? `, default: ${renderExpr(d)}` : "";
  return `attribute :${snake(f.name)}, ${ashType}, allow_nil?: ${allowNil}${def}`;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function renderRelationships(
  contains: ContainmentIR[],
  associations: AssociationIR[],
  ctxModule: string,
  agg: AggregateIR,
): string {
  if (contains.length === 0 && associations.length === 0) return "";
  const containLines = contains.map((c) => {
    const relName = snake(c.name);
    const destModule = `${ctxModule}.${upperFirst(c.partName)}`;
    if (c.collection) {
      return `    has_many :${relName}, ${destModule}`;
    }
    return `    has_one :${relName}, ${destModule}`;
  });
  const m2mLines = associations.flatMap((a) => {
    const rel = relationshipNameFor(agg, a.fieldName);
    const target = `${ctxModule}.${upperFirst(a.targetAgg)}`;
    const join = `${ctxModule}.${joinEntityName(a)}`;
    return [
      `    many_to_many :${rel}, ${target} do`,
      `      through ${join}`,
      `      source_attribute_on_join_resource :${snake(a.ownerFk)}`,
      `      destination_attribute_on_join_resource :${snake(a.targetFk)}`,
      `    end`,
    ];
  });
  const lines = [...containLines, ...m2mLines];
  return `\n  relationships do\n${lines.join("\n")}\n  end\n`;
}

function renderAggregates(derived: DerivedIR[], contains: ContainmentIR[]): string {
  const lines: string[] = [];
  for (const d of derived) {
    const rel = isRelationshipCountDerive(d, contains);
    if (rel) lines.push(`    count :${snake(d.name)}, :${snake(rel)}`);
  }
  if (lines.length === 0) return "";
  return `\n  aggregates do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Preparations (global read preparations)
// ---------------------------------------------------------------------------

/** When the aggregate has reference-collection fields, the calculations
 *  that re-expose them as `{:array, :uuid}` (see renderCalculations) need
 *  to be loaded on every read for the wire shape to materialise — Ash
 *  calculations are opt-in by default.  Emit a `preparations do prepare
 *  build(load: […]) end` block that applies to every read action on the
 *  resource (default `:read` + each custom `find`). */
function renderPreparations(associations: AssociationIR[], _agg: AggregateIR): string {
  if (associations.length === 0) return "";
  const fieldNames = associations.map((a) => `:${snake(a.fieldName)}`).join(", ");
  return `\n  preparations do\n    prepare build(load: [${fieldNames}])\n  end\n`;
}

function renderCalculations(
  derived: DerivedIR[],
  associations: AssociationIR[],
  ctx: RenderCtx,
  agg: AggregateIR,
  extraCalcLines: string[] = [],
): string {
  const derivedLines: string[] = [];
  for (const d of derived) {
    // Lifted to aggregates (count :rel) above; skip here.
    if (isRelationshipCountDerive(d, agg.contains)) continue;
    // The reserved `inspect` derived is realised as a public
    // `def inspect(record)` module function (see `inspectFn` in
    // `renderAggregateResource`).  Ash's `expr()` DSL doesn't admit
    // the `<>` / `to_string/1` shapes the synthesised expression uses,
    // so a `calculate :inspect, :string, expr(...)` would fail to
    // compile.  Module-function bodies are native Elixir — no
    // constraint.
    if (d.name === "inspect") continue;
    const ashType = renderAshType(d.type, ctx.contextModule);
    const exprStr = renderExpr(d.expr, ctx);
    derivedLines.push(`    calculate :${snake(d.name)}, ${ashType}, expr(${exprStr})`);
  }
  // Re-expose each reference collection as a calculation that maps the
  // m2m relationship to a list of target ids — same wire shape as the
  // TS/Hono `party: string[]` and .NET `List<TargetId> Party`.  Loaded
  // explicitly on demand (callers add `load: [:party, :caught]`); not
  // auto-derived into JSON to avoid an N+1 on every read.
  const assocLines = associations.map((a) => {
    const fieldName = snake(a.fieldName);
    const rel = relationshipNameFor(agg, a.fieldName);
    return `    calculate :${fieldName}, {:array, :uuid}, expr(${rel}.id)`;
  });
  // Reified-criterion boolean calculations (one per named criterion a
  // retrieval reifies to — see reifiedCriteriaFor / renderCriterionCalculation
  // in repository-emit).  Joins the derived + association calculations in the
  // single `calculations do … end` block.
  const lines = [...derivedLines, ...assocLines, ...extraCalcLines];
  if (lines.length === 0) return "";
  return `\n  calculations do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Validations (invariants)
// ---------------------------------------------------------------------------

function renderValidations(
  invariants: InvariantIR[],
  ctx: RenderCtx,
  /** Field names available on the resource — used for single-field
   *  pattern detection.  Pass an empty set to skip idiom detection. */
  fieldNames: ReadonlySet<string> = new Set(),
): string {
  if (invariants.length === 0) return "";
  const lines = invariants.map((inv) => {
    // Try to emit an idiomatic built-in Ash validator for single-field shapes
    // recognised by the invariant classifier.  These shapes are safe to run
    // at the domain layer regardless of the wire-boundary scope flag.
    const single = singleFieldShape(inv);
    if (single && fieldNames.has(single.field)) {
      const ashVal = ashBuiltinValidate(single.field, single.pattern);
      if (ashVal) {
        const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
        return `    ${ashVal}, message: ${msg}`;
      }
    }

    // Function form — covers guarded, cross-field, and anything the
    // classifier doesn't reduce to a single-field pattern.
    const condStr = renderExpr(inv.expr, ctx);
    const msg = JSON.stringify(`Invariant violated: ${inv.source}`);
    // `record` isn't a callback param of `validate fn changeset, _opts ->`,
    // so bind it when the predicate uses any `this`-family reference.  It
    // must carry the changeset's NEW values: on a create `changeset.data` is
    // the empty struct, so `record.<field>` would be nil — crashing a
    // `Regex.match?`/`String.length` predicate and making a cross-field
    // invariant (`handle != email`) compare nil to nil.  `apply_attributes`
    // (force? so it materialises mid-validation, before required-checks pass)
    // returns the would-be record with the casted attributes applied.
    const needsRecord = exprUsesThis(inv.expr) || (inv.guard ? exprUsesThis(inv.guard) : false);
    // `apply_attributes` materialises the new scalar values but leaves
    // relationships `%Ash.NotLoaded{}` and derived calcs unrun.  An invariant
    // that touches a containment (`pipelines.count`) or derived field must
    // therefore fall back to `changeset.data` — on a create its guard is
    // typically vacuously false (the attribute it keys on is nil), so it's
    // skipped rather than crashing on the unloaded relationship.  Attribute-
    // only invariants use the applied (new) values so create-time predicates
    // (`Regex.match?(record.email, …)`) see the submitted data, not nil.
    const refsNonAttr =
      exprRefsNonAttribute(inv.expr, fieldNames) ||
      (inv.guard ? exprRefsNonAttribute(inv.guard, fieldNames) : false);
    const recordLine = !needsRecord
      ? ""
      : refsNonAttr
        ? "      record = changeset.data\n"
        : "      {:ok, record} = Ash.Changeset.apply_attributes(changeset, force?: true)\n";
    if (inv.guard) {
      const guardStr = renderExpr(inv.guard, ctx);
      // Guard-first: when the guard is false the invariant doesn't apply
      // (not an error).  Emit as `not guard or cond` — matches the
      // logical-implication semantics of the source `guard => cond`.
      return `    validate fn changeset, _opts ->\n${recordLine}      if not (${guardStr}) or (${condStr}), do: :ok, else: {:error, ${msg}}\n    end`;
    }
    return `    validate fn changeset, _opts ->\n${recordLine}      if ${condStr}, do: :ok, else: {:error, ${msg}}\n    end`;
  });
  return `\n  validations do\n${lines.join("\n")}\n  end\n`;
}

// ---------------------------------------------------------------------------
// Authorization policies (`requires` guards → Ash.Policy.Authorizer)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper functions (`function` decls) — emitted as public `def` on the
// resource module so validate / change bodies can call them as
// `<name>(record, ...)`.  They are PUBLIC rather than `defp` deliberately: a
// domain `function` is a declared aggregate capability that may have no
// in-module caller (it can be invoked from elsewhere, or simply documents an
// intent), and Elixir's `--warnings-as-errors` rejects an unused *private*
// function.  Exposing them as module API is harmless and mirrors how the
// reserved `inspect` derived is realised as a public `def inspect(record)`.
// ---------------------------------------------------------------------------

function renderHelperFunctions(functions: FunctionIR[], ctx: RenderCtx): string {
  if (functions.length === 0) return "";
  const blocks = functions.map((fn) => {
    const params = ["record", ...fn.params.map((p) => snake(p.name))];
    const body = renderExpr(fn.body, ctx);
    const recordPrefix = exprUsesThis(fn.body) ? "" : "    _ = record\n";
    // @spec — `record` is the enclosing aggregate's struct (`t()` inside
    // the resource module), then each declared parameter, then the
    // function's return type.  Skipped when ctx.agg is unset (no
    // aggregate context → emit untyped so we don't fabricate a `t()`
    // that doesn't resolve).  `ctx.typesModule`, when set, routes
    // id / timestamp through the shared `<App>.Types` vocabulary.
    const specLine = ctx.agg
      ? `  @spec ${snake(fn.name)}(${["t()", ...fn.params.map((p) => renderTypespec(p.type, ctx.contextModule, ctx.typesModule))].join(", ")}) :: ${renderTypespec(fn.returnType, ctx.contextModule, ctx.typesModule)}\n`
      : "";
    // `@doc false` keeps the public helper out of generated docs without
    // making it private (which would re-introduce the unused-function warn).
    return `${specLine}  @doc false
  def ${snake(fn.name)}(${params.join(", ")}) do
${recordPrefix}    ${body}
  end`;
  });
  return `\n${blocks.join("\n\n")}\n`;
}
