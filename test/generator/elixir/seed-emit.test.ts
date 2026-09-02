// ---------------------------------------------------------------------------
// Elixir / Phoenix (vanilla Ecto) backend — first-boot seeding (M-T6.37,
// database-seeding.md).
//
// `priv/repo/seeds.exs` was a LAYOUT SLOT with no emitter behind it, so every
// `seed` block on `platform: elixir` was silently dropped: the project compiled
// green and the tables started empty while node/.NET/java/python all seeded at
// boot.  These tests pin the four things that gap cost:
//
//   1. a `<Ctx>.Seeds` module EXISTS and carries a row per declared seed row;
//   2. domain rows go through the aggregate's repository `insert/1`
//      (D-SEED-PATH — the changeset runs the invariants), NOT a raw INSERT;
//   3. `raw` rows ARE a direct INSERT and it is SCHEMA-QUALIFIED (the #2517
//      qualifier bug — Phoenix tables live in a per-context Postgres schema,
//      not on the search_path);
//   4. it is actually INVOKED at boot (the gap's real shape: an emitted-but-
//      uncalled seeder is exactly as silent as no seeder at all).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SEEDED = `system SeedSys {
  subdomain D {
    context Catalog {
      enum Tier { Free, Pro }
      aggregate Part with crudish {
        name: string
        size: int
        tier: Tier
        invariant size >= 0
      }
      repository Parts for Part { }
      seed default {
        Part { name: "Alpha", size: 1, tier: Free }
        Part { name: "Beta", size: 2, tier: Pro }
      }
      seed demo { Part { name: "Gamma", size: 3, tier: Pro } }
      seed wired raw {
        Part { id: "33333333-3333-3333-3333-333333333333", name: "Anchor", size: 4, tier: Free }
      }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Catalog, kind: state, use: primary }
  deployable api1 { platform: elixir, contexts: [Catalog], dataSources: [st], serves: A, port: 8081 }
}`;

// The same system with every `seed` block removed — the strict-additivity
// control: a seedless project must emit NOTHING new.  Spelled out rather than
// regex-stripped from SEEDED, so the control can't silently stop stripping.
const UNSEEDED = `system UnseededSys {
  subdomain D {
    context Catalog {
      enum Tier { Free, Pro }
      aggregate Part with crudish {
        name: string
        size: int
        tier: Tier
        invariant size >= 0
      }
      repository Parts for Part { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Catalog, kind: state, use: primary }
  deployable api1 { platform: elixir, contexts: [Catalog], dataSources: [st], serves: A, port: 8081 }
}`;

const SEEDS = "api1/lib/api1/catalog/seeds.ex";
const APPLICATION = "api1/lib/api1/application.ex";
const SEEDS_EXS = "api1/priv/repo/seeds.exs";

describe("elixir/vanilla generator — first-boot seeding", () => {
  it("emits a <Ctx>.Seeds module with one call per declared seed row", async () => {
    const files = await generateSystemFiles(SEEDED);
    const seeds = files.get(SEEDS);
    expect(seeds).toBeDefined();
    expect(seeds).toContain("defmodule Api1.Catalog.Seeds do");
    // One `defp seed_<dataset>` per declared dataset, all called from `run/0`.
    for (const ds of ["default", "demo", "wired"]) {
      expect(seeds).toContain(`defp seed_${ds}(requested) do`);
      expect(seeds).toContain(`    seed_${ds}(requested)`);
    }
  });

  it("routes DOMAIN rows through the repository insert so invariants run (D-SEED-PATH)", async () => {
    const seeds = (await generateSystemFiles(SEEDED)).get(SEEDS)!;
    // `PartRepository.insert/1` builds `PartChangeset.base_changeset/2`, which
    // carries the aggregate's `invariant size >= 0` as a `validate_number`.  A
    // direct INSERT for these rows would write past the domain.
    expect(seeds).toContain(`PartRepository.insert(%{name: "Alpha", size: 1, tier: :Free})`);
    expect(seeds).toContain(`PartRepository.insert(%{name: "Beta", size: 2, tier: :Pro})`);
    expect(seeds).toContain(`PartRepository.insert(%{name: "Gamma", size: 3, tier: :Pro})`);
    // Declared enum casing survives as the Ecto.Enum atom, not a snake_cased
    // or lower-cased string.
    expect(seeds).not.toContain(":free");
    // The repository seam is aliased, so `insert/1` resolves.
    expect(seeds).toContain("alias Api1.Catalog.PartRepository");
  });

  it("emits `raw` rows as a SCHEMA-QUALIFIED direct INSERT (#2517)", async () => {
    const seeds = (await generateSystemFiles(SEEDED)).get(SEEDS)!;
    // Phoenix aggregates carry `@schema_prefix "catalog"` and their migration a
    // matching `prefix:`; the connection's search_path never sees that schema,
    // so an unqualified INSERT dies with 42P01 at first boot.
    expect(seeds).toContain(`INSERT INTO \\"catalog\\".\\"parts\\"`);
    expect(seeds).toContain("'33333333-3333-3333-3333-333333333333'");
    // …and the raw row does NOT take the domain path.
    expect(seeds).not.toContain(`PartRepository.insert(%{id:`);
  });

  it("ships once per dataset and gates the opt-in ones on LOOM_SEED", async () => {
    const seeds = (await generateSystemFiles(SEEDED)).get(SEEDS)!;
    // D-SEED-IDEMPOTENCY: the marker table + the two guards on every dataset.
    expect(seeds).toContain(`CREATE TABLE IF NOT EXISTS \\"__loom_seed\\"`);
    expect(seeds).toContain(`not already_seeded?("default")`);
    expect(seeds).toContain(`mark_seeded("default")`);
    // `default` always runs; everything else opts in via LOOM_SEED.
    expect(seeds).toContain(`System.get_env("LOOM_SEED", "")`);
    expect(seeds).toContain(`dataset == "default" or MapSet.member?(requested, dataset)`);
  });

  it("INVOKES the seeder at boot — after the Repo, BEFORE the Endpoint", async () => {
    const files = await generateSystemFiles(SEEDED);
    const app = files.get(APPLICATION)!;
    // The gap's real shape: an emitted-but-uncalled seeder is as silent as none.
    expect(app).toContain("Api1.Catalog.Seeds");
    // ORDERING is the assertion, not mere presence.  The seeder queries the
    // Repo, so it must start after it; and it must finish before the Endpoint
    // accepts its first connection, or a client reaching a freshly-booted node
    // observes the UNSEEDED table (a real window, measured on a live boot —
    // `Supervisor.start_link/2` has already started the Endpoint by the time it
    // returns, so seeding from there is too late).
    const repo = app.indexOf("      Api1.Repo,");
    const seeds = app.indexOf("      Api1.Catalog.Seeds,");
    const endpoint = app.indexOf("      Api1Web.Endpoint");
    expect(repo).toBeGreaterThan(-1);
    expect(seeds).toBeGreaterThan(repo);
    expect(endpoint).toBeGreaterThan(seeds);
    // …and it must NOT also run after start_link (that would double-seed the
    // marker read and reopen the window this placement closes).
    expect(app).not.toContain("Seeds.run()");

    // `mix test` sets neither :serve_endpoints nor `server: true`, so the
    // emitted ExUnit suites keep the empty tables they assert against.
    const seedsMod = files.get(SEEDS)!;
    expect(seedsMod).toContain("Application.get_env(:phoenix, :serve_endpoints)");
    expect(seedsMod).toContain("Application.get_env(:api1, Api1Web.Endpoint, [])[:server]");
    // A child slot that never becomes a process — `:ignore` is what makes the
    // supervisor move on to the Endpoint instead of supervising a dead worker.
    expect(seedsMod).toContain("def start_link do");
    expect(seedsMod).toContain("    :ignore");
    // The canonical `mix run priv/repo/seeds.exs` entry calls the SAME module,
    // so a hand-run and a boot cannot disagree.
    expect(files.get(SEEDS_EXS)).toContain("Api1.Catalog.Seeds.run()");
  });

  // G2667-D6 — each dataset is ONE transaction.  The seeder committed per row
  // and wrote the `__loom_seed` marker LAST, so a crash mid-dataset left rows
  // behind with no marker and the next boot re-seeded them: duplicates from an
  // ordinary restart.  Python's seeder is one commit; elixir now matches.
  it("commits each dataset's rows and its applied-marker in ONE transaction", async () => {
    const files = await generateSystemFiles(SEEDED);
    const mod = files.get(SEEDS) as string;
    expect(mod).toBeTruthy();
    for (const [fn, dataset] of [
      ["seed_default", "default"],
      ["seed_demo", "demo"],
      ["seed_wired", "wired"],
    ] as const) {
      const body = mod.slice(mod.indexOf(`defp ${fn}(`));
      const end = body.indexOf("\n  end\n");
      const clause = body.slice(0, end === -1 ? undefined : end);
      expect(clause, `${fn} opens a transaction`).toContain("Repo.transaction(fn ->");
      // The marker is INSIDE the transaction — that is the whole point: rows
      // and marker commit together or not at all.
      const txStart = clause.indexOf("Repo.transaction(fn ->");
      const txEnd = clause.indexOf("end)", txStart);
      expect(txEnd, `${fn} closes its transaction`).toBeGreaterThan(txStart);
      const tx = clause.slice(txStart, txEnd);
      expect(tx, `${fn} marks '${dataset}' seeded inside the transaction`).toContain(
        `mark_seeded("${dataset}")`,
      );
      // Every write of this dataset is inside it too — a row left outside would
      // commit on its own and reintroduce the partial-seed window.
      const writes = (clause.match(/insert!\(|Repo\.query!\(/g) ?? []).length;
      const writesInTx = (tx.match(/insert!\(|Repo\.query!\(/g) ?? []).length;
      expect(writesInTx, `${fn}: every write inside the transaction`).toBe(writes);
    }
  });

  it("emits nothing for a seedless system (strict additivity)", async () => {
    const files = await generateSystemFiles(UNSEEDED);
    // Guard the control fixture itself — a regex that stopped matching would
    // make this assertion pass against a file that still declares seeds.
    expect(UNSEEDED).not.toContain("seed ");
    expect(files.has(SEEDS)).toBe(false);
    expect(files.has(SEEDS_EXS)).toBe(false);
    expect(files.get(APPLICATION)).not.toContain("Seeds");
  });
});
