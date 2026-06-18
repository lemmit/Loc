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
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { combineWhere, vanillaCapabilityFilter } from "./capability-filter.js";
import { isEventSourced } from "./eventsourced-emit.js";

export function emitVanillaRepositories(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
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
      renderRepository(appModule, ctxModule, agg, repo),
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
): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;
  const contextModule = `${appModule}.${ctxModule}`;

  const finds = customFindsOf(repo);
  const cap = vanillaCapabilityFilter(agg, contextModule);
  const findFns = finds.map((f) => renderFindFn(f, aggModule, contextModule, cap));
  const findBlock = findFns.length > 0 ? `\n\n${findFns.join("\n\n")}\n` : "";
  // A `filter <expr>` capability (`contextFilters`) AND-s into every root read
  // (soft-delete et al.).  Plain Ecto has no global filter, so `cap` is conjoined
  // into `list/0`, `find_by_id/1` (below), and each custom find (above).
  // `import Ecto.Query` is required for `from(...)` — needed when there's a
  // custom find OR a capability filter (which turns `list`/`find_by_id` into
  // `from(...)` reads).  Omit it otherwise to keep plain repositories
  // byte-identical to before.
  const ectoImport = finds.length > 0 || cap ? `\n  import Ecto.Query` : "";
  // `list/0`: bare `Repo.all(<Agg>)` unless a capability filter scopes it.
  const listBody = cap
    ? `from(record in ${aggModule}, where: ${cap}) |> Repo.all()`
    : `Repo.all(${aggModule})`;
  // `find_by_id/1`: `Repo.get` can't carry the capability `where`, so a scoped
  // read becomes a `from(... where: id and cap) |> Repo.one()` (a soft-deleted
  // / out-of-scope row then reads as `:not_found`, matching every other backend).
  const findByIdBody = cap
    ? `case Repo.one(from(record in ${aggModule}, where: record.id == ^id and (${cap}))) do`
    : `case Repo.get(${aggModule}, id) do`;

  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc false${ectoImport}
  alias ${appModule}.Repo

  @spec list() :: {:ok, [${aggModule}.t()]} | {:error, term()}
  def list do
    {:ok, ${listBody}}
  end

  @spec find_by_id(binary()) :: {:ok, ${aggModule}.t()} | {:error, :not_found}
  def find_by_id(id) when is_binary(id) do
    ${findByIdBody}
      nil -> {:error, :not_found}
      record -> {:ok, record}
    end
  end

  @spec insert(map()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs) when is_map(attrs) do
    ${aggModule}Changeset.base_changeset(attrs)
    |> Repo.insert()
  end

  @spec update(${aggModule}.t(), map()) :: {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t()}
  def update(%${aggModule}{} = record, attrs) when is_map(attrs) do
    record
    |> ${aggModule}Changeset.base_changeset(attrs)
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
  end${findBlock}
end
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
  aggModule: string,
  contextModule: string,
  cap: string | null,
): string {
  const fnName = snake(f.name);
  const argNames = f.params.map((p) => snake(p.name));
  const argList = argNames.join(", ");
  const single = isSingleReturn(f.returnType);

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    foundation: "vanilla",
    // Params bind via Ecto pin syntax (`^needle`) inside the `from
    // ... where: ...` macro.  See render-expr.ts:filterArgs.
    filterArgs: true,
  };

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

  const fetchCall = single ? `Repo.one(query)` : `Repo.all(query)`;
  const specTail = single
    ? `{:ok, ${aggModule}.t() | nil} | {:error, term()}`
    : `{:ok, [${aggModule}.t()]} | {:error, term()}`;
  const specHead = argNames.length > 0 ? argNames.map(() => "term()").join(", ") : "";
  const spec = `  @spec ${fnName}(${specHead}) :: ${specTail}`;
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
