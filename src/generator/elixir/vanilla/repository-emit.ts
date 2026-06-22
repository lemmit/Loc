// ---------------------------------------------------------------------------
// Vanilla Repository emit — per-aggregate
// `lib/<app>/<ctx>/<agg>_repository.ex`.  Slices 1, 8 of
// vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Repo queries returning `{:ok, _} | {:error, _}` results.
// No Ash code interface.  Slice 8 (custom finds) emits one fn per
// repository `find` declaration alongside the CRUD seam — a
// parameterised Ecto query, return shape matched to the find's
// declared type (`Customer?` → `Repo.one(query)`; `Customer[]` →
// `Repo.all(query)`).  The matching context defdelegate is emitted by
// `context-emit.ts` so a workflow's `repo-let` lowering can call it.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  RepositoryIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  aggregateUsesPrincipalContextFilter,
  combineWhere,
  vanillaCapabilityFilter,
} from "./capability-filter.js";
import { isVanillaDocAgg, renderDocRepository } from "./document-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import {
  containsRefCollField,
  hasRefColls,
  preloadList,
  preloadSuffix,
  putAssocLines,
  refCollRepoHelpers,
} from "./ref-collection-emit.js";
import { aggregateHasStamps, stampPutChanges, stampUsesPrincipal } from "./stamp-emit.js";
import { valueCollectionsWithVo } from "./value-collection-schema-emit.js";

export function emitVanillaRepositories(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
  principalIdKey = "id",
): void {
  const ctxModule = upperFirst(ctx.name);
  for (const agg of ctx.aggregates) {
    // Event-sourced aggregates get an event-store repository from
    // `eventsourced-emit.ts` (load+fold reads, append writes) instead.
    if (isEventSourced(agg)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_repository.ex`,
      isVanillaDocAgg(agg, ctx, sys)
        ? renderDocRepository(appModule, ctxModule, agg)
        : renderRepository(appModule, ctxModule, agg, repo, principalIdKey, ctx),
    );
  }
}

/** Custom finds the repository module emits — the enrichment-synthesized
 *  `all` find is dropped (the existing `list/0` CRUD seam already covers
 *  it; emitting `all/0` would collide with the defdelegate).  Same skip
 *  policy as the Ash path (`repository-emit.ts:buildFindActions`). */
export function customFindsOf(repo: RepositoryIR | undefined): FindIR[] {
  return (repo?.finds ?? []).filter((f) => f.name !== "all");
}

/** Does the find's declared return type produce ZERO-OR-ONE record
 *  (vs a list)?  `Customer?` lowers to `{kind:"optional", inner:entity}`;
 *  `Customer` (rare in finds but admissible) is a bare entity; a union find
 *  (`Customer or NotFound`) is also a single-get — the absent variant is the
 *  `nil` case, translated at the controller.  Anything else (array) is a list. */
function isSingleReturn(t: TypeIR): boolean {
  if (t.kind === "optional" && t.inner.kind === "entity") return true;
  if (t.kind === "entity") return true;
  if (t.kind === "union") return true;
  return false;
}

function renderRepository(
  appModule: string,
  ctxModule: string,
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  principalIdKey: string,
  ctx?: BoundedContextIR,
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;
  const contextModule = `${appModule}.${ctxModule}`;

  // Value-object collections (`charges: Money[]`) are `has_many` associations —
  // preloaded on every read so the wire shape materialises (an unloaded
  // `has_many` serialises as `%Ecto.Association.NotLoaded{}`).  Ordered via the
  // schema's `preload_order: [asc: :ordinal]`.
  const valueCollectionRels = ctx
    ? valueCollectionsWithVo(agg, ctx).map((v) => `:${snake(v.vc.fieldName)}`)
    : [];

  // Lifecycle stamps (`with audit`/`auditable`, `stamp onCreate/onUpdate`) →
  // `put_change` pipe lines on the changeset right before the Repo write.  A
  // stamp that references the principal threads `current_user` into the write
  // seam (the analogue of the read-side `current_user \\ nil` for tenancy
  // filters); a non-principal stamp (`createdAt := now()`) needs no actor.  On
  // insert BOTH onCreate AND onUpdate stamps apply (so NOT-NULL `updated_*`
  // audit columns are filled on the initial insert, mirroring the Ash
  // `on: [:create, :update]`); on update only onUpdate stamps apply.
  const hasStamps = aggregateHasStamps(agg);
  const stampPrincipal = stampUsesPrincipal(agg);
  const stampActorParam = stampPrincipal ? ", current_user \\\\ nil" : "";
  const insertStamps = stampPutChanges(
    agg,
    ["create", "update"],
    contextModule,
    principalIdKey,
    "    ",
  );
  const updateStamps = stampPutChanges(agg, ["update"], contextModule, principalIdKey, "    ");

  const finds = customFindsOf(repo);
  // A principal (tenancy) `filter` threads `current_user` (from the request) into
  // the scoped reads; a non-principal filter (soft-delete) needs no actor.  Only
  // principal aggregates gain the extra `current_user \\ nil` parameter — every
  // other repository stays byte-identical.  The `\\ nil` default keeps internal
  // callers (workflows) compiling and fail-closed (a nil actor scopes to no rows).
  const principal = aggregateUsesPrincipalContextFilter(agg);
  const cap = vanillaCapabilityFilter(agg, contextModule, { actor: principal });
  // Reference collections (`X id[]` → `many_to_many`) need `import Ecto.Query`
  // for the id-list resolution (`from(t in Target, where: t.id in ^ids)`) and
  // `Repo.preload(...)` on every read so the serializer sees the loaded ids.
  const refColls = hasRefColls(agg);
  // Reads preload BOTH the value-collection `has_many` and the reference-collection
  // `many_to_many` relationships in one round-trip, so the serializer materialises
  // every wire field (an unloaded assoc serialises as `%Ecto.Association.NotLoaded{}`).
  const preloadRels = [...valueCollectionRels, ...preloadList(agg)];
  const preload = preloadRels.length > 0 ? ` |> Repo.preload([${preloadRels.join(", ")}])` : "";
  const findFns = finds.map((f) =>
    renderFindFn(f, agg, aggModule, contextModule, principal, preload),
  );
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}\n` : "";

  // Reference-collection (`X id[]` → `many_to_many`) wiring on the write seam:
  // resolve the incoming id list to target structs and `put_assoc` them.  Insert
  // and the named-op persist start from a fresh / loaded record; update preloads
  // the existing association first so `put_assoc` can replace it cleanly.
  const refAssocLines = putAssocLines(appModule, ctxModule, agg, "    ");
  const insertPutAssoc = refAssocLines.length > 0 ? `\n${refAssocLines.join("\n")}` : "";
  const updatePutAssoc = insertPutAssoc;
  const updatePreload = refColls ? ` |> Repo.preload([${preloadList(agg).join(", ")}])` : "";
  const refHelpers = refColls ? `\n${refCollRepoHelpers(appModule)}\n` : "";
  // `import Ecto.Query` is required for `from(...)` — needed when there's a
  // custom find OR a capability filter (which turns `list`/`find_by_id` into
  // `from(...)` reads) OR a reference collection (id-list resolution).  Omit it
  // otherwise to keep plain repositories byte-identical to before.
  const ectoImport = finds.length > 0 || cap || refColls ? `\n  import Ecto.Query` : "";
  // The threaded actor parameter (principal filters only).
  const actorParam = principal ? "current_user \\\\ nil" : "";
  const listHead = principal ? `def list(${actorParam}) do` : "def list do";
  const listSpec = principal
    ? `@spec list(map() | nil) :: {:ok, [${aggModule}.t()]} | {:error, term()}`
    : `@spec list() :: {:ok, [${aggModule}.t()]} | {:error, term()}`;
  // `list`: bare `Repo.all(<Agg>)` unless a capability filter scopes it.
  // `Repo.preload/2` accepts the whole list, so the value-collection has_many
  // and reference-collection many_to_many associations come back loaded (and
  // ordinal-ordered, for value collections) in one round-trip.
  const listBody =
    (cap ? `from(record in ${aggModule}, where: ${cap}) |> Repo.all()` : `Repo.all(${aggModule})`) +
    preload;
  const findByIdHead = principal
    ? `def find_by_id(id, ${actorParam}) when is_binary(id) do`
    : "def find_by_id(id) when is_binary(id) do";
  const findByIdSpec = principal
    ? `@spec find_by_id(binary(), map() | nil) :: {:ok, ${aggModule}.t()} | {:error, :not_found}`
    : `@spec find_by_id(binary()) :: {:ok, ${aggModule}.t()} | {:error, :not_found}`;
  // `find_by_id`: `Repo.get` can't carry the capability `where`, so a scoped
  // read becomes a `from(... where: id and cap) |> Repo.one()` (a soft-deleted
  // / out-of-scope row then reads as `:not_found`, matching every other backend).
  const findByIdBody = cap
    ? `case Repo.one(from(record in ${aggModule}, where: record.id == ^id and (${cap}))) do`
    : `case Repo.get(${aggModule}, id) do`;
  // Preload the reference-collection relationships on the loaded row so the
  // serializer projects them to id arrays.
  const findByIdHit = preload ? `record -> {:ok, record${preload}}` : "record -> {:ok, record}";

  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc false${ectoImport}
  alias ${appModule}.Repo

  ${listSpec}
  ${listHead}
    {:ok, ${listBody}}
  end

  ${findByIdSpec}
  ${findByIdHead}
    ${findByIdBody}
      nil -> {:error, :not_found}
      ${findByIdHit}
    end
  end

  @spec insert(map()${hasStamps && stampPrincipal ? ", map() | nil" : ""}) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs${stampActorParam}) when is_map(attrs) do
    ${aggModule}Changeset.base_changeset(attrs)${insertStamps}${insertPutAssoc}
    |> Repo.insert()
  end

  @spec update(${aggModule}.t(), map()${hasStamps && stampPrincipal ? ", map() | nil" : ""}) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def update(%${aggModule}{} = record, attrs${stampActorParam}) when is_map(attrs) do
    record${updatePreload}
    |> ${aggModule}Changeset.base_changeset(attrs)${updateStamps}${updatePutAssoc}
    |> Repo.update()
  end

  @spec delete(${aggModule}.t()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def delete(%${aggModule}{} = record) do
    Repo.delete(record)
  end

  @doc "Persist a pre-built changeset (Slice 5c — named-operation seam)."
  @spec persist_change(Ecto.Changeset.t()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def persist_change(%Ecto.Changeset{data: %${aggModule}{}} = changeset) do
    Repo.update(changeset)
  end${findBlock}${refHelpers || "\n"}end
`;
}

/** One custom-find function — a parameterised Ecto query under the
 *  `record` Ecto binding, returning `{:ok, _}` shaped per the find's
 *  declared return type.  Mirrors the vanilla-retrieval shape from
 *  `retrieval-emit.ts` (filterArgs + foundation: "vanilla" → `^pin`
 *  syntax, enum strings).  Convention-finds without a `where` clause
 *  (params match aggregate property names; e.g. `byCustomer(customerId)`)
 *  fall through to a per-param `record.<param> == ^<param>` predicate
 *  generated here, matching the source-level convention spelled out in
 *  examples/sales.ddd. */
function renderFindFn(
  f: FindIR,
  agg: AggregateIR,
  aggModule: string,
  contextModule: string,
  principal: boolean,
  preload: string,
): string {
  // The capability filter for THIS find — recomputed with the find's own
  // `ignoring` clause so a bypassed capability's `where:` predicate is omitted
  // from this finder only (other reads keep the full conjunction).
  const cap = vanillaCapabilityFilter(agg, contextModule, {
    actor: principal,
    bypass: { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps },
  });
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  // A principal-filtered aggregate threads the request actor into the find too
  // (the `cap` references `current_user`).  `\\ nil` keeps the workflow callers
  // compiling + fail-closed.
  const argList = [...argNames, ...(principal ? ["current_user \\\\ nil"] : [])].join(", ");
  const single = isSingleReturn(f.returnType);

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    foundation: "vanilla",
    // Params bind via Ecto pin syntax (`^needle`) inside the `from
    // ... where: ...` macro.  See render-expr.ts:filterArgs.
    filterArgs: true,
  };

  const fetchCallEarly = isSingleReturn(f.returnType) ? "Repo.one(query)" : "Repo.all(query)";
  const specTailEarly = isSingleReturn(f.returnType)
    ? `{:ok, ${aggModule}.t() | nil} | {:error, term()}`
    : `{:ok, [${aggModule}.t()]} | {:error, term()}`;
  const specArgsEarly = [...argNames.map(() => "term()"), ...(principal ? ["map() | nil"] : [])];

  // `this.<refColl>.contains(arg)` over a reference collection → a join-table
  // query against the `many_to_many` relationship (the vanilla analogue of the
  // Ash `exists(<rel>, id == ^arg)` filter).  The orphan `Enum.member?` shape the
  // shared renderer produces would query a phantom array column — this joins the
  // real join table instead.  The argument is the find's single id parameter.
  const containsField = containsRefCollField(f.filter, agg);
  if (containsField) {
    const rel = snake(containsField);
    const arg = argNames[0] ?? "nil";
    const where = combineWhere(`join_row.id == ^${arg}`, cap) ?? `join_row.id == ^${arg}`;
    const spec = `  @spec ${fnName}(${specArgsEarly.join(", ")}) :: ${specTailEarly}`;
    return `${spec}
  def ${fnName}(${argList}) do
    query =
      from(record in ${aggModule},
        join: join_row in assoc(record, :${rel}),
        where: ${where},
        distinct: true
      )

    {:ok, ${fetchCallEarly}${preload}}
  end`;
  }

  let whereExpr: string;
  if (f.filter) {
    whereExpr = renderExpr(f.filter, renderCtx);
  } else {
    // Convention-finds: per-param `record.<name> == ^<name>` predicate,
    // joined with `and`.  Matches the source-level convention (see
    // examples/sales.ddd's `find byCustomer(customerId: Customer id)`).
    whereExpr = argNames.map((n) => `record.${n} == ^${n}`).join(" and ");
  }
  // AND the aggregate's capability filter into the find's own predicate
  // (a find must honour the same soft-delete / scoping the CRUD reads do).
  whereExpr = combineWhere(whereExpr || null, cap) ?? "";

  const fetchCall = (single ? `Repo.one(query)` : `Repo.all(query)`) + preload;
  const specTail = single
    ? `{:ok, ${aggModule}.t() | nil} | {:error, term()}`
    : `{:ok, [${aggModule}.t()]} | {:error, term()}`;
  const specArgs = [...argNames.map(() => "term()"), ...(principal ? ["map() | nil"] : [])];
  const spec = `  @spec ${fnName}(${specArgs.join(", ")}) :: ${specTail}`;
  // A find with neither a `where` clause nor convention params (e.g. an
  // unfiltered `find recent(): Order`) has an empty predicate — emit a bare
  // `from(record in Mod)` rather than `where: ` (which is invalid Elixir).
  const query = whereExpr
    ? `from(record in ${aggModule}, where: ${whereExpr})`
    : `from(record in ${aggModule})`;
  return `${spec}
  def ${fnName}(${argList}) do
    query = ${query}
    {:ok, ${fetchCall}}
  end`;
}
