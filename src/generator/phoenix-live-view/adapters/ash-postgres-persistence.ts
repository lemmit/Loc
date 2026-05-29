// ---------------------------------------------------------------------------
// ashPostgres — the real PersistenceAdapter for the phoenixLiveView
// platform.  Wraps the existing Phoenix/Ash emit fns (`domain-emit.ts` +
// `migrations-emit.ts`) so produced source stays byte-identical with
// today's `generatePhoenixLiveView` output.
//
// Parallel of the dotnet `efcorePersistenceAdapter` (F5a) and hono
// `drizzlePersistenceAdapter` (F6a).  Ash is unusual: the Resource
// concept fuses schema + repository + actions in one module, so
// `emitRepository(agg)` returns the full Ash.Resource definition (no
// separate "schema" emit).  Today the orchestrator
// (`src/generator/phoenix-live-view/index.ts`) calls
// `emitAggregateResources` per-context — this adapter is the forward
// seam for the F7d-equivalent rewire.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  DataSourceIR,
  EnrichedBoundedContextIR,
  StorageIR,
} from "../../../ir/types/loom-ir.js";
import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";
import { emitAggregateResources } from "../domain-emit.js";
import { emitMigrations as emitAshMigrations } from "../migrations-emit.js";

/** Phoenix slugs the deployable name into a snake-case app identifier
 *  (`storefront` → `storefront`, `MyApp` → `my_app`).  Mirrors
 *  `toSnakeApp` in the phoenix orchestrator. */
function toSnakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

/** Snake-case → Elixir module-name prefix (`my_app` → `MyApp`). */
function toModulePrefix(snakeName: string): string {
  return snakeName
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

function appNameOf(ctx: EmitCtx): string {
  return toSnakeApp(ctx.deployable.name);
}

function appModuleOf(ctx: EmitCtx): string {
  return toModulePrefix(appNameOf(ctx));
}

function contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

const splitLines = (s: string): Lines => s.split("\n");

export const ashPostgresPersistenceAdapter: PersistenceAdapter = {
  name: "ashPostgres",
  supportedStrategies: ["state"],

  supports(storageType, kind, persistenceStrategy) {
    return (
      persistenceStrategy === "state" &&
      storageType === "postgres" &&
      ["state", "snapshot", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    // The Ash + ash_postgres + supporting dep block from `mix.exs`.
    // The full `deps` list in `renderMixExs` includes phoenix /
    // ecto / bandit / open_api_spex too; those belong to the
    // framework / style adapters.  This adapter contributes only
    // the persistence-specific lines (the Ash family + the
    // resource-generator's compile-time optional deps that AshPostgres
    // references).
    return [
      `{:ash, "~> 3.24"},`,
      `{:ash_postgres, "~> 2.0"},`,
      `{:ash_phoenix, "~> 2.0"},`,
      `# ash_postgres' ResourceGenerator references Igniter.Inflex + Owl.IO at`,
      `# compile time.  Declared with runtime: false so they resolve without`,
      `# pulling into the application start sequence.`,
      `{:igniter, "~> 0.5", runtime: false},`,
      `{:owl, "~> 0.11", runtime: false},`,
    ];
  },

  emitConnectionSetup(_physicalStores: readonly StorageIR[], ctx: EmitCtx): Lines {
    // The `<App>.Repo` module — Phoenix wires the Ecto/AshPostgres
    // connection via Application children, with this Repo module as
    // the unit Ash queries against.  Mirrors `renderRepo`'s output
    // inline (the function is unexported in the orchestrator today).
    const appName = appNameOf(ctx);
    const appModule = appModuleOf(ctx);
    return [
      `# Auto-generated.`,
      `defmodule ${appModule}.Repo do`,
      `  use AshPostgres.Repo, otp_app: :${appName}`,
      ``,
      `  def installed_extensions do`,
      `    # \`ash-functions\` is required by Ash 3.x for fragment-style`,
      `    # validations (e.g. unique_constraint comparisons).  AshPostgres`,
      `    # ships the extension SQL — listing it here is enough for`,
      `    # \`mix ash.setup\` to install it.`,
      `    ["ash-functions", "uuid-ossp", "citext"]`,
      `  end`,
      ``,
      `  # AshPostgres 2.x requires a min_pg_version/0 callback so it can`,
      `  # gate extension features per Postgres version.  Targeting 15 — the`,
      `  # oldest still-supported community release at the generator's`,
      `  # current cutoff.`,
      `  def min_pg_version do`,
      `    %Version{major: 15, minor: 0, patch: 0}`,
      `  end`,
      `end`,
    ];
  },

  emitRepository(agg: AggregateIR, _logical: DataSourceIR, ctx: EmitCtx): Lines {
    // For Ash, the "repository" is the Resource module itself — it
    // fuses schema (attributes), repository (actions / queries), and
    // domain registration in one .ex file.  Today
    // `emitAggregateResources` walks every aggregate in a context;
    // we filter to the single aggregate so the per-agg adapter
    // signature holds.  Logical config (schema / tablePrefix) flows
    // through `_logical` for the AshPostgres `postgres.schema` /
    // `postgres.table_prefix` future; today the existing fn ignores
    // it.
    const owningCtx = contextOf(ctx, agg.name);
    if (!owningCtx) return [];
    const appName = appNameOf(ctx);
    const appModule = appModuleOf(ctx);
    const generated = emitAggregateResources(owningCtx, appModule, appName);
    // Collect every file the resource emitter produced for THIS
    // aggregate (root + part resources).  Same shape every other
    // adapter uses to flatten multi-file output into a single
    // `Lines` stream (`// ---- <path> ----` markers).
    const out: string[] = [];
    for (const [path, content] of [...generated.entries()].sort()) {
      // Filter to the aggregate's own resource files.  The path
      // shape is `lib/<app>/<ctx_snake>/<agg_snake>.ex` and
      // `.../<part_snake>.ex` — match on the dirname under the
      // context.
      const aggSnake = toSnakeApp(agg.name);
      const partSnakes = agg.parts.map((p) => toSnakeApp(p.name));
      const baseName = path.split("/").pop()!.replace(/\.ex$/, "");
      if (baseName !== aggSnake && !partSnakes.includes(baseName)) continue;
      out.push(`# ---- ${path} ----`);
      out.push(...content.split("\n"));
      out.push("");
    }
    return out;
  },

  emitMigrations(
    _aggs: readonly AggregateIR[],
    _physicalStores: readonly StorageIR[],
    ctx: EmitCtx,
  ): Lines | null {
    // Per-deployable migration emission — `emitMigrations` (renamed
    // local import) writes into a passed Map.  Mirrors the dotnet
    // efcore + hono drizzle adapter pattern: flatten the multi-file
    // output into a single Lines stream.
    if (!ctx.migrations || ctx.migrations.length === 0) return null;
    const appName = appNameOf(ctx);
    const appModule = appModuleOf(ctx);
    const collected = new Map<string, string>();
    emitAshMigrations(appName, ctx.migrations, appModule, collected);
    const out: string[] = [];
    for (const [path, content] of [...collected.entries()].sort()) {
      out.push(`# ---- ${path} ----`);
      out.push(...content.split("\n"));
      out.push("");
    }
    return out;
  },

  emitOutbox(_physical: StorageIR, _aggs: readonly AggregateIR[], _ctx: EmitCtx): Lines | null {
    // Ash outbox emission deferred — same posture as the dotnet +
    // hono adapters.  Eventually we'll lean on AshOban / AshEvents
    // for transactional dispatch; for now the validator catches
    // `publish: integration | both` aggregates without a backing
    // store.
    return null;
  },
};

/** Exposes the toSnakeApp helper for tests + future adapters that
 *  need to derive the same naming the orchestrator does. */
export { toModulePrefix, toSnakeApp };
