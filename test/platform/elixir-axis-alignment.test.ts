// Realization-axes alignment (docs/old/plans/realization-axes-alignment.md) — the
// elixir backend exposes the plain Ecto/Phoenix data layer (`ecto`) on the
// persistence axis and the `layered` pipeline style (plain Phoenix's
// controller → context → repository shape, DSL `serviceLayer`) on the
// application axis.  The Ash foundation was removed, so `ashPostgres` / `ash`
// are no longer on the menu.

import { describe, expect, it } from "vitest";
import {
  adaptersFor,
  availableAdapterNames,
  resolveStyle,
} from "../../src/platform/resolve-adapters.js";

describe("elixir realization-axes alignment", () => {
  it("persistence axis lists ecto only (no ash data layer)", () => {
    const names = availableAdapterNames("elixir", "persistence");
    expect(names).toContain("ecto");
    expect(names).not.toContain("ashPostgres");
    expect(names).not.toContain("ashSqlite");
  });

  it("application/style axis lists layered only (vanilla is a foundation, not a style)", () => {
    const names = availableAdapterNames("elixir", "style");
    expect(names).toContain("layered");
    expect(names).not.toContain("ash");
    expect(names).not.toContain("vanilla");
  });

  it("resolves the ecto persistence adapter (DB-agnostic: name is the library, not per-DB)", () => {
    const ecto = adaptersFor("elixir")!.persistence.ecto;
    expect(ecto.name).toBe("ecto");
    // Per the naming principle (§3.1): Ecto is the data-access library; the DB
    // rides `storage`.  It supports the state strategy on postgres.
    expect(ecto.supports("postgres", "state", "state")).toBe(true);
  });

  it("ecto hosts eventLog too — it's the elixir backend's ES adapter (DEBT-20)", () => {
    const ecto = adaptersFor("elixir")!.persistence.ecto;
    expect(ecto.name).toBe("ecto");
    expect(ecto.supportedStrategies).toContain("eventLog");
    // The elixir backend emits the full event-sourced store; ecto is its
    // persistence adapter, so it must advertise `eventLog` on postgres.
    expect(ecto.supports("postgres", "eventLog", "eventLog")).toBe(true);
  });

  it("resolves the layered (plain-Phoenix) style adapter; its DI block is empty", () => {
    const layered = resolveStyle("elixir", "layered");
    expect(layered.name).toBe("layered");
    // Plain Phoenix needs no domain registration.
    expect(layered.emitDi({ contexts: [], deployable: { name: "api" } } as never)).toEqual([]);
  });
});
