// ---------------------------------------------------------------------------
// First-boot database seeding for the vanilla Phoenix backend
// (database-seeding.md) — M-T6.37.
//
// `priv/repo/seeds.exs` was a LAYOUT SLOT with no emitter behind it
// (`adapters/by-feature-layout.ts` → "seeds"), so every `seed` block on
// `platform: elixir` was silently dropped: the project compiled green and the
// tables started empty while node/.NET/java/python all seeded at boot.  This
// module is the missing emitter.
//
// Per D-SEED-PATH the default path is **through the domain create**: each row
// becomes `<Agg>Repository.insert(%{…})`, which builds the aggregate's
// `base_changeset` — so its invariants (`validate_number`, `validate_format`,
// the emitted invariant validators) run and a bad seed fails at boot rather
// than writing a corrupt row.  The REPOSITORY seam, not the context façade, is
// deliberate and matches java's `<Agg>Repository.save(<Agg>.create(…))`: the
// context's `create_<agg>` may carry a `requires` authorization gate, and a
// first-boot seeder has no request principal to satisfy it.
//
// Per D-SEED-IDEMPOTENCY a `__loom_seed` marker table holds one row per applied
// dataset (ship-once); `default` always runs, other datasets opt in via the
// `LOOM_SEED` env var (comma-separated).
//
// `raw` rows bypass the domain and emit the shared cross-backend INSERT via
// `renderSeedRowInsert` — SCHEMA-QUALIFIED, because Phoenix aggregates live in
// per-context Postgres schemas (`@schema_prefix "catalog"` / the migration's
// `prefix:`), NOT on the connection's search_path.  That is the #2517 qualifier
// bug, already fixed on node/.NET; an unqualified INSERT here would die with
// `42P01 relation "parts" does not exist`.
// ---------------------------------------------------------------------------

import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  SeedRowIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type Entry, groupByDataset, usedAggregates } from "../../_persistence/seed-datasets.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { renderExpr } from "../render-expr.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { isAbstractBase } from "./inheritance-emit.js";

/** An Elixir double-quoted string literal for arbitrary emitted SQL.  JSON's
 *  escape rules are a subset of Elixir's — plus `#{`, which Elixir would treat
 *  as INTERPOLATION, so a `.ddd`-sourced value containing it must not be able
 *  to reach the compiler as code. */
function exStr(s: string): string {
  return JSON.stringify(s).replace(/#\{/g, "\\#{");
}

/** Migration schema for an aggregate — qualifies the `raw` INSERT. */
export type SeedSchemaFor = (aggregateName: string) => string | undefined;

/** One emitted context seeder: the module alias the boot path calls. */
export interface VanillaSeedModule {
  /** Fully-qualified module, e.g. `D.Catalog.Seeds`. */
  module: string;
}

/**
 * Emit `lib/<app>/<ctx_snake>/seeds.ex` for a context that declares any
 * `seed` block.  Returns the module reference the Application boot path (and
 * `priv/repo/seeds.exs`) invokes, or `null` when the context seeds nothing.
 */
export function emitVanillaSeeds(
  appName: string,
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  schemaFor: SeedSchemaFor = () => undefined,
): VanillaSeedModule | null {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return null;

  const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
  // Only a plain state-persisted, non-abstract aggregate has a repository
  // `insert/1`: an abstract inheritance base is read-only, and an
  // event-sourced one is created by appending its creation EVENT.
  const seedableAggs = ctx.aggregates.filter((a) => !isAbstractBase(a) && !isEventSourced(a));
  const seedable = new Set(seedableAggs.map((a) => a.name));
  const aggByName = new Map<string, EnrichedAggregateIR>(seedableAggs.map((a) => [a.name, a]));

  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  for (const ds of datasets) {
    // A `raw` row needs no repository, so it survives the seedable filter that
    // drops a domain row whose aggregate has no `insert/1` seam.
    const entries = ds.entries.filter((e) => e.raw || seedable.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(...renderDatasetFn(ds.name, entries, ctxModule, aggByName, schemaFor));
    callLines.push(`    seed_${snake(ds.name)}(requested)`);
  }
  if (callLines.length === 0) return null;
  // `usedAggregates` is the shared derivation of "which aggregates does the
  // DOMAIN path touch" — the aliases below, and nothing else.
  const aliases = usedAggregates(datasets, seedable).map(
    (a) => `  alias ${ctxModule}.${upperFirst(a)}Repository`,
  );

  const module = `${ctxModule}.Seeds`;
  out.set(
    `lib/${appName}/${snake(ctx.name)}/seeds.ex`,
    lines(
      `# Auto-generated.`,
      `defmodule ${module} do`,
      `  @moduledoc """`,
      `  First-boot seed data for the ${ctx.name} context (database-seeding.md).`,
      ``,
      `  Ship-once per dataset via the \`__loom_seed\` marker table`,
      `  (D-SEED-IDEMPOTENCY) — re-runs are no-ops.  \`default\` always runs;`,
      `  every other dataset opts in via the \`LOOM_SEED\` env var`,
      `  (comma-separated).  Domain rows go through the aggregate's changeset`,
      `  (D-SEED-PATH) so its invariants run; \`raw\` rows are direct,`,
      `  schema-qualified INSERTs.`,
      `  """`,
      `  alias ${appModule}.Repo`,
      ...aliases,
      ``,
      `  @doc false`,
      `  def child_spec(_opts) do`,
      `    %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient, type: :worker}`,
      `  end`,
      ``,
      `  @doc """`,
      `  Supervision-tree entry, started AFTER the Repo and BEFORE the Endpoint.`,
      ``,
      `  Returns \`:ignore\` — there is no process to supervise; the point is the`,
      `  ORDERING.  Seeding from a child slot means the rows are committed before`,
      `  the Endpoint accepts its first connection, so a client that reaches a`,
      `  freshly-booted node cannot observe the unseeded table (running it after`,
      `  \`Supervisor.start_link/2\` returns leaves exactly that window open — the`,
      `  Endpoint is already listening by then).  A rejected row raises here, so a`,
      `  bad seed fails the boot instead of half-populating the database.`,
      `  """`,
      `  def start_link do`,
      `    if seed_on_boot?(), do: run()`,
      `    :ignore`,
      `  end`,
      ``,
      `  # Only a node that actually SERVES seeds: \`mix phx.server\` sets`,
      `  # :phoenix/:serve_endpoints, a release sets \`server: true\``,
      `  # (config/prod.exs).  \`mix test\` sets neither, so the emitted ExUnit`,
      `  # suites keep the empty tables they assert against instead of racing a`,
      `  # seeder at application start.`,
      `  defp seed_on_boot? do`,
      `    Application.get_env(:phoenix, :serve_endpoints) ||`,
      `      Application.get_env(:${appName}, ${appModule}Web.Endpoint, [])[:server] || false`,
      `  end`,
      ``,
      `  @doc "Apply every enabled, not-yet-applied dataset.  Safe to call on every boot."`,
      `  def run do`,
      `    Repo.query!(`,
      `      ${exStr(
        `CREATE TABLE IF NOT EXISTS "__loom_seed" ("dataset" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
      )}`,
      `    )`,
      ``,
      `    requested =`,
      `      System.get_env("LOOM_SEED", "")`,
      `      |> String.split(",", trim: true)`,
      `      |> Enum.map(&String.trim/1)`,
      `      |> Enum.reject(&(&1 == ""))`,
      `      |> MapSet.new()`,
      ``,
      ...callLines,
      `    :ok`,
      `  end`,
      ``,
      ...fnBlocks,
      `  # \`default\` always runs; other datasets opt in via LOOM_SEED.`,
      `  defp dataset_enabled?(dataset, requested) do`,
      `    dataset == "default" or MapSet.member?(requested, dataset)`,
      `  end`,
      ``,
      `  defp already_seeded?(dataset) do`,
      `    %{rows: rows} =`,
      `      Repo.query!(${exStr(`SELECT 1 FROM "__loom_seed" WHERE "dataset" = $1`)}, [dataset])`,
      `    rows != []`,
      `  end`,
      ``,
      `  defp mark_seeded(dataset) do`,
      `    Repo.query!(${exStr(`INSERT INTO "__loom_seed" ("dataset") VALUES ($1)`)}, [dataset])`,
      `  end`,
      ``,
      `  # A seed row that the domain refuses (a violated invariant) is a BUILD-TIME`,
      `  # authoring error, not a runtime condition to swallow: raise so first boot`,
      `  # fails loudly instead of starting against a half-populated database.`,
      `  defp insert!(_dataset, _aggregate, {:ok, _record}), do: :ok`,
      ``,
      `  defp insert!(dataset, aggregate, {:error, reason}) do`,
      `    raise "seed dataset #{dataset}: #{aggregate} row rejected — #{inspect(reason)}"`,
      `  end`,
      `end`,
      ``,
    ),
  );
  return { module };
}

/** One `defp seed_<dataset>(requested)` clause. */
function renderDatasetFn(
  dataset: string,
  entries: Entry[],
  ctxModule: string,
  aggByName: Map<string, EnrichedAggregateIR>,
  schemaFor: SeedSchemaFor,
): string[] {
  const rowLines = entries.map((e) => {
    if (e.raw) {
      const sql = renderSeedRowInsert(e.row.aggregate, e.row.fields, schemaFor(e.row.aggregate));
      return `    Repo.query!(${exStr(sql)})`;
    }
    const agg = aggByName.get(e.row.aggregate);
    const attrs = renderAttrs(e.row, agg, ctxModule);
    return `    insert!(${JSON.stringify(dataset)}, ${JSON.stringify(e.row.aggregate)}, ${upperFirst(
      e.row.aggregate,
    )}Repository.insert(${attrs}))`;
  });
  return [
    `  defp seed_${snake(dataset)}(requested) do`,
    `    if dataset_enabled?(${JSON.stringify(dataset)}, requested) and`,
    `         not already_seeded?(${JSON.stringify(dataset)}) do`,
    ...rowLines.map((l) => `  ${l}`),
    `      mark_seeded(${JSON.stringify(dataset)})`,
    `    end`,
    ``,
    `    :ok`,
    `  end`,
    ``,
  ];
}

/** `%{field: <expr>, …}` attrs map for the repository `insert/1` changeset.
 *  ATOM keys throughout — `cast/3` requires one key type, and the emitted
 *  `__normalize_keys` passes atoms through untouched. */
function renderAttrs(
  row: SeedRowIR,
  agg: EnrichedAggregateIR | undefined,
  ctxModule: string,
): string {
  if (row.fields.length === 0) return "%{}";
  // Emit in the DECLARED create-input order, so the attrs map reads the same
  // way the other backends' create-input literals do regardless of the order
  // the row happened to spell its fields in.
  const rank = new Map(agg ? forCreateInput(agg.fields).map((f, i) => [f.name, i] as const) : []);
  const fields = [...row.fields].sort(
    (a, b) =>
      (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
  const pairs = fields.map((f) => `${snake(f.name)}: ${renderSeedValue(f.value, ctxModule)}`);
  return `%{${pairs.join(", ")}}`;
}

/** A seed literal in Elixir.  Everything lands in `cast/3`, which coerces the
 *  wire forms Ecto already understands (an ISO-8601 string → `:utc_datetime`,
 *  a numeric string → `:decimal`), so only the shared renderer is needed —
 *  its default (in-memory) context emits the declared-case enum ATOM
 *  (`:Free`), which is exactly what an `Ecto.Enum` column casts. */
function renderSeedValue(value: ExprIR, ctxModule: string): string {
  return renderExpr(value, { thisName: "record", contextModule: ctxModule });
}
