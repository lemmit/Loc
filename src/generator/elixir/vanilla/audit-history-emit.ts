// ---------------------------------------------------------------------------
// Entity history — the READ side of the `audited` command trail, Elixir /
// Phoenix (plain Ecto).  (docs/audit.md; the entry shape, the diff boundary and
// the masking rule are platform-neutral and live in
// `src/ir/util/audit-history.ts`, shared with the other four backends — so the
// wire bytes match `test/behavioral/wire-golden/audit-history.json` by
// CONSTRUCTION rather than by re-derivation here.)
//
// Three emitted pieces, mirroring the Hono / FastAPI ports one-for-one:
//
//   1. `lib/<app>/audit/history.ex` — the `<App>.Audit.History` module: the
//      `audit_records` query plus the two pure diff helpers.  Shape-only, so
//      one copy serves every audited aggregate in the project.
//   2. A per-aggregate `<agg>_audit_entry/1` mapper, emitted as a `defp` into
//      the aggregate's controller.  This is where `mask unless` composes in,
//      because the mapper is the only place a CALLER enters the picture: the
//      before/after snapshots were written server-side INSIDE the command's
//      transaction, with no caller to mask against, so they hold RAW values for
//      every field the wire DTO had.
//   3. The controller's `history` action — the three guards, in order.
//
// A masked field's change entry is DROPPED, never emitted-and-redacted.  A
// redacted-but-present entry still discloses THAT the field changed, when, and
// by whom; "the admin changed `salary` on the 3rd" is the leak, not just the
// number.  Fail-closed on a nil principal, exactly like the redacting
// `serialize/1` in `wire-serialize.ts` — and against the SAME ambient principal
// (`Process.get(:loom_current_user)`, stashed by the Auth plug), so the two
// masking passes can never disagree about who the caller is.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  FindIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import {
  historyDiffFields,
  maskedHistoryFields,
  unmaskedHistoryFields,
} from "../../../ir/util/audit-history.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { denialOverrides, denialResponse } from "./denial.js";

/** Path of the shared shape module inside the generated project. */
export function vanillaHistoryModulePath(appName: string): string {
  return `lib/${appName}/audit/history.ex`;
}

/** Name of the per-aggregate row → wire-entry mapper emitted into the
 *  controller (a `defp`, so it never widens the controller's public surface). */
export function vanillaHistoryMapperName(agg: AggregateIR): string {
  return `${snake(agg.name)}_audit_entry`;
}

/** The repository's enrichment-derived history find, when this aggregate serves
 *  one.  Read off `RepositoryIR.historyFind` rather than re-deriving "is this
 *  audited" — the derived find carries the gate and the `ignoring` stance
 *  enrichment resolved, and re-deriving them here is how the read surface drifts
 *  away from the entity read it replays. */
export function vanillaHistoryFind(ctx: BoundedContextIR, agg: AggregateIR): FindIR | undefined {
  return (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name)?.historyFind;
}

/** True when any served context serves a history read — gates the shared
 *  module's emission. */
export function contextsServeHistory(contexts: readonly BoundedContextIR[]): boolean {
  return contexts.some((c) => (c.repositories ?? []).some((r) => r.historyFind !== undefined));
}

/** `<App>.Audit.History` — the query + the two pure helpers.  Carries no
 *  aggregate knowledge, so one copy serves every audited aggregate. */
export function renderVanillaAuditHistoryModule(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Audit.History do
  @moduledoc """
  Entity history — the read side of the \`audited\` command trail.

  One entry per SUCCESSFUL command (a failed command's transaction rolls back,
  taking its audit row with it), so this answers "what changed", not "who
  tried".  The per-entry \`changes\` list is derived from the row's two snapshots
  at READ time and never stored — a stored diff is a cache with no invalidation
  story, and the snapshots already contain everything it would say.
  """
  import Ecto.Query

  alias ${appModule}.Audit.Record

  @doc """
  Every audit row for one entity, oldest first — a timeline reads forwards, and
  \`at\` plus the \`(target_type, target_id)\` index make it the natural scan order.

  The \`audit_id\` tiebreak is load-bearing on THIS backend and on no other: the
  \`at\` column is written through Ecto's \`:utc_datetime\`, which truncates to the
  second, so two commands on the same entity inside one second tie on \`at\` alone
  and the row order would be whatever the planner felt like.  \`audit_id\` is a
  UUIDv7 — time-ordered by construction — so it breaks the tie in commit order
  rather than arbitrarily.
  """
  @spec for_target(module(), String.t(), String.t()) :: [Record.t()]
  def for_target(repo, target_type, target_id) do
    query =
      from(r in Record,
        where: r.target_type == ^target_type and r.target_id == ^target_id,
        order_by: [asc: r.at, asc: r.audit_id]
      )

    repo.all(query)
  end

  @doc """
  Read one key out of a snapshot.  A missing key and an explicit null are the
  same thing here — a \`create\` row has no \`before\` object at all, and its fields
  must read as \`nil\` rather than raise.

  The snapshot arrives as a plain map: \`before\`/\`after\` bind through the
  \`Audit.Json\` Ecto type over a \`jsonb\` column, so there is no decode step to
  perform and the absent lifecycle side is a real \`nil\`, never the string
  \`"null"\`.  (Every backend binds an object over that column; the column itself
  comes from one shared definition, \`auditTableShape\`.)  Reading it directly is
  also why the stored bytes are none of our business — Postgres normalizes jsonb
  on the way in, so only the derived \`changes\` output is a cross-backend
  contract.

  The snake_case fallback is a wart of THIS backend's write side, recorded
  rather than hidden: an audited \`create\`/\`destroy\` snapshots through the
  controller's wire serializer (camelCase wire keys), while an audited
  \`operation\` snapshots the Ecto struct directly (\`Map.from_struct\`, i.e. schema
  column names).  Both spellings are consistent WITHIN a row — both sides of one
  entry always come from the same projection — so falling back cannot invent a
  change; it only stops a multi-word field from silently vanishing from the
  timeline of every operation entry.
  """
  @spec snapshot_value(term(), String.t()) :: term()
  def snapshot_value(snapshot, key) when is_map(snapshot) do
    case Map.fetch(snapshot, key) do
      {:ok, value} -> value
      :error -> Map.get(snapshot, Macro.underscore(key))
    end
  end

  def snapshot_value(_snapshot, _key), do: nil

  @doc """
  Did this key actually move between the two snapshots?

  Strict term comparison over the two loaded values, so a value object or
  a containment list compares by CONTENT rather than by identity — which is what
  a reader expects of "changed".  Strict (\`!==\`) so an integer never reads as
  equal to the same-valued float: a type change on the wire IS a change.
  """
  @spec value_changed?(term(), term()) :: boolean()
  def value_changed?(before_value, after_value), do: before_value !== after_value
end
`;
}

/** The `RenderCtx` a `mask unless` / `requires` predicate renders against —
 *  the same one `wire-serialize.ts` builds for the redacting `serialize/1`, so
 *  the history mask and the entity-read mask are literally the same rendered
 *  predicate. */
function predicateCtx(appModule: string, ctx: BoundedContextIR, agg: AggregateIR): RenderCtx {
  return {
    thisName: "record",
    contextModule: `${appModule}.${upperFirst(ctx.name)}`,
    foundation: "vanilla",
    agg: agg as EnrichedAggregateIR,
  };
}

/** The per-aggregate `row → entry` mapper.  Unmasked diff fields run through
 *  one `Enum.flat_map` over the key list (which preserves wire-shape order);
 *  each masked field appends through its own predicate guard, so a caller who
 *  fails the predicate sees no entry for it at all. */
export function renderVanillaHistoryMapper(
  appModule: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
): string {
  const unmasked = unmaskedHistoryFields(agg as EnrichedAggregateIR);
  const masked = maskedHistoryFields(agg as EnrichedAggregateIR);
  const history = `${appModule}.Audit.History`;
  const lines: string[] = [`  defp ${vanillaHistoryMapperName(agg)}(row) do`];
  if (unmasked.length > 0) {
    const keys = unmasked.map((f) => JSON.stringify(f.name)).join(", ");
    lines.push(
      `    changes =`,
      `      Enum.flat_map([${keys}], fn key ->`,
      `        before_value = ${history}.snapshot_value(row.before, key)`,
      `        after_value = ${history}.snapshot_value(row.after, key)`,
      ``,
      `        if ${history}.value_changed?(before_value, after_value) do`,
      `          [%{"field" => key, "before" => before_value, "after" => after_value}]`,
      `        else`,
      `          []`,
      `        end`,
      `      end)`,
      ``,
    );
  } else {
    lines.push(`    changes = []`, ``);
  }
  if (masked.length > 0) {
    // The ambient principal — the SAME one the redacting `serialize/1` masks
    // against, so history can never disclose a field the entity read hid.  An
    // unauthenticated caller has none, and every masked entry drops.
    lines.push(`    current_user = Process.get(:loom_current_user)`, ``);
  }
  for (const f of masked) {
    const pred = renderExpr(f.maskUnless!, predicateCtx(appModule, ctx, agg));
    const key = JSON.stringify(f.name);
    lines.push(
      `    # \`${f.name}\`: \`mask unless\` — the change entry is DROPPED, not redacted.`,
      `    # A redacted-but-present entry would still disclose that it changed, when,`,
      `    # and by whom, which is the disclosure the mask exists to prevent.`,
      `    changes =`,
      `      if current_user != nil and (${pred}) do`,
      `        before_value = ${history}.snapshot_value(row.before, ${key})`,
      `        after_value = ${history}.snapshot_value(row.after, ${key})`,
      ``,
      `        if ${history}.value_changed?(before_value, after_value) do`,
      `          changes ++ [%{"field" => ${key}, "before" => before_value, "after" => after_value}]`,
      `        else`,
      `          changes`,
      `        end`,
      `      else`,
      `        changes`,
      `      end`,
      ``,
    );
  }
  lines.push(
    `    %{`,
    `      "auditId" => row.audit_id,`,
    `      "at" => row.at,`,
    `      "action" => row.action,`,
    `      "operationId" => row.operation_id,`,
    `      "actor" => row.actor,`,
    `      "correlationId" => row.correlation_id,`,
    `      "changes" => changes`,
    `    }`,
    `  end`,
  );
  return lines.join("\n");
}

/** `GET /<plural>/:id/history` — the per-entity audit trail (docs/audit.md).
 *
 *  Three guards, in order, mirroring the Hono / FastAPI ports exactly:
 *
 *    1. **The gate.** `historyFind.requires` is the aggregate's own list-read
 *       gate, copied at enrichment — so history is never easier to reach than
 *       the entity read it replays.  Fails → 403, BEFORE any query runs.
 *    2. **Entity reachability.** `audit_records` is machinery: it carries
 *       `target_type`/`target_id` and NO tenant column, so there is nothing on
 *       it for a capability query-filter to scope.  Scoping rides the ENTITY
 *       instead — `get_<agg>` already carries every capability predicate — so a
 *       row the caller cannot read 404s here, the same answer the entity read
 *       gives, and history discloses nothing about another tenant's rows, not
 *       even their existence.
 *    3. **The mask**, applied inside the mapper.
 *
 *  All three are needed: the gate alone leaks across tenants, reachability
 *  alone leaks masked fields to legitimate readers, and the mask alone leaves
 *  the endpoint open. */
export function renderVanillaHistoryAction(
  appModule: string,
  ctxModule: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  find: FindIR,
  /** True when the aggregate's reads carry a principal capability filter — the
   *  `get_<agg>` seam then takes the actor as its trailing argument. */
  principal: boolean,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggSnake = snake(agg.name);
  const gateUsesUser = !!find.requires && exprUsesCurrentUser(find.requires);
  // Bind `current_user` only when something reads it — an unused binding trips
  // `--warnings-as-errors`.
  const cuBind =
    principal || gateUsesUser ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
  const getActor = principal ? ", current_user" : "";
  const rows =
    `${appModule}.Audit.History.for_target(${appModule}.Repo, ` +
    `${JSON.stringify(aggPascal)}, id)`;
  // (2) — reachability, not a predicate on the audit table.  The resolved row
  // itself is unused (the trail is keyed by id, not by the struct), hence `_`.
  const inner = `    case ${ctxModule}.get_${aggSnake}(id${getActor}) do
      {:ok, _record} ->
        json(conn, Enum.map(${rows}, &${vanillaHistoryMapperName(agg)}/1))

      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end`;
  if (!find.requires) {
    return `  def history(conn, %{"id" => id}) do
${cuBind}${inner}
  end`;
  }
  const gate = renderExpr(find.requires, predicateCtx(appModule, ctx, agg));
  // (1) — the gate short-circuits before the entity read, so a denied caller
  // cannot even probe for the row's existence.
  return `  def history(conn, %{"id" => id}) do
${cuBind}    if not (${gate}) do
      ${denialResponse(
        "forbidden",
        JSON.stringify(`Forbidden: history ${aggPascal}`),
        denialOverrides(ctx),
      )}
    else
${inner
  .split("\n")
  .map((l) => (l.length > 0 ? `  ${l}` : l))
  .join("\n")}
    end
  end`;
}

/** True when this aggregate's controller needs the history machinery — kept
 *  beside the emitters so the route registration and the controller body
 *  agree.  (`historyDiffFields` is the same emptiness guard `aggServesHistory`
 *  applies at enrichment; asserting it here too keeps a controller from ever
 *  emitting a mapper with nothing to diff.) */
export function aggregateServesHistoryRoute(ctx: BoundedContextIR, agg: AggregateIR): boolean {
  return (
    vanillaHistoryFind(ctx, agg) !== undefined &&
    historyDiffFields(agg as EnrichedAggregateIR).length > 0
  );
}
