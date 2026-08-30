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
//   The `audit_records` DDL is NOT emitted here — it comes from the shared
//   MigrationsIR (`auditTableShape`), like every other companion table.
//
// The per-action capture (the before/after wire snapshots either side of the
// mutation + the `record/2` call) is wired by `context-emit.ts` (operation
// update) + `api-emit.ts` / `repository-emit.ts` (create/destroy lifecycle);
// this module owns the shared runtime (Ecto schema + insert helper) — the
// ORM-level half, which is genuinely per-backend.
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, SystemIR } from "../../../ir/types/loom-ir.js";
import { contextHasAuditedTarget } from "../../../ir/util/audit-capability.js";
import { upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import {
  contextsServeHistory,
  renderVanillaAuditHistoryModule,
  vanillaHistoryModulePath,
} from "./audit-history-emit.js";
import { renderControllerSerialize } from "./controller-serialize.js";

/** True iff any aggregate in the given contexts carries an audited command
 *  action — gates the runtime helper module + the per-action capture. */
export function contextsHaveAudit(contexts: BoundedContextIR[]): boolean {
  return contexts.some((ctx) => contextHasAuditedTarget(ctx));
}

/** Emit the audit runtime when any audited command action exists.
 *  No-op otherwise (keeps non-audit projects byte-identical). */
export function emitVanillaAudit(
  appName: string,
  appModule: string,
  contexts: BoundedContextIR[],
  out: Map<string, string>,
  /** Resolves each aggregate's effective saving shape for the `Audit.Wire`
   *  snapshot dispatcher (a `document` aggregate's wire fields live on the
   *  `:data` embed).  Same role it plays for the deployable controllers. */
  sys?: SystemIR,
): void {
  if (!contextsHaveAudit(contexts)) return;
  // Only the Ecto SCHEMA + insert helper are emitted here.  The `audit_records`
  // DDL moved to the shared MigrationsIR (`auditTableShape`) so all five
  // backends derive it from one place — Hono emitted none at all, which made
  // every audited command fail at runtime there.
  out.set(`lib/${appName}/audit.ex`, renderAuditModule(appModule, contexts, sys));
  // The READ side (docs/audit.md) — the shared shape module behind
  // `GET /<aggs>/{id}/history`.  Gated on the enrichment-derived `historyFind`
  // rather than on "has audit" alone: an aggregate whose every field is
  // managed/secret records a trail but serves no timeline, and emitting an
  // unused module would trip `--warnings-as-errors` on nothing useful.
  if (contextsServeHistory(contexts)) {
    out.set(vanillaHistoryModulePath(appName), renderVanillaAuditHistoryModule(appModule));
  }
}

/** `<App>.Audit.Record` schema + the `<App>.Audit` insert helper + the
 *  `<App>.Audit.Wire` snapshot projector. */
function renderAuditModule(
  appModule: string,
  contexts: BoundedContextIR[],
  sys?: SystemIR,
): string {
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
          audit_id: UUIDv7.generate(),
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

${renderAuditWireModule(appModule, contexts, sys)}`;
}

/** `<App>.Audit.Wire` — the before/after SNAPSHOT projector.
 *
 *  A snapshot is a wire body, not a database row: the audit timeline (and the
 *  `changes` diff derived from it, docs/audit.md) is a cross-backend contract,
 *  and node/.NET/Java/Python all snapshot through the aggregate's `wireShape`.
 *  This backend's create/destroy capture already did — it runs inside the
 *  aggregate REST controller, where `serialize/1` is in scope — but the OPERATION
 *  capture runs in the CONTEXT module (and the returning-op fn), which hosts no
 *  serializer, so it dumped the raw Ecto struct instead: snake_case keys plus
 *  Ecto's `inserted_at`/`updated_at`, which are in no backend's wire shape.  Two
 *  audited actions on ONE aggregate therefore wrote two different shapes.
 *
 *  One module gives every capture site the same projection: `wire/1` dispatches
 *  per aggregate struct to that aggregate's `wireShape` serializer (the same
 *  per-(context, aggregate) suffixing the deployable-level controllers use, so
 *  same-named aggregates / parts / value objects across contexts coexist), and
 *  falls back to the raw-struct dump for a struct that is not a hosted
 *  aggregate.  A `mask unless` aggregate projects UNMASKED — an audit row
 *  records the real value (authorization.md §5). */
function renderAuditWireModule(
  appModule: string,
  contexts: BoundedContextIR[],
  sys?: SystemIR,
): string {
  const ser = renderControllerSerialize(appModule, contexts, [], sys, /* unmasked */ true);
  return `defmodule ${appModule}.Audit.Wire do
  @moduledoc """
  Audit before/after snapshot projection — the aggregate's \`wireShape\` body,
  identical to what \`GET /<aggs>/{id}\` serves (camelCase keys, no Ecto
  timestamps), so every audited action (operation / create / destroy) records
  the same shape as every other backend.

  A \`mask unless\` field is projected UNMASKED here: the history must hold the
  real before/after value, and read redaction happens on the response path.
  """

  @doc "Project one loaded aggregate record into its audit snapshot map."
  @spec wire(term()) :: term()
  def wire(record), do: serialize(record)

${ser.clauses}${ser.helpers}
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
 *  projection the controller's `serialize/1` uses, for the capture sites where
 *  `serialize/1` is out of scope (the context module + the returning-op fn).
 *
 *  Pass `appModule` to route through `<App>.Audit.Wire.wire/1`, the shared
 *  per-aggregate `wireShape` dispatcher (see {@link renderAuditWireModule}) —
 *  the operation snapshot then matches the create/destroy one byte-for-byte,
 *  and matches every other backend.  Without it the legacy raw-struct dump is
 *  emitted (snake_case keys + Ecto's `inserted_at`/`updated_at`); a
 *  document-shaped aggregate (`shape: document`) keeps its own flattening form,
 *  which merges the `<Agg>.Data` embed (Route A) under the row id rather than
 *  recording a nested `%{id:, data: …}`. */
export function wireSnapshot(recordExpr: string, isDoc = false, appModule?: string): string {
  if (appModule !== undefined) return `${appModule}.Audit.Wire.wire(${recordExpr})`;
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
