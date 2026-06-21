// Realization-axes alignment (docs/plans/realization-axes-alignment.md) — the
// elixir backend exposes BOTH data layers on the persistence axis
// (`ashPostgres` for the Ash foundation, `ecto` for the vanilla foundation)
// and BOTH real pipeline styles on the application axis (`ash`, `layered` —
// the latter being plain Phoenix's controller → context → repository shape,
// DSL `serviceLayer`), so Ecto is a
// first-class adapter exactly like `ashPostgres` — symmetric with dotnet
// (`efcore`/`dapper`) and node (`drizzle`/`mikroorm`).

import { describe, expect, it } from "vitest";
import {
  availableAdapterNames,
  resolvePersistence,
  resolveStyle,
} from "../../src/platform/resolve-adapters.js";

describe("elixir realization-axes alignment", () => {
  it("persistence axis lists ashPostgres AND ecto (both real, no stubs)", () => {
    const names = availableAdapterNames("elixir", "persistence");
    expect(names).toContain("ashPostgres");
    expect(names).toContain("ecto");
  });

  it("application/style axis lists ash AND layered (vanilla is a foundation, not a style)", () => {
    const names = availableAdapterNames("elixir", "style");
    expect(names).toContain("ash");
    expect(names).toContain("layered");
    expect(names).not.toContain("vanilla");
  });

  it("resolves the ecto persistence adapter (DB-agnostic: name is the library, not per-DB)", () => {
    const ecto = resolvePersistence("elixir", "ecto");
    expect(ecto.name).toBe("ecto");
    // Per the naming principle (§3.1): Ecto is the data-access library; the DB
    // rides `storage`.  It supports the state strategy on postgres.
    expect(ecto.supports("postgres", "state", "state")).toBe(true);
  });

  it("ecto hosts eventLog too — it's the vanilla foundation's ES adapter (DEBT-20)", () => {
    const ecto = resolvePersistence("elixir", "ecto", "eventLog");
    expect(ecto.name).toBe("ecto");
    expect(ecto.supportedStrategies).toContain("eventLog");
    // The vanilla foundation emits the full event-sourced store; ecto is its
    // persistence adapter, so it must advertise `eventLog` on postgres.
    expect(ecto.supports("postgres", "eventLog", "eventLog")).toBe(true);
    // ashPostgres (Ash) stays state-only — Ash has no ES path.
    expect(
      resolvePersistence("elixir", "ashPostgres").supports("postgres", "eventLog", "eventLog"),
    ).toBe(false);
  });

  it("resolves the layered (plain-Phoenix) style adapter; its DI block is empty (no ash_domains)", () => {
    // `foundation: vanilla` selects the `layered` style (DSL `serviceLayer`),
    // NOT a style named after the foundation.
    const layered = resolveStyle("elixir", "layered");
    expect(layered.name).toBe("layered");
    // Plain Phoenix needs no domain registration — contrast ash's ash_domains.
    expect(layered.emitDi({ contexts: [], deployable: { name: "api" } } as never)).toEqual([]);
  });

  it("ashPostgres stays a distinct, postgres-only adapter (per-DB Ash data layer)", () => {
    const ash = resolvePersistence("elixir", "ashPostgres");
    expect(ash.name).toBe("ashPostgres");
    expect(ash.supports("postgres", "state", "state")).toBe(true);
  });
});
