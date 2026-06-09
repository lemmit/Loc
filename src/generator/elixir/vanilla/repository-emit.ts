// ---------------------------------------------------------------------------
// Vanilla Repository emit — per-aggregate
// `lib/<app>/<ctx>/<agg>_repository.ex`.  Slice 1 of
// vanilla-foundation-tdd-plan.md.
//
// Plain Ecto.Repo queries returning `{:ok, _} | {:error, _}` results.
// No Ash code interface.  Read path only at Slice 1; create/update/
// destroy lands in Slice 2 (alongside the Changeset module).
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";

export function emitVanillaRepositories(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxModule = upperFirst(ctx.name);
  for (const agg of ctx.aggregates) {
    const aggSnake = snake(agg.name);
    const ctxSnake = snake(ctx.name);
    const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_repository.ex`,
      renderRepository(appModule, ctxModule, agg),
    );
  }
}

function renderRepository(appModule: string, ctxModule: string, agg: AggregateIR): string {
  const aggModule = `${appModule}.${ctxModule}.${upperFirst(agg.name)}`;
  const repoMod = `${aggModule}Repository`;

  return `# Auto-generated.
defmodule ${repoMod} do
  @moduledoc false
  import Ecto.Query
  alias ${appModule}.Repo
  alias ${aggModule}
  alias ${aggModule}Changeset

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
end
`;
}
