// ---------------------------------------------------------------------------
// Vanilla context module — `lib/<app>/<ctx>.ex`.  Slices 1, 2, 5c of
// vanilla-foundation-tdd-plan.md.
//
// Plain Elixir context module.  Façade that
// re-exports the per-aggregate Repository functions plus named-
// operation handlers (Slice 5c prerequisite — workflows on vanilla
// need `<op>_<agg>(record, params)` for cross-aggregate operation
// calls in the workflow body).
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  OperationIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import type { RenderCtx } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { isVanillaDocAgg } from "./document-emit.js";
import {
  customFindsOfAgg,
  esContextNeedsEnsure,
  isEventSourced,
  renderEnsureHelper,
  renderEsContextBlock,
} from "./eventsourced-emit.js";
import { isAbstractBase } from "./inheritance-emit.js";
import {
  isReturningOperation,
  persistPutBodies,
  renderReturningOpFunction,
  renderReturningStmt,
} from "./operation-returns-emit.js";
import { refCollFieldNames } from "./ref-collection-emit.js";
import { customFindsOf } from "./repository-emit.js";
import { stampUsesPrincipal } from "./stamp-emit.js";

/** Operation names whose `<op>_<agg>` collide with the CRUD
 *  defdelegates emitted above (list/get/create/update/delete).  Skipped
 *  for named-op emission to avoid Elixir function-clause redefinition.
 *  Exported so the controller emitter (`api-emit.ts`) only mounts a
 *  per-operation member route for ops that actually have a `<op>_<agg>`
 *  context function — CRUD-verb-named ops are served by the generic
 *  create/update/delete routes instead, exactly as the named-op emission
 *  here skips them. */
export const CRUD_RESERVED_NAMES = new Set([
  "create",
  "update",
  "delete",
  "destroy",
  "list",
  "get",
]);

export function emitVanillaContextModule(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
): void {
  const ctxSnake = snake(ctx.name);
  const ctxModule = upperFirst(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  out.set(`lib/${appSnake}/${ctxSnake}.ex`, renderContextModule(appModule, ctxModule, ctx, sys));
}

function renderContextModule(
  appModule: string,
  ctxModule: string,
  ctx: BoundedContextIR,
  sys?: SystemIR,
): string {
  const facadeMod = `${appModule}.${ctxModule}`;
  const blocks = ctx.aggregates.map((agg) => {
    // Event-sourced aggregates expose create/get/list + per-op command
    // runners (emit→append→fold) instead of the CRUD defdelegates.
    if (isEventSourced(agg)) {
      return renderEsContextBlock(appModule, ctxModule, agg, customFindsOfAgg(ctx, agg));
    }
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const repoMod = `${facadeMod}.${aggPascal}Repository`;
    // An abstract inheritance base is never instantiated — its façade is
    // READ-ONLY: `list_<base>s` / `get_<base>` over the polymorphic reader, no
    // create/update/delete/change defdelegates (there is no changeset / write
    // seam to delegate to).  Emitting them would reference functions the
    // read-only base repository never defines.
    if (isAbstractBase(agg)) {
      return `  # ${aggPascal} (abstract base — read-only polymorphic reader)
  defdelegate list_${aggSnake}s(), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id), to: ${repoMod}, as: :find_by_id
`;
    }
    // A principal (tenancy) filter threads the request actor through the read
    // seam, so the defdelegates that front a scoped read (`list`/`get` + custom
    // finds) carry the matching `current_user \\ nil` arity.  Non-principal
    // aggregates keep the original parameterless seam (byte-identical).
    const principal = aggregateUsesPrincipalContextFilter(agg);
    const actorArg = principal ? ", current_user \\\\ nil" : "";
    // A principal-referencing lifecycle stamp threads `current_user` into the
    // create/update WRITE seam too (the repository `insert`/`update` reads
    // `current_user.<idKey>` for `createdBy`/`updatedBy`).  The `\\ nil` default
    // keeps internal callers compiling + fail-safe (a nil actor stamps nil).
    const stampActorArg = stampUsesPrincipal(agg) ? ", current_user \\\\ nil" : "";
    // Skip ops whose names collide with the CRUD defdelegates above —
    // notably `update`/`destroy` from `with crudish` would redefine
    // `update_<agg>/2`/`delete_<agg>/1` otherwise.  The CRUD seam
    // already provides those names.
    const opBlocks = (agg.operations ?? [])
      .filter((op) => !CRUD_RESERVED_NAMES.has(op.name))
      .map((op) =>
        isReturningOperation(op)
          ? renderReturningOpFunction(facadeMod, ctx, agg, op)
          : renderNamedOpFunction(facadeMod, ctx, agg, aggPascal, aggSnake, op),
      );
    // Custom-find defdelegates — `<find>_<agg>(args...)` routes to the
    // repository fn emitted by `customFindsOf`.  Workflow `repo-let`
    // lowering (for a non-getById method) calls through this seam.
    const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    const findLines = customFindsOf(repo).map((f) => {
      const findSnake = snake(f.name);
      const baseArgs = f.params.map((p) => snake(p.name));
      const findArgs = [...baseArgs, ...(principal ? ["current_user \\\\ nil"] : [])].join(", ");
      return `  defdelegate ${findSnake}_${aggSnake}(${findArgs}), to: ${repoMod}, as: :${findSnake}`;
    });
    const findBlock = findLines.length > 0 ? `\n${findLines.join("\n")}\n` : "";
    // `change_<agg>/2` — a blank-or-seeded Ecto changeset facade the Phoenix
    // LiveView form lifecycle calls (`change_<agg>(%Agg{})` for a create form,
    // `change_<agg>(record, params)` for validate).  Delegates to the
    // per-aggregate Changeset module's `base_changeset/2`.  A DOCUMENT
    // aggregate has no `base_changeset` (it round-trips via `document_changeset`),
    // so skip the facade there — its form path is out of scope for this slice.
    const isDoc = isVanillaDocAgg(agg, ctx, sys);
    const changesetMod = `${facadeMod}.${aggPascal}Changeset`;
    const changeFacade = isDoc
      ? ""
      : `\n
  @doc "Blank-or-seeded Ecto changeset for the ${aggPascal} create/operation forms."
  def change_${aggSnake}(record_or_struct \\\\ %${facadeMod}.${aggPascal}{}, attrs \\\\ %{}),
    do: ${changesetMod}.base_changeset(record_or_struct, attrs)`;
    // A `destroy` action (e.g. from `with crudish`) lets a detail page host a
    // `DestroyForm(of: <Agg>)`, whose hoisted `handle_event` calls
    // `<Ctx>.destroy_<agg>!(id)` directly (a `byId` ActionBinding — see
    // `heex-primitives.ts`).  Emit that bang fn: load the record by id (raising
    // if missing), hard-delete it (`Repo.delete!`), returning the deleted struct.
    // Mirror the LiveView's emit condition on the aggregate IR — it has a
    // `destroy` action.
    const hasDestroy = (agg.destroys ?? []).length > 0;
    const getArgs = principal ? "id, current_user" : "id";
    const destroyFacade = hasDestroy
      ? `\n
  @doc "Hard-delete a ${aggPascal} by id (DestroyForm seam) — raises if not found."
  def destroy_${aggSnake}!(${getArgs}) do
    case get_${aggSnake}(${getArgs}) do
      {:ok, record} -> ${appModule}.Repo.delete!(record)
      {:error, _} -> raise Ecto.NoResultsError, queryable: ${facadeMod}.${aggPascal}
    end
  end`
      : "";
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(${principal ? "current_user \\\\ nil" : ""}), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id${actorArg}), to: ${repoMod}, as: :find_by_id
  defdelegate create_${aggSnake}(attrs${stampActorArg}), to: ${repoMod}, as: :insert
  defdelegate update_${aggSnake}(record, attrs${stampActorArg}), to: ${repoMod}, as: :update
  defdelegate delete_${aggSnake}(record), to: ${repoMod}, as: :delete${changeFacade}${destroyFacade}
${findBlock}${opBlocks.length > 0 ? `\n${opBlocks.join("\n\n")}\n` : ""}`;
  });

  // Retrieval defdelegates — `run_<retrieval>_<agg>(args..., opts \\ [])`
  // routes to the per-retrieval Ecto query module under
  // `Retrievals.<Name>`.  Workflow `repo-run` lowerings (follow-up
  // slice) call through this seam.
  const retrievalLines = (ctx.retrievals ?? [])
    .filter((r) => r.targetType.kind === "entity")
    .map((r) => {
      const aggName = (r.targetType as { kind: "entity"; name: string }).name;
      const retSnake = snake(r.name);
      const aggSnake = snake(aggName);
      const retMod = `${facadeMod}.Retrievals.${upperFirst(r.name)}`;
      // `defdelegate` carries the function arity through to the target.
      // `\\\\ []` is the default for the trailing `opts` arg.
      const args = r.params.map((p) => snake(p.name));
      const argList = args.length > 0 ? `${args.join(", ")}, opts \\\\ []` : "opts \\\\ []";
      return `  defdelegate run_${retSnake}_${aggSnake}(${argList}), to: ${retMod}, as: :run`;
    });
  const retrievalBlock =
    retrievalLines.length > 0 ? `\n  # Retrievals\n${retrievalLines.join("\n")}\n` : "";

  // Private `ensure/2` guard helper shared by the ES command runners (only
  // emitted when an ES command body actually has a precondition/requires, so
  // it never sits unused under --warnings-as-errors).
  const ensureBlock = esContextNeedsEnsure(ctx) ? `\n${renderEnsureHelper()}\n` : "";

  // Shared ref-collection helpers — emitted once per context module when ANY
  // named operation appends/removes through a `many_to_many` reference
  // collection.  `__ref_id_list/1` normalises a preloaded relationship (target
  // structs) — or an already-raw id list — to a list of id strings;
  // `__resolve_refs/2` loads those ids back to target structs for `put_assoc`.
  const refCollHelpers = contextUsesRefCollOp(ctx)
    ? `\n${renderContextRefCollHelpers(appModule)}\n`
    : "";

  // A named-/returning-op body that `emit`s a domain event renders a catalog
  // `event_dispatched` line (`renderReturningStmt` "emit" arm) — that needs
  // `require Logger` in this host module.  Gate it so the require never sits
  // unused.
  const requireLogger = contextEmitsEvent(ctx) ? "\n  require Logger" : "";

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions plus named-operation
  handlers (workflows need
  \`<op>_<agg>(record, params)\` for cross-aggregate calls in the
  workflow body).  Plain Elixir context module.
  """${requireLogger}${refCollHelpers ? "\n  import Ecto.Query" : ""}

${blocks.join("\n")}${retrievalBlock}${ensureBlock}${refCollHelpers}end
`;
}

/** Does any non-CRUD, non-ES named/returning operation in the context `emit` a
 *  domain event?  Those bodies render the catalog `event_dispatched` line via
 *  `renderReturningStmt`'s "emit" arm, which needs `require Logger` in this host
 *  module.  Gates the require so it never sits unused. */
function contextEmitsEvent(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some(
    (agg) =>
      !isEventSourced(agg) &&
      (agg.operations ?? []).some(
        (op) => !CRUD_RESERVED_NAMES.has(op.name) && op.statements.some((s) => s.kind === "emit"),
      ),
  );
}

/** Does any non-CRUD named operation in the context append/remove through a
 *  reference collection (`X id[]` → `many_to_many`)?  Gates the shared
 *  `__ref_id_list` / `__resolve_refs` helper emission. */
function contextUsesRefCollOp(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some((agg) => {
    if (isEventSourced(agg)) return false;
    const names = refCollFieldNames(agg);
    if (names.size === 0) return false;
    return (agg.operations ?? []).some(
      (op) =>
        !CRUD_RESERVED_NAMES.has(op.name) &&
        op.statements.some(
          (s) =>
            (s.kind === "add" || s.kind === "remove") &&
            s.collection &&
            names.has(snake(s.target.segments[0] ?? "")),
        ),
    );
  });
}

/** The two private helpers a context module emits when a named op mutates a
 *  reference collection. */
function renderContextRefCollHelpers(appModule: string): string {
  return `  # Normalise a reference-collection value to a list of id strings — a
  # preloaded \`many_to_many\` is a list of target structs; a not-yet-loaded one
  # (or already-raw id list) passes through.
  defp __ref_id_list(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_id_list(list) when is_list(list) do
    Enum.map(list, fn
      %{id: id} -> to_string(id)
      id -> to_string(id)
    end)
  end
  defp __ref_id_list(_), do: []

  # Load reference-collection ids back to target structs for \`put_assoc\`.
  defp __resolve_refs(ids, target_mod) do
    ids = ids |> List.wrap() |> Enum.map(&to_string/1)
    ${appModule}.Repo.all(from(t in target_mod, where: t.id in ^ids))
  end`;
}

// Named operation functions per aggregate operation.  `<op>_<agg>(record,
// params)` runs the operation BODY: bind the params it reads, render the
// statements (guards raise, `field := value` struct-updates the threaded
// `record`, `emit` broadcasts — the same vanilla renderer the returning-op
// path uses), then persist the assigned fields and `Repo.update`.
//
// The body is rendered against an immutable `record` struct: each `field :=
// value` re-binds `record = %{record | field: value}`, so after the body the
// struct holds the computed values.  Persistence then `put_change`s exactly the
// assigned fields onto a changeset (they're real schema columns), rather than
// `cast`ing the op's *params* — params are inputs to the formula, not columns,
// so casting them would raise `unknown field` at runtime.  This is the seam
// workflows call when their body invokes `<aggregate>.<operation>(args)`.
function renderNamedOpFunction(
  facadeMod: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  aggPascal: string,
  aggSnake: string,
  op: OperationIR,
): string {
  const opSnake = snake(op.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  // A provenanced write-site captures lineage inline (co-located column + the
  // per-process trace buffer), and the persist drains that buffer into the
  // history table inside a transaction.  `captureProvenance` gates the body
  // rendering; `hasProv` gates the transactional persist tail.
  const hasProv = opHasProvSite(op);
  // An audited operation captures a who/what/when + before/after wire snapshot
  // into the `audit_records` table, recorded INSIDE the save transaction so the
  // row commits atomically with the aggregate update.  Like provenance, `audited`
  // forces the transactional persist tail — a bare changeset pipe has no
  // transaction to record into.  Where both are present they SHARE one transaction.
  const hasAudit = op.audited === true;
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
    captureProvenance: hasProv,
    // The enriched aggregate, so the body renderer can detect reference-
    // collection (`X id[]`) add/remove and normalise to id lists (the persist
    // then `put_assoc`s the resolved structs instead of `put_change`).
    agg: agg as EnrichedAggregateIR,
  };

  // The `before` wire snapshot — taken from the ORIGINAL `record` before the
  // body rebinds any field, so it reflects the pre-mutation state (parity with
  // the Hono/Python `before` captured before the mutation).
  const beforeBind = hasAudit ? `    audit_before = ${wireSnapshot("record")}\n` : "";

  // Bind only the params the body references, so an unused param never trips
  // `mix compile --warnings-as-errors`.  (`record` is always used — the persist
  // pipeline reads it — so it needs no such guard.)
  const usedParams = op.params.filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)));
  const paramBinds = usedParams.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );

  // Render the body (guards / assigns / emit / let) — shared with the
  // returning-op path; a non-returning body never carries a `return` arm.  The
  // statement index disambiguates per-write provenance temp vars.
  const bodyLines = op.statements.map((s, i) => renderReturningStmt(s, ctx, rc, i));

  // Persist the fields the body assigned (deduped, declaration order) + the
  // co-located `<field>_provenance` backing columns — shared with the
  // returning-op persist tail.  A reference collection (`X id[]` → `many_to_many`)
  // resolves its mutated id list back to target structs and `put_assoc`s them;
  // see `persistPutBodies`.  Re-indented per persist path (4-space for the plain
  // pipe, 6-space inside the `changeset =` assignment).
  const putBodies = persistPutBodies(
    op,
    agg,
    facadeMod.split(".")[0]!,
    facadeMod.split(".").slice(1).join("."),
  );
  const putBlock = putBodies.map((b) => `\n    |> ${b}`).join("");
  const putBlock6 = putBodies.map((b) => `\n      |> ${b}`).join("");

  const prelude = [...paramBinds, ...bodyLines].join("\n");
  const preludeBlock = prelude ? `${beforeBind}${prelude}\n` : beforeBind;

  // Persist tail.  Without provenance or audit: the plain changeset pipe.  With
  // either: build the changeset, then run the save + (history flush and/or audit
  // record) in ONE shared transaction so the derived rows commit atomically with
  // the aggregate update.
  const appModule = facadeMod.split(".")[0]!;
  const aggPascalName = upperFirst(agg.name);
  const txTail: string[] = [];
  if (hasProv) txTail.push(`          ${appModule}.Provenance.flush(${appModule}.Repo)`);
  if (hasAudit) {
    txTail.push(
      auditRecordCall({
        appModule,
        operationId: `${op.name}${aggPascalName}`,
        action: op.name,
        targetType: aggPascalName,
        targetId: "saved.id",
        before: "audit_before",
        after: wireSnapshot("saved"),
        indent: "          ",
      }),
    );
  }
  const persist =
    hasProv || hasAudit
      ? `    changeset =
      record
      |> Ecto.Changeset.change(%{})${putBlock6}

    ${appModule}.Repo.transaction(fn ->
      case ${repoMod}.persist_change(changeset) do
        {:ok, saved} ->
${txTail.join("\n")}
          saved

        {:error, reason} ->
          ${appModule}.Repo.rollback(reason)
      end
    end)`
      : `    record
    |> Ecto.Changeset.change(%{})${putBlock}
    |> ${repoMod}.persist_change()`;

  return `  @doc "Named operation \`${op.name}\` on \`${aggPascal}\` — runs the body, persists the assigned fields."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t() | term()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${opUsesCurrentUser(op) ? ", current_user \\\\ nil" : ""}) when is_map(params) do
${preludeBlock}${persist}
  end`;
}
