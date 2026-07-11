// ---------------------------------------------------------------------------
// Vanilla Repository emit — per-aggregate
// `lib/<app>/<ctx>/<agg>_repository.ex`.  Slices 1, 8 of
// vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Repo queries returning `{:ok, _} | {:error, _}` results.
// Slice 8 (custom finds) emits one fn per
// repository `find` declaration alongside the CRUD seam — a
// parameterised Ecto query, return shape matched to the find's
// declared type (`Customer?` → `Repo.one(query)`; `Customer[]` →
// `Repo.all(query)`).  The matching context defdelegate is emitted by
// `context-emit.ts` so a workflow's `repo-let` lowering can call it.
// ---------------------------------------------------------------------------

import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  FindIR,
  RepositoryIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  aggregateUsesPrincipalContextFilter,
  combineWhere,
  vanillaCapabilityFilter,
  vanillaWriteScopeFilter,
} from "./capability-filter.js";
import { aggregateNeedsUpdateChangeset } from "./changeset-emit.js";
import { isVanillaDocAgg, renderDocRepository } from "./document-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { isAbstractBase, isTphBase, tpcConcretesOf, tphKind } from "./inheritance-emit.js";
import {
  containsRefCollField,
  hasRefColls,
  preloadList,
  putAssocLines,
  refCollRepoHelpers,
} from "./ref-collection-emit.js";
import { emitsRestDelete } from "./rest-surface.js";
import { usesRelationalContainments } from "./schema-emit.js";
import {
  aggregateHasStamps,
  stampPutChanges,
  stampUsesPrincipal,
  stampUsesPrincipalFor,
} from "./stamp-emit.js";
import { valueCollectionsWithVo } from "./value-collection-schema-emit.js";

export function emitVanillaRepositories(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
  principalIdKey = "id",
  sourcemap?: SourceMapRecorder,
): void {
  const ctxModule = upperFirst(ctx.name);
  const pool = ctx.aggregates;
  for (const agg of ctx.aggregates) {
    // Event-sourced aggregates get an event-store repository from
    // `eventsourced-emit.ts` (load+fold reads, append writes) instead.
    if (isEventSourced(agg)) continue;
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    // An abstract inheritance base is never instantiated — it gets a READ-ONLY
    // polymorphic reader (`find all <Base>`), not the CRUD seam.  TPH reads the
    // shared table + dispatches on `kind`; TPC delegates to the concrete repos.
    const content = isAbstractBase(agg)
      ? renderBaseReader(appModule, ctxModule, agg, pool)
      : isVanillaDocAgg(agg, ctx, sys)
        ? renderDocRepository(appModule, ctxModule, agg, customFindsOf(repo))
        : renderRepository(appModule, ctxModule, agg, repo, principalIdKey, ctx, pool, sys);
    const path = `lib/${appSnake}/${ctxSnake}/${aggSnake}_repository.ex`;
    out.set(path, content);
    sourcemap?.file(path, content, repo?.origin ?? agg.origin, `${ctx.name}.${agg.name}`);
  }
}

/** Custom finds the repository module emits — the enrichment-synthesized
 *  `all` find is dropped (the existing `list/0` CRUD seam already covers
 *  it; emitting `all/0` would collide with the defdelegate). */
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
  pool: readonly AggregateIR[] = ctx?.aggregates ?? [agg],
  sys?: SystemIR,
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;
  const contextModule = `${appModule}.${ctxModule}`;
  // TPH (`sharedTable`) concrete: every row lives in the shared base table
  // (`parties`) discriminated by `kind`, so the schema points there.  Reads MUST
  // filter `record.kind == "<Concrete>"` (else `Repo.all(Customer)` would also
  // return vendors), and inserts MUST stamp `kind` so the row is routable.  This
  // is the runtime half of the §8 fix — the schema change alone would read every
  // subtype's rows back as the wrong struct.
  const kind = tphKind(agg, pool);
  const kindFilter = kind ? `record.kind == ${JSON.stringify(kind)}` : null;

  // Value-object collections (`charges: Money[]`) are `has_many` associations —
  // preloaded on every read so the wire shape materialises (an unloaded
  // `has_many` serialises as `%Ecto.Association.NotLoaded{}`).  Ordered via the
  // schema's `preload_order: [asc: :ordinal]`.
  const valueCollectionRels = ctx
    ? valueCollectionsWithVo(agg, ctx).map((v) => `:${snake(v.vc.fieldName)}`)
    : [];

  // Relational entity-part containments (§11c) are `has_many`/`has_one`
  // associations — preloaded on every read so the wire shape materialises (an
  // unloaded association serialises as `%Ecto.Association.NotLoaded{}`, which
  // Jason can't encode → 500).  Empty on an embedded aggregate (the parts fold
  // into the jsonb column and load with the row).
  const containmentRels =
    ctx && usesRelationalContainments(agg, ctx, sys)
      ? agg.contains.map((c) => `:${snake(c.name)}`)
      : [];

  // Lifecycle stamps (`with audit`/`auditable`, `stamp onCreate/onUpdate`) →
  // `put_change` pipe lines on the changeset right before the Repo write.  A
  // stamp that references the principal threads `current_user` into the write
  // seam (the analogue of the read-side `current_user \\ nil` for tenancy
  // filters); a non-principal stamp (`createdAt := now()`) needs no actor.  On
  // insert BOTH onCreate AND onUpdate stamps apply (so NOT-NULL `updated_*`
  // audit columns are filled on the initial insert); on update only onUpdate
  // stamps apply.
  const hasStamps = aggregateHasStamps(agg);
  const stampPrincipal = stampUsesPrincipal(agg);
  const stampActorParam = stampPrincipal ? ", current_user \\\\ nil" : "";
  // The update seam keeps the same arity (callers thread the actor whenever
  // ANY stamp is principal-valued) but only USES the actor when an
  // `onUpdate` stamp reads it — an onCreate-only principal stamp (tenantOwned)
  // would otherwise leave `current_user` unused and fail
  // `mix compile --warnings-as-errors`.
  const updateStampActorParam = stampPrincipal
    ? `, ${stampUsesPrincipalFor(agg, ["update"]) ? "" : "_"}current_user \\\\ nil`
    : "";
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
  // The effective read filter — the capability filter AND the TPH `kind`
  // discriminator (for a concrete sharing the base table).  A non-TPH aggregate
  // keeps `capEff === cap` so its output stays byte-identical.
  const capEff = combineWhere(kindFilter, cap);
  // The WRITE-scope command-load filter (authorization Phase 3 P3.1) — null
  // unless the aggregate's write scope is narrower than its read scope.  When
  // present, a `find_by_id_for_write` mirrors `find_by_id` but scopes on it.
  const writeScope = vanillaWriteScopeFilter(agg, contextModule);
  const writeEff = combineWhere(kindFilter, writeScope);
  // Does the write-scope predicate actually reference the principal?  A DENY
  // carve-out (`deny write on X`, authorization Phase 4) is always-false and uses
  // NO `current_user`, so the `find_by_id_for_write` principal param must be
  // underscored or `--warnings-as-errors` trips on the unused variable.  The
  // tenant-floor / deep write scopes DO reference it.
  const writeScopeUsesPrincipal =
    agg.writeScopeFilter !== undefined && exprUsesCurrentUser(agg.writeScopeFilter);
  // On insert, a TPH concrete stamps its `kind` discriminator (the migration's
  // NOT-NULL text column) so the shared-table row is routable back to this
  // subtype.  `kind` isn't a cast field (it's not a declared aggregate column),
  // so `put_change` it onto the changeset directly.
  const kindStamp = kind
    ? `\n    |> Ecto.Changeset.put_change(:kind, ${JSON.stringify(kind)})`
    : "";
  // Reference collections (`X id[]` → `many_to_many`) need `import Ecto.Query`
  // for the id-list resolution (`from(t in Target, where: t.id in ^ids)`) and
  // `Repo.preload(...)` on every read so the serializer sees the loaded ids.
  const refColls = hasRefColls(agg);
  // Reads preload BOTH the value-collection `has_many` and the reference-collection
  // `many_to_many` relationships in one round-trip, so the serializer materialises
  // every wire field (an unloaded assoc serialises as `%Ecto.Association.NotLoaded{}`).
  const preloadRels = [...valueCollectionRels, ...containmentRels, ...preloadList(agg)];
  const preload = preloadRels.length > 0 ? ` |> Repo.preload([${preloadRels.join(", ")}])` : "";
  const findFns = finds.map((f) =>
    renderFindFn(f, agg, aggModule, contextModule, principal, preload, kindFilter),
  );
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}\n` : "";

  // Reference-collection (`X id[]` → `many_to_many`) wiring on the write seam:
  // resolve the incoming id list to target structs and `put_assoc` them.  Insert
  // and the named-op persist start from a fresh / loaded record; update preloads
  // the existing association first so `put_assoc` can replace it cleanly.
  const refAssocLines = putAssocLines(appModule, ctxModule, agg, "    ");
  const insertPutAssoc = refAssocLines.length > 0 ? `\n${refAssocLines.join("\n")}` : "";
  const updatePutAssoc = insertPutAssoc;
  // The insert result must preload the SAME wire-shape associations the reads do.
  // `Repo.insert` returns the struct with any association the create body didn't
  // touch still `%Ecto.Association.NotLoaded{}` — e.g. an empty containment (the
  // reads preload it, `update` preloads it before its changeset, but a fresh
  // insert never did) — and the serializer's `Map.from_struct` then hands that
  // sentinel to Jason, which raises `cannot encode association … not loaded`.
  // Preloading is idempotent: `Repo.preload` skips relationships already loaded
  // by `put_assoc`/`cast_assoc`, so it only materialises the untouched ones.
  const insertPipeline = `${aggModule}Changeset.base_changeset(attrs)${kindStamp}${insertStamps}${insertPutAssoc}
    |> Repo.insert()`;
  const insertBody = preload
    ? `case ${insertPipeline} do
      {:ok, record} -> {:ok, record${preload}}
      error -> error
    end`
    : insertPipeline;
  // The update path preloads the existing reference-collection AND relational
  // containment associations before `base_changeset` so `cast_assoc` /
  // `put_assoc` can replace them cleanly (`cast_assoc` on an unloaded assoc
  // raises; `on_replace: :delete` needs the prior rows to diff against).
  const updatePreloadRels = [...(refColls ? preloadList(agg) : []), ...containmentRels];
  const updatePreload =
    updatePreloadRels.length > 0 ? ` |> Repo.preload([${updatePreloadRels.join(", ")}])` : "";
  const refHelpers = refColls ? `\n${refCollRepoHelpers(appModule)}\n` : "";
  // `import Ecto.Query` is required for `from(...)` — needed when there's a
  // custom find OR a capability filter (which turns `list`/`find_by_id` into
  // `from(...)` reads) OR a reference collection (id-list resolution).  Omit it
  // otherwise to keep plain repositories byte-identical to before.
  const ectoImport = finds.length > 0 || capEff || refColls ? `\n  import Ecto.Query` : "";
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
    (capEff
      ? `from(record in ${aggModule}, where: ${capEff}) |> Repo.all()`
      : `Repo.all(${aggModule})`) + preload;
  const findByIdHead = principal
    ? `def find_by_id(id, ${actorParam}) when is_binary(id) do`
    : "def find_by_id(id) when is_binary(id) do";
  const findByIdSpec = principal
    ? `@spec find_by_id(binary(), map() | nil) :: {:ok, ${aggModule}.t()} | {:error, :not_found}`
    : `@spec find_by_id(binary()) :: {:ok, ${aggModule}.t()} | {:error, :not_found}`;
  // `find_by_id`: `Repo.get` can't carry the capability `where`, so a scoped
  // read becomes a `from(... where: id and cap) |> Repo.one()` (a soft-deleted
  // / out-of-scope row then reads as `:not_found`, matching every other backend).
  const findByIdBody = capEff
    ? `case Repo.one(from(record in ${aggModule}, where: record.id == ^id and (${capEff}))) do`
    : `case Repo.get(${aggModule}, id) do`;
  // Preload the reference-collection relationships on the loaded row so the
  // serializer projects them to id arrays.
  const findByIdHit = preload ? `record -> {:ok, record${preload}}` : "record -> {:ok, record}";

  // Optimistic concurrency (`versioned` capability, D-VERSIONED).  The update
  // takes the client's EXPECTED version (the controller parsed it from the
  // If-Match header) as a trailing `expected_version \\ nil` param and overrides
  // the loaded struct's `:version` with it BEFORE building the changeset — so
  // `optimistic_lock` (in `update_changeset`) guards the write on the value the
  // client last saw (think-time CAS).  Absent → the loaded row's own version
  // (write-time CAS).  A stale write RAISES `Ecto.StaleEntryError` (not a
  // changeset error), rescued here into `{:error, :conflict}` (→ 409 at the
  // controller).  A non-versioned aggregate keeps the plain `base_changeset`
  // update (byte-identical).
  const versioned = aggregateIsVersioned(agg);
  const versionedParam = versioned ? ", expected_version \\\\ nil" : "";
  const versionOverride = versioned
    ? `    record = %{record | version: expected_version || record.version}\n\n`
    : "";
  // The generic PATCH routes through `update_changeset` whenever the aggregate
  // needs one (containment owner, update-excluded field, or versioned) — that
  // changeset drops contained-part casts + immutable/token columns, so a PATCH
  // can't bulk-replace containment or rewrite server-owned state.  Otherwise it
  // reuses `base_changeset` (byte-identical — strict additivity).
  const updateChangesetFn = aggregateNeedsUpdateChangeset(agg, ctx, sys)
    ? "update_changeset"
    : "base_changeset";
  const updateRescue = versioned
    ? "\n  rescue\n    Ecto.StaleEntryError -> {:error, :conflict}"
    : "";
  const updateErrTail = versioned ? "Ecto.Changeset.t() | :conflict" : "Ecto.Changeset.t()";
  const updateSpecArgTail = `${hasStamps && stampPrincipal ? ", map() | nil" : ""}${versioned ? ", integer() | nil" : ""}`;

  // The CRUD `delete/1` repository fn is emitted only when the aggregate exposes
  // a REST delete surface (a reachable `destroy`).  Without it the function was
  // dead code: no route, no context delegate, no LiveView seam reached it (audit
  // `generated-code-ddd-review-2026-07.md`: the dead hard-`Repo.delete`).  Gated
  // on the SAME `emitsRestDelete` predicate the router / controller / context use.
  // The `destroy_<agg>!` LiveView `DestroyForm` seam is a separate `Repo.delete!`
  // on the context module (its own `hasDestroy` gate), so it is unaffected.
  const deleteBlock = emitsRestDelete(agg)
    ? `
  @spec delete(${aggModule}.t()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def delete(%${aggModule}{} = record) do
    Repo.delete(record)
  end

`
    : "\n";

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
${
  // Gate on `writeScope` (the aggregate's own write-scope narrowing), NOT
  // `writeEff`: a TPH concrete carries a non-null `kindFilter` even with no
  // write policy, and a kind-only guard would never reference `current_user`
  // → an unused-variable warning that fails `--warnings-as-errors` (and dead
  // code — the facade/controller only dispatch here when `writeScopeFilter`
  // is set).  `writeEff` still supplies the body so a real write guard on a
  // TPH concrete keeps its kind discriminator.
  writeScope
    ? `
  @doc "Command-load path (authorization Phase 3 P3.1): scope the by-id load to the WRITE scope; a readable-but-not-writable (or missing) row reads as :not_found → 404."
  @spec find_by_id_for_write(binary(), map() | nil) :: {:ok, ${aggModule}.t()} | {:error, :not_found}
  def find_by_id_for_write(id, ${writeScopeUsesPrincipal ? "current_user" : "_current_user"} \\\\ nil) when is_binary(id) do
    case Repo.one(from(record in ${aggModule}, where: record.id == ^id and (${writeEff}))) do
      nil -> {:error, :not_found}
      ${findByIdHit}
    end
  end
`
    : ""
}

  @spec insert(map()${hasStamps && stampPrincipal ? ", map() | nil" : ""}) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs${stampActorParam}) when is_map(attrs) do
    ${insertBody}
  end

  @spec update(${aggModule}.t(), map()${updateSpecArgTail}) :: {:ok, ${aggModule}.t()} | {:error, ${updateErrTail}}
  def update(%${aggModule}{} = record, attrs${updateStampActorParam}${versionedParam}) when is_map(attrs) do
${versionOverride}    record${updatePreload}
    |> ${aggModule}Changeset.${updateChangesetFn}(attrs)${updateStamps}${updatePutAssoc}
    |> Repo.update()${updateRescue}
  end
${deleteBlock}  @doc "Persist a pre-built changeset (Slice 5c — named-operation seam)."
  @spec persist_change(Ecto.Changeset.t()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def persist_change(%Ecto.Changeset{data: %${aggModule}{}} = changeset) do
    Repo.update(changeset)
  end${findBlock}${refHelpers || "\n"}end
`;
}

/** One custom-find function — a parameterised Ecto query under the
 *  `record` Ecto binding, returning `{:ok, _}` shaped per the find's
 *  declared return type.  Shares the retrieval shape from
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
  /** The TPH `record.kind == "<Concrete>"` discriminator predicate, or null for
   *  a non-TPH-concrete aggregate.  A custom find over a shared table must scope
   *  to this subtype's rows just like `list`/`find_by_id` do. */
  kindFilter: string | null = null,
): string {
  // The capability filter for THIS find — recomputed with the find's own
  // `ignoring` clause so a bypassed capability's `where:` predicate is omitted
  // from this finder only (other reads keep the full conjunction).  The TPH
  // `kind` discriminator is never bypassable (it's a physical-table fact, not a
  // capability), so it ANDs in unconditionally.
  const cap = combineWhere(
    kindFilter,
    vanillaCapabilityFilter(agg, contextModule, {
      actor: principal,
      bypass: { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps },
    }),
  );
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  // A `paged` find (`find recent(): Order paged`) returns the cross-backend
  // paged WIRE ENVELOPE — `%{items, page, page_size, total, total_pages}` — not a
  // bare list.  It threads `page` / `page_size` (1-based, with the shared
  // defaults) into the function, applies `limit`/`offset` to the Ecto query, and
  // runs a separate `Repo.aggregate(:count)` for `total`.  The atom keys
  // serialise (Jason) to the canonical camelCase JSON keys at the controller.
  const paged = pagedReturn(f.returnType);
  const pageArgs = paged
    ? [`page \\\\ ${PAGED_DEFAULT_PAGE}`, `page_size \\\\ ${PAGED_DEFAULT_PAGE_SIZE}`]
    : [];
  // A principal-filtered aggregate threads the request actor into the find too
  // (the `cap` references `current_user`).  `\\ nil` keeps the workflow callers
  // compiling + fail-closed.
  const argList = [...argNames, ...pageArgs, ...(principal ? ["current_user \\\\ nil"] : [])].join(
    ", ",
  );
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
  // query against the `many_to_many` relationship.  The orphan `Enum.member?` shape the
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
  const specTail = paged
    ? `{:ok, map()} | {:error, term()}`
    : single
      ? `{:ok, ${aggModule}.t() | nil} | {:error, term()}`
      : `{:ok, [${aggModule}.t()]} | {:error, term()}`;
  const specArgs = [
    ...argNames.map(() => "term()"),
    ...(paged ? ["pos_integer()", "pos_integer()"] : []),
    ...(principal ? ["map() | nil"] : []),
  ];
  const spec = `  @spec ${fnName}(${specArgs.join(", ")}) :: ${specTail}`;
  // A find with neither a `where` clause nor convention params (e.g. an
  // unfiltered `find recent(): Order`) has an empty predicate — emit a bare
  // `from(record in Mod)` rather than `where: ` (which is invalid Elixir).
  const query = whereExpr
    ? `from(record in ${aggModule}, where: ${whereExpr})`
    : `from(record in ${aggModule})`;

  if (paged) {
    // Paged WIRE ENVELOPE: count the unpaged query for `total`, then re-run it
    // with `limit`/`offset` for the page slice.  `total_pages` ceil-divides.
    // Keys are atoms so the controller serialises them to the canonical
    // `items/page/pageSize/total/totalPages` JSON (camelCase) every other
    // backend emits.
    return `${spec}
  def ${fnName}(${argList}) do
    query = ${query}
    total = Repo.aggregate(query, :count, :id)
    offset = (page - 1) * page_size
    items = query |> limit(^page_size) |> offset(^offset) |> Repo.all()${preload}

    {:ok,
     %{
       items: items,
       page: page,
       pageSize: page_size,
       total: total,
       totalPages: if(page_size > 0, do: ceil(total / page_size), else: 0)
     }}
  end`;
  }

  return `${spec}
  def ${fnName}(${argList}) do
    query = ${query}
    {:ok, ${fetchCall}}
  end`;
}

/** Read-only polymorphic reader for an abstract inheritance base — the read
 *  home for `find all <Base>` / dereferencing a polymorphic `<Base> id`
 *  (inheritance.md).  An abstract base is never instantiated, so it carries NO
 *  write seam (insert/update/delete); only `list` + `find_by_id`.
 *
 *    - TPH (`sharedTable`): the whole hierarchy lives in ONE table the base
 *      schema points at, with a `kind` discriminator column.  `list`/`find_by_id`
 *      read that table directly — each row deserialises into the base struct
 *      carrying its `kind` + every subtype's columns (the union schema), so the
 *      serialised wire shape is the tagged polymorphic record.
 *    - TPC (`ownTable`): the base has NO table — each concrete is standalone.
 *      So the reader DELEGATES to the per-concrete repositories and unions the
 *      results (mirrors the TS `buildTpcBaseReaderFile`): `list` concatenates
 *      each concrete's `list`, `find_by_id` tries each concrete in turn. */
function renderBaseReader(
  appModule: string,
  ctxModule: string,
  base: AggregateIR,
  pool: readonly AggregateIR[],
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(base.name)}`;
  const repoMod = `${aggModule}Repository`;

  if (isTphBase(base, pool)) {
    // TPH: read the shared base table directly; each row is a base struct
    // carrying `kind` + the union columns.
    return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc "Read-only polymorphic reader for the abstract ${upperFirst(base.name)} hierarchy (TPH / sharedTable)."
  alias ${appModule}.Repo

  @spec list() :: {:ok, [${aggModule}.t()]} | {:error, term()}
  def list do
    {:ok, Repo.all(${aggModule})}
  end

  @spec find_by_id(binary()) :: {:ok, ${aggModule}.t()} | {:error, :not_found}
  def find_by_id(id) when is_binary(id) do
    case Repo.get(${aggModule}, id) do
      nil -> {:error, :not_found}
      record -> {:ok, record}
    end
  end
end
`;
  }

  // TPC: delegate to each concrete repository and union the results.  Each
  // concrete loads its own full tree (the per-concrete `list`/`find_by_id`),
  // then the reader concatenates `list`s and tries each `find_by_id` in turn.
  const concretes = tpcConcretesOf(base, pool);
  const concreteRepos = concretes.map(
    (c) => `${appModule}.${ctxModule}.${upperFirst(c.name)}Repository`,
  );
  const concreteList = concreteRepos.map((r) => `      ${r}`).join(",\n");
  const listBody =
    concreteRepos.length > 0
      ? `Enum.reduce_while(
      [
${concreteList}
      ],
      {:ok, []},
      fn repo, {:ok, acc} ->
        case repo.list() do
          {:ok, rows} -> {:cont, {:ok, acc ++ rows}}
          {:error, _} = err -> {:halt, err}
        end
      end
    )`
      : "{:ok, []}";
  const findBody =
    concreteRepos.length > 0
      ? `Enum.reduce_while(
      [
${concreteList}
      ],
      {:error, :not_found},
      fn repo, _acc ->
        case repo.find_by_id(id) do
          {:ok, record} -> {:halt, {:ok, record}}
          {:error, :not_found} -> {:cont, {:error, :not_found}}
        end
      end
    )`
      : "{:error, :not_found}";

  // A TPC base has NO schema module (no table), so there's no `${upperFirst(base.name)}.t()`
  // type to reference — the reader's specs use the union of the concrete structs
  // (`struct()`), which every concrete repository returns.
  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc "Read-only polymorphic reader for the abstract ${upperFirst(base.name)} hierarchy (TPC / ownTable) — delegates to the concrete repositories."

  @spec list() :: {:ok, [struct()]} | {:error, term()}
  def list do
    ${listBody}
  end

  @spec find_by_id(binary()) :: {:ok, struct()} | {:error, :not_found}
  def find_by_id(id) when is_binary(id) do
    ${findBody}
  end
end
`;
}
