// First-boot database seeding for the Phoenix/Ash backend
// (database-seeding.md, Phase 3b).  Renders `priv/repo/seeds.exs` from the
// contexts' `SeedIR` lists.
//
// Per D-SEED-PATH the default path is **through the domain create action**:
// each row becomes `<Ctx>.create_<agg>!(%{ … })` (the Ash code interface on
// the context's `Ash.Domain`), so the resource's changeset/validations run.
// Field values reuse the shared `renderExpr`, so value objects render as
// named structs (`%<Ctx>.Money{amount: …, currency: …}`), enums as atoms
// (`:free`), and `now()` as `DateTime.utc_now()`.
//
// Per D-SEED-IDEMPOTENCY v1 is **ship-once per dataset**: a `__loom_seed`
// marker table (created via `Ecto.Adapters.SQL`) holds one row per applied
// dataset; a dataset whose marker is present is skipped.  `default` always
// runs; others opt in via `LOOM_SEED` (comma-separated).
//
// Not yet handled (later slices): the `raw` path (still routes through the
// create action) and `@handle` cross-row id refs.

import type { BoundedContextIR, ExprIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { renderSeedRowInsert } from "../sql-pg.js";
import { renderExpr } from "./render-expr.js";

const EMPTY_STUB = "# Auto-generated — empty seeds stub.\n";

interface SeedEntry {
  ctxModule: string;
  agg: string;
  raw: boolean;
  fields: { name: string; value: ExprIR }[];
}

/** True when any served context declares a non-empty `seed` block — drives
 *  the `priv/repo/seeds.exs` run in the `ecto.setup` mix alias. */
export function contextsHaveSeeds(contexts: BoundedContextIR[]): boolean {
  return contexts.some((c) =>
    (c.seeds ?? []).some((s) =>
      s.rows.some((r) => c.aggregates.some((a) => a.name === r.aggregate && !a.isAbstract)),
    ),
  );
}

export function renderSeedsExs(appModule: string, contexts: BoundedContextIR[]): string {
  const byDataset = new Map<string, SeedEntry[]>();
  const order: string[] = [];
  for (const ctx of contexts) {
    const ctxModule = `${appModule}.${upperFirst(ctx.name)}`;
    const seedable = new Set(ctx.aggregates.filter((a) => !a.isAbstract).map((a) => a.name));
    for (const seed of ctx.seeds ?? []) {
      for (const row of seed.rows) {
        if (!seedable.has(row.aggregate)) continue;
        let list = byDataset.get(seed.dataset);
        if (!list) {
          list = [];
          byDataset.set(seed.dataset, list);
          order.push(seed.dataset);
        }
        list.push({
          ctxModule,
          agg: row.aggregate,
          raw: seed.path === "raw",
          fields: row.fields,
        });
      }
    }
  }
  if (order.length === 0) return EMPTY_STUB;

  const blocks = order.map((dataset) => renderDatasetBlock(dataset, byDataset.get(dataset)!));

  return `# Auto-generated.  Do not edit by hand.
# First-boot seed data (database-seeding.md).  Ship-once per dataset via the
# __loom_seed marker (D-SEED-IDEMPOTENCY); re-runs are no-ops.  \`default\`
# always runs; other datasets opt in via LOOM_SEED (comma-separated).

repo = ${appModule}.Repo

Ecto.Adapters.SQL.query!(
  repo,
  ~s(CREATE TABLE IF NOT EXISTS "__loom_seed" ("dataset" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())),
  []
)

requested =
  (System.get_env("LOOM_SEED") || "")
  |> String.split(",", trim: true)
  |> Enum.map(&String.trim/1)
  |> MapSet.new()

dataset_enabled? = fn dataset -> dataset == "default" or MapSet.member?(requested, dataset) end

already_seeded? = fn dataset ->
  %{num_rows: n} =
    Ecto.Adapters.SQL.query!(repo, ~s(SELECT 1 FROM "__loom_seed" WHERE "dataset" = $1), [dataset])

  n > 0
end

mark_seeded = fn dataset ->
  Ecto.Adapters.SQL.query!(repo, ~s(INSERT INTO "__loom_seed" ("dataset") VALUES ($1)), [dataset])
end

${blocks.join("\n\n")}
`;
}

function renderDatasetBlock(dataset: string, entries: SeedEntry[]): string {
  const creates = entries.map((e) => `  ${renderCreate(e)}`);
  return [
    `if dataset_enabled?.(${elixirStr(dataset)}) and not already_seeded?.(${elixirStr(dataset)}) do`,
    ...creates,
    `  mark_seeded.(${elixirStr(dataset)})`,
    "end",
  ].join("\n");
}

function renderCreate(e: SeedEntry): string {
  if (e.raw) {
    // raw path (D-SEED-XREF): direct INSERT with explicit id + FK columns,
    // executed through Ecto's raw-SQL channel.  Balanced parens make `~s(…)`
    // safe (same as the marker DDL above).
    return `Ecto.Adapters.SQL.query!(repo, ~s(${renderSeedRowInsert(e.agg, e.fields)}), [])`;
  }
  const ctx = { thisName: "record", contextModule: e.ctxModule };
  const fields = e.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ");
  return `${e.ctxModule}.create_${snake(e.agg)}!(%{${fields}})`;
}

function elixirStr(s: string): string {
  return JSON.stringify(s);
}
