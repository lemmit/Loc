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
  defaultsFor,
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
    // Per the naming principle (§3.1): Ecto is the data-access library; the DB
    // rides `storage`, so the adapter is `ecto` — never `ectoPostgres`.
    expect(ecto.name).toBe("ecto");
    expect(Object.keys(adaptersFor("elixir")!.persistence)).not.toContain("ectoPostgres");
  });

  it("ecto is elixir's eventLog default and a REAL adapter (DEBT-20)", () => {
    // The elixir backend emits the full event-sourced store, so an
    // event-sourced aggregate with no explicit `persistence:` must default to
    // an adapter that actually emits it.  Asserted against the DEFAULTS +
    // real-adapter menu, both of which the validator and lowering read.
    //
    // The old form asserted `ecto.supportedStrategies` contained "eventLog"
    // and that `ecto.supports("postgres","eventLog","eventLog")` returned
    // true.  Both read declarations on the adapter that nothing else in the
    // toolchain consumed — they restated the fixture rather than testing it.
    expect(defaultsFor("elixir")!.persistence.eventLog).toBe("ecto");
    expect(availableAdapterNames("elixir", "persistence")).toContain("ecto");
  });

  it("resolves the layered (plain-Phoenix) style adapter; its DI block is empty", () => {
    const layered = resolveStyle("elixir", "layered");
    expect(layered.name).toBe("layered");
    // Plain Phoenix needs no domain registration.
    expect(layered.emitDi({ contexts: [], deployable: { name: "api" } } as never)).toEqual([]);
  });
});
