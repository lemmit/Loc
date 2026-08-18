// ---------------------------------------------------------------------------
// Vanilla provenance runtime — the Elixir counterpart of the Hono
// `domain/provenance.ts` SDK + the .NET `Domain/Common/ProvLineage.cs` +
// `provenance_records` history table.  Emitted only when the project declares
// at least one `provenanced` field on a `platform: elixir` deployable.
//
//   - `<App>.Provenance` — the per-process trace buffer (`record/1` push,
//     `drain/0` clear) + the transactional history flush (`flush/1`).  The BEAM
//     has no AsyncLocal, so the buffer rides the process dictionary, exactly
//     like `RequestContext` rides `Logger.metadata`.
//   - `<App>.Provenance.Json` — a pass-through Ecto type (any JSON-encodable
//     term ↔ a jsonb column) so a scalar `computed_value` (e.g. `128`) and a
//     list `inputs` both round-trip through the same jsonb column shape the
//     Hono/.NET lineages use.
//   - `<App>.Provenance.Record` — the append-only history schema, mirroring the
//     Hono `provenance_records` Drizzle table / the .NET `ProvenanceRecord` EF
//     entity column-for-column (governance stamps included).
//   - An extra migration (`…_create_provenance.exs`, a high timestamp so it
//     sorts after every module's initial migration) that adds the co-located
//     `<field>_provenance` jsonb columns + creates `provenance_records`.
//
// The per-write capture (the trace buffer push + the co-located column
// `put_change`) is wired by `operation-returns-emit.ts` / `context-emit.ts`;
// this module owns the shared runtime + history table.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  FieldIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { type ProvStmt, stmtHasProv } from "../../../ir/util/prov-id.js";
import { resolveDataSourceConfig } from "../../../ir/util/resolve-datasource.js";
import { plural, snake } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { leafPath } from "../../_stmt/leaves.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** The provenanced fields declared on an aggregate (root fields only —
 *  named-operation write sites, which target root columns, are captured). */
export function provenancedFieldsOf(agg: AggregateIR): FieldIR[] {
  return agg.fields.filter((f) => f.provenanced);
}

/** Every provenanced aggregate across the given contexts, with the Postgres
 *  schema its state table lives in (so the migration ALTER TABLE targets the
 *  right `<schema>.<table>`, not `public`).  `schema` is undefined for the
 *  default (`public`) schema. */
export function provenancedAggregates(
  contexts: BoundedContextIR[],
  sys?: SystemIR,
): Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }> {
  const out: Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }> = [];
  for (const ctx of contexts) {
    for (const agg of ctx.aggregates) {
      const fields = provenancedFieldsOf(agg);
      if (fields.length === 0) continue;
      const schema = sys
        ? resolveDataSourceConfig(agg as EnrichedAggregateIR, ctx, sys)?.schema
        : undefined;
      out.push({ agg, fields, schema });
    }
  }
  return out;
}

/** True iff any aggregate in the given contexts declares a `provenanced`
 *  field — gates the whole runtime (helper module + migration + capture). */
export function contextsHaveProvenanced(contexts: BoundedContextIR[]): boolean {
  return provenancedAggregates(contexts).length > 0;
}

/** Snake-cased name of the co-located backing column for a provenanced field
 *  (`total` → `total_provenance`).  Shared by the schema, the op-body capture,
 *  the persist `put_change`, and the migration so all four agree. */
export function provColumn(fieldName: string): string {
  return `${snake(fieldName)}_provenance`;
}

// A timestamp far in the future so this migration sorts after every module's
// initial + delta migrations (parity with the .NET `29991231235959` provenance
// migration), regardless of how many modules the system has.
const PROVENANCE_MIGRATION_VERSION = "29991231000000";

/** Emit the provenance runtime + migration when any provenanced field exists.
 *  No-op otherwise (keeps non-provenance projects byte-identical). */
export function emitVanillaProvenance(
  appName: string,
  appModule: string,
  contexts: BoundedContextIR[],
  out: Map<string, string>,
  sys?: SystemIR,
): void {
  const provAggs = provenancedAggregates(contexts, sys);
  if (provAggs.length === 0) return;
  const appSnake = appName;
  out.set(`lib/${appSnake}/provenance.ex`, renderProvenanceModule(appModule));
  out.set(
    `priv/repo/migrations/${PROVENANCE_MIGRATION_VERSION}_create_provenance.exs`,
    renderProvenanceMigration(appModule, provAggs),
  );
}

/** `<App>.Provenance` + the nested `Json` type + `Record` schema. */
function renderProvenanceModule(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Provenance.Json do
  @moduledoc """
  Pass-through Ecto type: any JSON-encodable term (scalar, list or map) ↔ a
  jsonb column.  Lets a provenanced \`computed_value\` (often a bare integer)
  and the \`inputs\` list share the one jsonb shape the Hono/.NET lineages use,
  without Ecto's built-in \`:map\` type rejecting non-map values.
  """
  use Ecto.Type

  @impl true
  def type, do: :map

  @impl true
  def cast(value), do: {:ok, value}

  @impl true
  def load(value), do: {:ok, value}

  @impl true
  def dump(value), do: {:ok, value}
end

defmodule ${appModule}.Provenance.Record do
  @moduledoc "Append-only history row — one per provenanced write."
  use Ecto.Schema

  @primary_key {:trace_id, :string, autogenerate: false}
  schema "provenance_records" do
    field :snapshot_id, :string
    field :target_type, :string
    field :field, :string
    field :inputs, ${appModule}.Provenance.Json
    field :computed_value, ${appModule}.Provenance.Json
    field :at, :utc_datetime
    field :correlation_id, :string
    field :scope_id, :string
    field :actor_id, :string
    field :parent_id, :string
  end
end

defmodule ${appModule}.Provenance do
  @moduledoc """
  Provenance trace buffer + history flush (vanilla foundation).

  Every \`provenanced\` write-site pushes a lineage map onto a per-process
  buffer via \`record/1\`; the named-operation save drains it (\`flush/1\`) into
  the \`provenance_records\` table inside the aggregate's transaction, stamping
  each row with the ambient request-context ids.  The BEAM has no AsyncLocal,
  so the buffer rides the process dictionary (cleared on drain) — the same
  per-process discipline \`RequestContext\` uses for \`Logger.metadata\`.
  """
  alias ${appModule}.Provenance.Record
  alias ${appModule}.RequestContext

  require Logger

  @buffer_key :loom_prov_traces

  @doc "Push one lineage onto the per-process trace buffer; returns it unchanged."
  @spec record(map()) :: map()
  def record(lineage) do
    Process.put(@buffer_key, [lineage | Process.get(@buffer_key, [])])
    lineage
  end

  @doc "Drain + clear the per-process trace buffer (source order restored)."
  @spec drain() :: [map()]
  def drain do
    traces = @buffer_key |> Process.get([]) |> Enum.reverse()
    Process.delete(@buffer_key)
    traces
  end

  @doc """
  Insert every buffered trace into \`provenance_records\` via \`repo\`, stamping
  the ambient correlation / scope / actor / parent ids.  Call inside the save
  transaction so the history commits atomically with the aggregate.
  """
  @spec flush(module()) :: :ok
  def flush(repo) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    rows =
      Enum.map(drain(), fn lin ->
        %{
          trace_id: UUIDv7.generate(),
          snapshot_id: lin.snapshotId,
          target_type: lin.target.type,
          field: lin.target.field,
          inputs: lin.inputs,
          computed_value: lin.computedValue,
          at: now,
          correlation_id: RequestContext.correlation_id(),
          scope_id: RequestContext.scope_id(),
          actor_id: RequestContext.actor_id(),
          parent_id: RequestContext.parent_id()
        }
      end)

    if rows != [] do
      repo.insert_all(Record, rows)
      ${renderPhoenixLogCall("provenanceRecorded", [
        { name: "aggregate", valueExpr: "hd(rows).target_type" },
        { name: "count", valueExpr: "length(rows)" },
      ])}
    end

    :ok
  end
end
`;
}

/** The ALTER TABLE (co-located columns) migration — each ALTER carries the
 *  owning aggregate's `prefix:` so it targets the right schema.  The
 *  `provenance_records` history table is NOT created here: it is a shared
 *  MigrationsIR companion table (`provenanceTableShape`), rendered by
 *  `elixir/migrations-emit.ts` like the outbox and the audit log — and skipped
 *  in that emitter's `timestamps()` bundling, since the flush inserts plain
 *  maps and a NOT NULL `inserted_at` would reject every provenanced write. */
function renderProvenanceMigration(
  appModule: string,
  provAggs: Array<{ agg: AggregateIR; fields: FieldIR[]; schema?: string }>,
): string {
  const alters = provAggs.map(({ agg, fields, schema }) => {
    const table = snake(plural(agg.name));
    const prefix = schema ? `, prefix: ${JSON.stringify(schema)}` : "";
    const cols = fields.map((f) => `      add :${provColumn(f.name)}, :map`).join("\n");
    return `    alter table(:${table}${prefix}) do\n${cols}\n    end`;
  });

  return `defmodule ${appModule}.Repo.Migrations.CreateProvenance do
  use Ecto.Migration

  def change do
${alters.join("\n\n")}
  end
end
`;
}

/** Bounded walk over a provenanced write's RHS collecting leaf inputs — the
 *  `this`-props, params and let-bindings (and member chains rooted at them)
 *  that fed the value, each rendered to its current Elixir value.  Lambdas are
 *  skipped (their bodies reference lambda-local params, not stored leaves).
 *  Elixir sibling of the TS/.NET `collectLeaves`. */
export function collectVanillaLeaves(
  e: ExprIR,
  rc: RenderCtx,
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderExpr(e, rc) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderExpr(e, rc) });
      break;
    case "method-call":
      collectVanillaLeaves(e.receiver, rc, out);
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "call":
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "paren":
      collectVanillaLeaves(e.inner, rc, out);
      break;
    case "unary":
      collectVanillaLeaves(e.operand, rc, out);
      break;
    case "binary":
      collectVanillaLeaves(e.left, rc, out);
      collectVanillaLeaves(e.right, rc, out);
      break;
    case "ternary":
      collectVanillaLeaves(e.cond, rc, out);
      collectVanillaLeaves(e.then, rc, out);
      collectVanillaLeaves(e.otherwise, rc, out);
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CRUDISH-UPDATE capture (RS-18).
//
// The generic update route on this backend persists through
// `<Agg>Changeset.update_changeset/2` + `Repo.update/1` — deliberately, since
// that changeset is what makes the RS-26 present-key / default rules work.  The
// synthesized `operation update(...)` BODY therefore never executes, so the
// inline lineage capture `operation-returns-emit` emits for a NAMED op never
// runs on this path and a provenanced field kept the lineage of the PREVIOUS
// write (the M-T9.11 `corpus/provenance` divergence: `$.total_provenance.inputs`
// still reported `reprice`'s leaves after an `update` set `total` directly).
// node/python/java/dotnet all run the op body and re-capture.
//
// `docs/provenance.md` is explicit — "inline trace capture at EVERY provenanced
// write site" — so this re-captures the SAME write sites the op body declares,
// against the changeset's APPLIED changes rather than a threaded `record`
// struct.  `Ecto.Changeset.apply_changes/1` is the proposed row: for the crudish
// `<field> := <field>` shape the param and the cast column hold the same value,
// so `record.<column>` renders both the leaf input and the `computedValue`
// exactly as the op body would.
//
// The buffered lineages are pushed + flushed by the CALLER (`repository-emit`'s
// `update/2`), inside the save transaction and only on success — so a rejected
// changeset leaves no orphaned, undrained trace in the process buffer.
// ---------------------------------------------------------------------------

/** One renderable provenanced write site on the canonical `update`. */
interface UpdateProvSite {
  /** Aggregate field the write targets. */
  field: string;
  /** The instrumented `assign` statement (carries the rule snapshot). */
  stmt: ProvStmt;
}

/** Provenanced write sites on the canonical `update` operation whose RHS this
 *  seam can faithfully render off the applied changeset.  `with crudish`
 *  synthesises that operation; a hand-written `operation update` is skipped by
 *  `CRUD_RESERVED_NAMES` the same way, so both land here.
 *
 *  Every leaf must be a `param` or `this-prop` naming a real aggregate field —
 *  true for the crudish `<field> := <field>` shape — because the changeset
 *  carries COLUMNS, not the operation's local bindings.  One unrenderable site
 *  disqualifies the whole operation (returns `[]`, i.e. the pre-existing
 *  behaviour) rather than emitting a `record.<unbound>` KeyError. */
function renderableUpdateProvSites(agg: AggregateIR): UpdateProvSite[] {
  const op = (agg.operations ?? []).find((o) => o.name === "update");
  if (!op) return [];
  const columns = new Set(agg.fields.map((f) => f.name));
  const out: UpdateProvSite[] = [];
  for (const s of op.statements) {
    if (!stmtHasProv(s)) continue;
    // A collection `add`/`remove` write site has no column to `put_change`.
    if (s.kind !== "assign") return [];
    const field = s.target.segments[s.target.segments.length - 1];
    if (field === undefined || !columns.has(field)) return [];
    if (!leavesResolveToColumns(s.value, columns)) return [];
    out.push({ field, stmt: s });
  }
  return out;
}

/** Every leaf of the RHS names an aggregate column (as a `param` shadowing it,
 *  or as a `this-prop`), so `record.<column>` off `apply_changes/1` is the value
 *  the operation body would have written. */
function leavesResolveToColumns(e: ExprIR, columns: ReadonlySet<string>): boolean {
  switch (e.kind) {
    case "literal":
      return e.lit !== "now";
    case "ref":
      return (e.refKind === "param" || e.refKind === "this-prop") && columns.has(e.name);
    case "paren":
      return leavesResolveToColumns(e.inner, columns);
    case "unary":
      return leavesResolveToColumns(e.operand, columns);
    case "binary":
      return leavesResolveToColumns(e.left, columns) && leavesResolveToColumns(e.right, columns);
    default:
      // member walks, method calls, derived getters, conversions, `currentUser`
      // — none read cleanly off the applied struct; leave the site uncaptured
      // rather than emit code that raises at runtime.
      return false;
  }
}

/** Every `param`-kind ref name in a (already gate-passed) RHS — the locals the
 *  changeset path has to rewrite onto their shadowed columns. */
function paramLeafNames(e: ExprIR, out: string[] = []): string[] {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "param") out.push(e.name);
      break;
    case "paren":
      paramLeafNames(e.inner, out);
      break;
    case "unary":
      paramLeafNames(e.operand, out);
      break;
    case "binary":
      paramLeafNames(e.left, out);
      paramLeafNames(e.right, out);
      break;
    default:
      break;
  }
  return out;
}

/** True when the aggregate's crudish-update path must re-capture provenance —
 *  gates the `__capture_provenance/1` helper AND the transactional `update`
 *  shape in `repository-emit`, so the two can never disagree.  False ⇒
 *  byte-identical output. */
export function updateCapturesProvenance(agg: AggregateIR): boolean {
  return renderableUpdateProvSites(agg).length > 0;
}

/** The private `__capture_provenance/1` helper for an aggregate's repository:
 *  `{changeset, lineages}` — the changeset with each provenanced field's
 *  co-located `<field>_provenance` column re-stamped, plus the lineage list the
 *  caller pushes onto the trace buffer after a successful save.  Empty string
 *  when the aggregate has no renderable update write site. */
export function renderUpdateProvenanceCapture(agg: AggregateIR, contextModule: string): string {
  const sites = renderableUpdateProvSites(agg);
  if (sites.length === 0) return "";
  // `record` is the PROPOSED row, so a `param` leaf and a `this-prop` leaf alike
  // render as `record.<column>` — the value the operation body would have
  // written.  `this`-props get that from `thisName`; a PARAM is a local the
  // changeset path never binds, so `paramRenames` rewrites each one onto its
  // shadowed column (the `renderableUpdateProvSites` gate is what guarantees
  // every param leaf names one).
  const paramRenames: Record<string, string> = {};
  for (const site of sites) {
    for (const name of paramLeafNames(site.stmt.value)) {
      paramRenames[name] = `record.${snake(name)}`;
    }
  }
  const rc: RenderCtx = {
    thisName: "record",
    contextModule,
    paramRenames,
  };
  const lineageVars: string[] = [];
  const body: string[] = [];
  sites.forEach(({ field, stmt }, index) => {
    const inputsVar = `loom_prov_inputs_${index}`;
    const linVar = `loom_lineage_${index}`;
    lineageVars.push(linVar);
    const inputs = collectVanillaLeaves(stmt.value, rc)
      .map((l) => `%{path: ${JSON.stringify(l.path)}, value: ${l.value}}`)
      .join(", ");
    const target = `%{type: ${JSON.stringify(stmt.prov.target.type)}, field: ${JSON.stringify(stmt.prov.target.field)}}`;
    body.push(
      `    ${inputsVar} = [${inputs}]`,
      // RS-1 — the lineage map's OWN members stay camelCase: it goes on the wire
      // verbatim, and every other backend's `ProvLineage` spells them
      // `snapshotId` / `computedValue`.  Only the OUTER key
      // (`<field>_provenance`) is the documented snake_case exception.
      `    ${linVar} = %{snapshotId: ${JSON.stringify(stmt.prov.snapshotId)}, target: ${target}, inputs: ${inputsVar}, computedValue: record.${snake(field)}}`,
      `    changeset = Ecto.Changeset.put_change(changeset, :${provColumn(field)}, ${linVar})`,
      "",
    );
  });
  return `
  # RS-18 — the generic update persists through \`update_changeset/2\`, so the
  # synthesized \`operation update(...)\` body (and the inline lineage capture the
  # NAMED-operation path emits) never runs.  Re-capture it here against the
  # proposed row, so a provenanced field's lineage names the write that actually
  # produced its current value — exactly what node/python/java/dotnet get by
  # running the op body.  Returns the lineages so the caller can buffer + flush
  # them inside the save transaction, and only on success.
  @spec __capture_provenance(Ecto.Changeset.t()) :: {Ecto.Changeset.t(), [map()]}
  defp __capture_provenance(%Ecto.Changeset{} = changeset) do
    record = Ecto.Changeset.apply_changes(changeset)

${body.join("\n")}    {changeset, [${lineageVars.join(", ")}]}
  end
`;
}
