// ---------------------------------------------------------------------------
// Vanilla audit runtime — the Elixir counterpart of the Hono `audit_records`
// Drizzle table + the .NET `AuditRecord` / `IAuditWriter` pair + the Java
// `AuditRecord` JPA row + the Python `AuditRecordRow` SQLAlchemy model.
// Emitted only when a served context declares at least one `audited` command
// action — `operation … audited`, `create(...) audited`, or `destroy audited`
// (gated on the SHARED `aggHasAuditedTarget` predicate, never on `agg.operations`
// alone — the pre-#1503 drift that silently dropped audited creates/destroys).
//
//   - `<App>.Audit.Record` — the append-only history schema, mirroring the
//     byte-shared `audit_records` table column-for-column
//     (audit_id pk, operation_id, action, target_type, target_id, actor jsonb,
//     before jsonb, after jsonb, at, status, correlation_id, scope_id,
//     parent_id).
//   - `<App>.Audit` — the `record/2` helper that stamps the ambient request
//     context ids (correlation / scope / parent + the principal `actor_id`) and
//     inserts the row through the given repo.  Called INSIDE the operation /
//     lifecycle transaction so the audit row commits atomically with the state
//     change (parity with the Hono transactional route, the .NET IAuditWriter
//     unit-of-work staging, the Java service insert, the Python session add).
//   - An extra migration (`…_create_audit.exs`, version 29991231000001 — one
//     higher than the provenance migration's 29991231000000, the same
//     audit-after-provenance ordering Python uses) that creates `audit_records`
//     + the (target_type,target_id) / (correlation_id) indexes.
//
// The per-action capture (the before/after wire snapshots either side of the
// mutation + the `record/2` call) is wired by `context-emit.ts` (operation
// update) + `api-emit.ts` / `repository-emit.ts` (create/destroy lifecycle);
// this module owns the shared runtime + history table — the audit runtime for
// the elixir backend.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { contextHasAuditedTarget } from "../../../ir/util/audit-capability.js";
import { upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

// A version far in the future so this migration sorts after every module's
// initial + delta migrations.  `…001` is one higher than the provenance
// migration's `…000` so when both late migrations are present they sort
// deterministically (audit after provenance — the same ordering Python uses
// with its `29991231000001_audit` tag).
const AUDIT_MIGRATION_VERSION = "29991231000001";

/** True iff any aggregate in the given contexts carries an audited command
 *  action — gates the whole runtime (helper module + migration + capture). */
export function contextsHaveAudit(contexts: BoundedContextIR[]): boolean {
  return contexts.some((ctx) => contextHasAuditedTarget(ctx));
}

/** Emit the audit runtime + migration when any audited command action exists.
 *  No-op otherwise (keeps non-audit projects byte-identical). */
export function emitVanillaAudit(
  appName: string,
  appModule: string,
  contexts: BoundedContextIR[],
  out: Map<string, string>,
): void {
  if (!contextsHaveAudit(contexts)) return;
  out.set(`lib/${appName}/audit.ex`, renderAuditModule(appModule));
  out.set(
    `priv/repo/migrations/${AUDIT_MIGRATION_VERSION}_create_audit.exs`,
    renderAuditMigration(appModule),
  );
}

/** `<App>.Audit.Record` schema + the `<App>.Audit` insert helper. */
function renderAuditModule(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Audit.Json do
  @moduledoc """
  Pass-through Ecto type: any JSON-encodable term (map, list, scalar, or the
  JSON \`null\` on a lifecycle action's absent side) ↔ a jsonb column.  Lets the
  before/after wire snapshots and the principal \`actor\` map share the one jsonb
  shape the Hono/.NET/Java/Python sinks use, without Ecto's built-in \`:map\` type
  rejecting a \`nil\` (create has no before, destroy no after).
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

defmodule ${appModule}.Audit.Record do
  @moduledoc "Append-only audit history row — one per successful audited action."
  use Ecto.Schema

  @primary_key {:audit_id, :string, autogenerate: false}
  schema "audit_records" do
    field :operation_id, :string
    field :action, :string
    field :target_type, :string
    field :target_id, :string
    field :actor, ${appModule}.Audit.Json
    field :before, ${appModule}.Audit.Json
    field :after, ${appModule}.Audit.Json
    field :at, :utc_datetime
    field :status, :string
    field :correlation_id, :string
    field :scope_id, :string
    field :parent_id, :string
  end
end

defmodule ${appModule}.Audit do
  @moduledoc """
  Per-action audit-record sink (vanilla foundation).

  Every \`audited\` action (operation, create, or destroy) builds a who/what/when
  + before/after wire snapshot and calls \`record/2\` INSIDE the action's save
  transaction, so the audit row commits atomically with the aggregate's state
  change.  The ambient request-context ids (correlation / scope / parent + the
  principal \`actor_id\`) are stamped here, the same per-process discipline
  \`Provenance.flush\` and \`RequestContext\` use for \`Logger.metadata\`.
  """
  require Logger

  alias ${appModule}.Audit.Record
  alias ${appModule}.RequestContext

  @doc """
  Insert one audit row through \`repo\`, stamping the ambient correlation / scope
  / parent ids + the principal \`actor\` (only the id is carried).  \`fields\` is the
  per-action map (operation_id / action / target_type / target_id / before /
  after).  Call inside the action's transaction so the history commits atomically.

  Uses \`insert!/1\` (the raising variant): a failed audit insert (NOT NULL /
  duplicate audit_id / …) must roll back the WHOLE action transaction, so the
  aggregate state change can never commit without its audit row — the same
  "audit commits atomically with the state change" guarantee the Python sink
  gives by raising on \`session.commit()\`.  Returns the inserted \`Record\`.

  After the row commits, announces the write on the neutral log catalog
  (\`audit_recorded\`, level debug — action/target/actor in scope) so a downstream
  filter sees the audit history on the same JSON channel every other backend
  emits it on.  The log fires only here, so it follows every audited action
  (operation / create / destroy) without touching the per-action call sites.
  """
  @spec record(module(), map()) :: Record.t()
  def record(repo, fields) when is_map(fields) do
    actor_id = RequestContext.actor_id()

    row =
      Map.merge(
        %{
          audit_id: Ecto.UUID.generate(),
          actor: if(actor_id, do: %{id: actor_id}, else: nil),
          at: DateTime.utc_now() |> DateTime.truncate(:second),
          status: "ok",
          correlation_id: RequestContext.correlation_id(),
          scope_id: RequestContext.scope_id(),
          parent_id: RequestContext.parent_id()
        },
        fields
      )

    inserted = repo.insert!(struct(Record, row))
    ${renderPhoenixLogCall("auditRecorded", [
      { name: "action", valueExpr: "row.action" },
      { name: "target", valueExpr: '"#{row.target_type}/#{row.target_id}"' },
      { name: "actor", valueExpr: "actor_id" },
    ])}
    inserted
  end
end
`;
}

/** The `audit_records` CREATE TABLE migration.  The history table lands in
 *  `public` (a cross-context global), exactly like `provenance_records`. */
function renderAuditMigration(appModule: string): string {
  return `defmodule ${appModule}.Repo.Migrations.CreateAudit do
  use Ecto.Migration

  def change do
    create table(:audit_records, primary_key: false) do
      add :audit_id, :string, primary_key: true, null: false
      add :operation_id, :string, null: false
      add :action, :string, null: false
      add :target_type, :string, null: false
      add :target_id, :string, null: false
      add :actor, :map
      add :before, :map
      add :after, :map
      add :at, :utc_datetime, null: false
      add :status, :string, null: false
      add :correlation_id, :string
      add :scope_id, :string
      add :parent_id, :string
    end

    create index(:audit_records, [:target_type, :target_id])
    create index(:audit_records, [:correlation_id])
  end
end
`;
}

/** Build the per-action `<App>.Audit.record(...)` call expression (a multi-line
 *  Elixir snippet) for a given action.  `before`/`after` are raw Elixir
 *  expressions (a wire map or `nil`); `targetId` is a raw Elixir expression.
 *  Indented by `indent`.  Shared by the operation / create / destroy paths. */
export function auditRecordCall(args: {
  appModule: string;
  operationId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: string;
  after: string;
  indent: string;
}): string {
  const { appModule, operationId, action, targetType, targetId, before, after, indent } = args;
  const i = indent;
  return [
    `${i}${appModule}.Audit.record(${appModule}.Repo, %{`,
    `${i}  operation_id: ${JSON.stringify(operationId)},`,
    `${i}  action: ${JSON.stringify(action)},`,
    `${i}  target_type: ${JSON.stringify(targetType)},`,
    `${i}  target_id: ${targetId},`,
    `${i}  before: ${before},`,
    `${i}  after: ${after}`,
    `${i}})`,
  ].join("\n");
}

/** The wire-snapshot expression for a vanilla aggregate record — the SAME wire
 *  projection the controller's `serialize/1` uses, inlined where `serialize/1`
 *  is out of scope (the context module + the returning-op fn).  Relational
 *  aggregates dump the whole struct (`Map.from_struct |> Map.drop`); a
 *  document-shaped aggregate (`shape(document)`) stores its wire form in the
 *  `<Agg>.Data` embed (Route A) — flatten that struct (dropping `:__struct__`)
 *  and merge under the row id so the audit before/after row carries the flat wire
 *  shape every other backend records, not a nested `%{id:, data: …}`.  Pass
 *  `isDoc: true` for a doc agg. */
export function wireSnapshot(recordExpr: string, isDoc = false): string {
  return isDoc
    ? `Map.merge(%{id: ${recordExpr}.id}, (${recordExpr}.data && Map.from_struct(${recordExpr}.data)) || %{})`
    : `(${recordExpr} |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))`;
}

/** The audited create's `operationId` / `action`. */
export function createAuditMeta(agg: AggregateIR): { operationId: string; action: string } {
  return { operationId: `create${upperFirst(agg.name)}`, action: "create" };
}

/** The audited destroy's `operationId` / `action`. */
export function destroyAuditMeta(agg: AggregateIR): { operationId: string; action: string } {
  return { operationId: `destroy${upperFirst(agg.name)}`, action: "destroy" };
}
