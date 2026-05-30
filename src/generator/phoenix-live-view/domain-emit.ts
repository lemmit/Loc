import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ContainmentIR,
  DerivedIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  ExprIR,
  FieldIR,
  FunctionIR,
  InvariantIR,
  OperationIR,
  StmtIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { effectiveSavingShape } from "../../ir/util/resolve-datasource.js";
import { classifyForWire, singleFieldShape } from "../../ir/validate/invariant-classify.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderJasonEncoderImpl } from "./jason-camel-emit.js";
import { joinEntityName } from "./join-resource-emit.js";
import { type RenderCtx, relationshipNameFor, renderAshType, renderExpr } from "./render-expr.js";
import { renderElixirStatements } from "./render-stmt.js";

/** True for a field type that is a collection of references
 * (`Id<T>[]`) — persisted via a join table, not a column. */
function isRefCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

// ---------------------------------------------------------------------------
// Ash domain emitter — per `AggregateIR` produce one `Ash.Resource` module.
//
// Output path:  lib/<app>/<ctx_snake>/<agg_snake>.ex
// Module name:  <AppModule>.<CtxModule>.<AggModule>
// ---------------------------------------------------------------------------

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
  const baseTable = snake(plural(agg.name));
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

  const renderCtx: RenderCtx = { thisName: "record", contextModule: ctxModule, agg };

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
  const baseFilterLine = renderBaseFilter(agg, renderCtx);

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
    ? `\n  def inspect(record) do\n    ${renderExpr(inspectDerived.expr, renderCtx)}\n  end\n`
    : "";

  // camelCase wire-shape Jason encoder.  Pairs with the resource
  // module — same struct, separate protocol impl.  Cross-backend
  // parity: matches Hono / .NET key casing without per-resource
  // duplication of the conversion fn.
  const jasonImpl = renderJasonEncoderImpl(moduleName, wireAtoms, appModule);

  return `defmodule ${moduleName} do
  use Ash.Resource,
    domain: ${ctxModule},
    data_layer: AshPostgres.DataLayer

  postgres do
${postgresBlockLines.join("\n")}
  end
${baseFilterLine}
  attributes do
    ${renderPrimaryKey(agg.idValueType)}
    ${[...persistedFields.map((f) => renderAttribute(f, ctxModule)), ...embeddedAttrLines].join("\n    ")}
    timestamps()
  end
${renderRelationships(embedded ? [] : agg.contains, associations, ctxModule, agg)}${renderAggregates(agg.derived, embedded ? [] : agg.contains)}${renderCalculations(agg.derived, associations, renderCtx, agg)}${renderPreparations(associations, agg)}${renderValidations(agg.invariants, renderCtx, new Set(agg.fields.map((f) => f.name)))}${renderActions(agg, ctx, renderCtx, ctxModule)}${renderHelperFunctions(agg.functions, renderCtx)}${inspectFn}end

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
  const renderCtxEmbedded: RenderCtx = { thisName: "record", contextModule: ctxModule };

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

  const renderCtx: RenderCtx = { thisName: "record", contextModule: ctxModule };

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
 *  remains renders to a closed Ash expression.  Returns a line that
 *  splices after the `postgres do` block (leading newline so the module
 *  template stays readable when absent).
 *
 *  Ash filter expressions reference the row's own attributes by BARE
 *  name (`is_deleted`), and related attributes by relationship path
 *  (`address.postal_code`) — there is no `record`/`self` receiver. The
 *  shared `renderExpr` threads `thisName` as the receiver, so we render
 *  with `record` and strip the leading `record.` from each reference
 *  (`record.address.postal_code` → `address.postal_code`). */
function renderBaseFilter(agg: AggregateIR, ctx: RenderCtx): string {
  const predicates = (agg.contextFilters ?? []).filter((p) => !exprUsesCurrentUser(p));
  if (predicates.length === 0) return "";
  const rendered = predicates.map((p) =>
    renderExpr(p, { ...ctx, thisName: "record" }).replace(/\brecord\./g, ""),
  );
  const body = rendered.length === 1 ? rendered[0]! : `and(${rendered.join(", ")})`;
  return `\n  base_filter expr(${body})\n`;
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
  return `attribute :${snake(f.name)}, ${ashType}, allow_nil?: ${allowNil}`;
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

// ---------------------------------------------------------------------------
// Calculations (derived properties)
//
// Derives whose body is a bare `<relationship>.count` are lifted out of
// the `calculations` block into an Ash `aggregates` block — `Enum.count`
// isn't a primitive in Ash's expression DSL, but `count :<rel>` is.
// ---------------------------------------------------------------------------

function isRelationshipCountDerive(d: DerivedIR, contains: ContainmentIR[]): string | null {
  const e = d.expr;
  if (e.kind !== "member" || e.member !== "count") return null;
  if (e.receiver.kind !== "ref") return null;
  if (e.receiver.refKind !== "this-prop") return null;
  const name = e.receiver.name;
  if (!contains.some((c) => c.name === name && c.collection)) return null;
  return name;
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
  const lines = [...derivedLines, ...assocLines];
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
    // so bind it from the changeset's loaded data when the predicate uses
    // any `this`-family reference.
    const needsRecord = exprUsesThis(inv.expr) || (inv.guard ? exprUsesThis(inv.guard) : false);
    const recordLine = needsRecord ? "      record = changeset.data\n" : "";
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
// Actions (operations)
// ---------------------------------------------------------------------------

function renderActions(
  agg: AggregateIR,
  _ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  ctxModule: string,
): string {
  const ops = agg.operations;
  // Ref-collection fields (`Id<T>[]`) aren't attributes on the
  // resource (they live in a join table); the create action can't
  // `accept` them without a `change manage_relationship` block, which
  // we defer.  Callers seed reference collections via the operations
  // that mutate them (`addToParty`, etc.).
  const fieldNames = agg.fields
    .filter((f) => !isRefCollection(f.type))
    .map((f) => `:${snake(f.name)}`);

  const defaultCreate = `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]
    end`;

  const opActions = ops.map((op) => renderOperationAction(op, renderCtx, ctxModule));

  return `\n  actions do
    defaults [:read, :update, :destroy]

${defaultCreate}
${opActions.join("\n")}
  end\n`;
}

// ---------------------------------------------------------------------------
// Helper functions (`function` decls) — emitted as `defp` on the resource
// module so validate / change bodies can call them as `<name>(record, ...)`.
// ---------------------------------------------------------------------------

function renderHelperFunctions(functions: FunctionIR[], ctx: RenderCtx): string {
  if (functions.length === 0) return "";
  const blocks = functions.map((fn) => {
    const params = ["record", ...fn.params.map((p) => snake(p.name))];
    const body = renderExpr(fn.body, ctx);
    const recordPrefix = exprUsesThis(fn.body) ? "" : "    _ = record\n";
    return `  defp ${snake(fn.name)}(${params.join(", ")}) do
${recordPrefix}    ${body}
  end`;
  });
  return `\n${blocks.join("\n\n")}\n`;
}

function renderOperationAction(op: OperationIR, ctx: RenderCtx, _ctxModule: string): string {
  const args = op.params
    .map((p) => `      argument :${snake(p.name)}, ${renderAshType(p.type, ctx.contextModule)}`)
    .join("\n");

  // Collect precondition statements and lower them to Ash validate clauses.
  const available = new Set(op.params.map((p) => p.name));
  const validateLines = renderOperationValidates(op, ctx, available);

  // Filter out precondition statements before rendering change block —
  // preconditions are emitted as validate clauses above, not in the change fn.
  const nonPrecondStmts = op.statements.filter((s) => s.kind !== "precondition");
  const stmts = renderElixirStatements(nonPrecondStmts, ctx, "changeset");

  // Bind the domain-style identifiers (`record`, `current_user`, each param)
  // that the rendered body refers to but Ash's `change fn changeset, ctx ->`
  // callback doesn't supply natively.  Detect which are actually used so the
  // block stays free of dead bindings.
  const usesRecord = nonPrecondStmts.some(stmtUsesThis);
  const usesCurrentUser = nonPrecondStmts.some((s) => stmtUsesCurrentUser(s));
  const usedParams = op.params.filter((p) => nonPrecondStmts.some((s) => stmtUsesParam(s, p.name)));
  const contextBinding = usesCurrentUser ? "context" : "_context";
  const bindings: string[] = [];
  if (usesRecord) bindings.push("        record = changeset.data");
  if (usesCurrentUser) bindings.push("        current_user = context.actor");
  for (const p of usedParams) {
    bindings.push(
      `        ${snake(p.name)} = Ash.Changeset.get_argument(changeset, :${snake(p.name)})`,
    );
  }
  const bindingBlock = bindings.length > 0 ? `${bindings.join("\n")}\n` : "";

  const argsBlock = op.params.length > 0 ? `\n${args}` : "";
  const validateBlock = validateLines.length > 0 ? `\n${validateLines.join("\n")}` : "";
  const changeBlock =
    nonPrecondStmts.length > 0
      ? `\n      change fn changeset, ${contextBinding} ->\n${bindingBlock}${stmts}\n        changeset\n      end`
      : "";

  // Ash 3.x rejects function-based changes as non-atomic and refuses to
  // register the action without an explicit opt-out.  Only flag actions
  // that actually emit a `change fn` body — when the operation is
  // validate-only (no non-precondition statements) the action is already
  // atomic-safe, and an unnecessary `require_atomic? false` is noise.
  const atomicLine = nonPrecondStmts.length > 0 ? "\n      require_atomic? false" : "";

  return `    update :${snake(op.name)} do${atomicLine}${argsBlock}${validateBlock}${changeBlock}
    end`;
}

/** True when `e` references `this` (or the bare `id` keyword, which renders
 *  as `<thisName>.id`) or any `this-prop`-family field. */
function exprUsesThis(e: ExprIR | undefined): boolean {
  if (!e) return false;
  if (e.kind === "this" || e.kind === "id") return true;
  if (
    e.kind === "ref" &&
    (e.refKind === "this-prop" || e.refKind === "this-vo-prop" || e.refKind === "this-derived")
  ) {
    return true;
  }
  if (e.kind === "call" && (e.callKind === "function" || e.callKind === "private-operation")) {
    // Receiver-prefixed function call passes `this` as first arg.
    return true;
  }
  return walkExpr(e, exprUsesThis);
}

function stmtUsesThis(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesThis(s.expr);
    case "assign":
    case "add":
    case "remove":
      return exprUsesThis(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesThis(f.value));
    case "call":
      // Receiver-prefixed call passes `this` as first arg.
      return true;
  }
}

function stmtUsesCurrentUser(s: StmtIR): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesCurrentUser(s.expr);
    case "assign":
    case "add":
    case "remove":
      return exprUsesCurrentUser(s.value);
    case "emit":
      return s.fields.some((f) => exprUsesCurrentUser(f.value));
    case "call":
      return s.args.some(exprUsesCurrentUser);
  }
}

function exprUsesParam(e: ExprIR | undefined, name: string): boolean {
  if (!e) return false;
  if (e.kind === "ref" && e.refKind === "param" && e.name === name) return true;
  return walkExpr(e, (sub) => exprUsesParam(sub, name));
}

function stmtUsesParam(s: StmtIR, name: string): boolean {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return exprUsesParam(s.expr, name);
    case "assign":
    case "add":
    case "remove":
      return exprUsesParam(s.value, name);
    case "emit":
      return s.fields.some((f) => exprUsesParam(f.value, name));
    case "call":
      return s.args.some((a) => exprUsesParam(a, name));
  }
}

/** Walk one level into `e` and return true if `pred` matches any child. */
function walkExpr(e: ExprIR, pred: (sub: ExprIR | undefined) => boolean): boolean {
  switch (e.kind) {
    case "method-call":
      return pred(e.receiver) || e.args.some((a) => pred(a));
    case "member":
      return pred(e.receiver);
    case "binary":
      return pred(e.left) || pred(e.right);
    case "ternary":
      return pred(e.cond) || pred(e.then) || pred(e.otherwise);
    case "unary":
      return pred(e.operand);
    case "paren":
      return pred(e.inner);
    case "call":
      return e.args.some((a) => pred(a));
    case "lambda":
      return pred(e.body);
    case "new":
    case "object":
      return e.fields.some((f) => pred(f.value));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Operation argument validation — lower precondition StmtIRs to
// Ash `validate` clauses inside the action block.
//
// Recognised single-field shapes (min/max/between/regex/len-*) emit the
// idiomatic Ash built-in validator; everything else emits a function form:
//
//   validate fn changeset, _opts ->
//     if <expr>, do: :ok, else: {:error, "<message>"}
//   end
// ---------------------------------------------------------------------------

function renderOperationValidates(
  op: OperationIR,
  ctx: RenderCtx,
  available: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];

  for (const stmt of op.statements) {
    if (stmt.kind !== "precondition") continue;

    const inv = { expr: stmt.expr, source: stmt.source };

    // Check if this is a single-field shape we can lower idiomatically.
    if (classifyForWire(inv, { available })) {
      const single = singleFieldShape(inv);
      if (single) {
        const ashValidate = ashBuiltinValidate(single.field, single.pattern);
        if (ashValidate) {
          lines.push(
            `      ${ashValidate}, message: ${JSON.stringify(`Precondition failed: ${stmt.source}`)}`,
          );
          continue;
        }
      }
    }

    // Fall back to the function form.  Render against `record` (= changeset.data)
    // when the predicate touches `this` so the rendered output's `record.X`
    // resolves; emit the local binding only when actually used.
    const exprStr = renderExpr(stmt.expr, ctx);
    const recordLine = exprUsesThis(stmt.expr) ? "        record = changeset.data\n" : "";
    lines.push(
      `      validate fn changeset, _opts ->\n${recordLine}        if ${exprStr}, do: :ok, else: {:error, ${JSON.stringify(`Precondition failed: ${stmt.source}`)}}\n      end`,
    );
  }

  return lines;
}

/** Map a recognised single-field pattern to an idiomatic Ash built-in
 *  validate call string (without trailing message), or null when no
 *  built-in covers the shape. */
function ashBuiltinValidate(
  field: string,
  pattern: import("../../ir/validate/invariant-classify.js").SingleFieldPattern,
): string | null {
  const attr = `:${snake(field)}`;
  switch (pattern.kind) {
    case "min":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.n})`;
    case "max":
      return `validate compare(${attr}, less_than_or_equal_to: ${pattern.n})`;
    case "between":
      return `validate compare(${attr}, greater_than_or_equal_to: ${pattern.lo}, less_than_or_equal_to: ${pattern.hi})`;
    case "len-min":
      return `validate string_length(${attr}, min: ${pattern.n})`;
    case "len-max":
      return `validate string_length(${attr}, max: ${pattern.n})`;
    case "len-eq":
      return `validate string_length(${attr}, min: ${pattern.n}, max: ${pattern.n})`;
    case "len-range":
      return `validate string_length(${attr}, min: ${pattern.lo}, max: ${pattern.hi})`;
    case "regex":
      return `validate match(${attr}, ~r/${pattern.pattern}/)`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plural(name: string): string {
  if (name.endsWith("y") && !/[aeiou]y$/i.test(name)) {
    return name.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/i.test(name)) return name + "es";
  return name + "s";
}
