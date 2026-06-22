// ---------------------------------------------------------------------------
// Vanilla context module — `lib/<app>/<ctx>.ex`.  Slices 1, 2, 5c of
// vanilla-foundation-tdd-plan.md.
//
// Plain Elixir context module (no `use Ash.Domain`).  Façade that
// re-exports the per-aggregate Repository functions plus named-
// operation handlers (Slice 5c prerequisite — workflows on vanilla
// need `<op>_<agg>(record, params)` for cross-aggregate operation
// calls in the workflow body).
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { stmtUsesParam } from "../domain/predicates.js";
import type { RenderCtx } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import {
  customFindsOfAgg,
  esContextNeedsEnsure,
  isEventSourced,
  renderEnsureHelper,
  renderEsContextBlock,
} from "./eventsourced-emit.js";
import {
  isReturningOperation,
  renderReturningOpFunction,
  renderReturningStmt,
} from "./operation-returns-emit.js";
import { provColumn, provenancedFieldsOf } from "./provenance-emit.js";
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
): void {
  const ctxSnake = snake(ctx.name);
  const ctxModule = upperFirst(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  out.set(`lib/${appSnake}/${ctxSnake}.ex`, renderContextModule(appModule, ctxModule, ctx));
}

function renderContextModule(appModule: string, ctxModule: string, ctx: BoundedContextIR): string {
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
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(${principal ? "current_user \\\\ nil" : ""}), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id${actorArg}), to: ${repoMod}, as: :find_by_id
  defdelegate create_${aggSnake}(attrs${stampActorArg}), to: ${repoMod}, as: :insert
  defdelegate update_${aggSnake}(record, attrs${stampActorArg}), to: ${repoMod}, as: :update
  defdelegate delete_${aggSnake}(record), to: ${repoMod}, as: :delete
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

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions plus named-operation
  handlers (Slice 5c prerequisite — workflows on vanilla need
  \`<op>_<agg>(record, params)\` for cross-aggregate calls in the
  workflow body).  Vanilla foundation (no Ash.Domain).
  """

${blocks.join("\n")}${retrievalBlock}${ensureBlock}end
`;
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
  const containNames = new Set(agg.contains.map((c) => snake(c.name)));
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

  // Persist the fields the body assigned (deduped, declaration order).  Each is
  // a real schema column on the mutated `record`, so `put_change` is safe.
  const assignedFields: string[] = [];
  for (const s of op.statements) {
    // `assign` (`field := v`), collection `add`/`remove` (`items += Item{…}`),
    // and scalar compound `add`/`remove` (`total += n`) all re-bind a real
    // schema column on `record` — persist each via `put_change`.
    if (s.kind !== "assign" && s.kind !== "add" && s.kind !== "remove") continue;
    const f = snake(s.target.segments[0] ?? "");
    if (f.length > 0 && !assignedFields.includes(f)) assignedFields.push(f);
  }
  // Co-located provenance columns ride the same changeset: a `<field>_provenance`
  // jsonb backing column for each provenanced field the body actually assigned.
  const provNames = new Set(provenancedFieldsOf(agg).map((f) => snake(f.name)));
  const provColumns = assignedFields.filter((f) => provNames.has(f)).map((f) => provColumn(f));
  // Put bodies — re-indented per persist path (4-space for the plain pipe,
  // 6-space inside the `changeset =` assignment).  A containment
  // (`embeds_many`/`embeds_one`) round-trips via `put_embed`; scalar columns
  // (incl. the provenance backing columns) via `put_change`.
  const putBodies = [
    ...assignedFields.map((f) =>
      containNames.has(f)
        ? `Ecto.Changeset.put_embed(:${f}, record.${f})`
        : `Ecto.Changeset.put_change(:${f}, record.${f})`,
    ),
    ...provColumns.map((c) => `Ecto.Changeset.put_change(:${c}, record.${c})`),
  ];
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
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params) when is_map(params) do
${preludeBlock}${persist}
  end`;
}
