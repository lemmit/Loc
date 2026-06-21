// Tests for the per-app `<App>.Types` module — the shared Elixir
// type vocabulary (`id()`, `timestamp()`, `result(t)`,
// `result_list(t)`) referenced by every emitter that writes a
// typespec via `renderTypespec`.
//
// Pins both the module text itself and the orchestrator wiring (the
// module lands at `lib/<app_snake>/types.ex` and the typesModule
// reference flows through event / value-object emission).

import { describe, expect, it } from "vitest";
import { renderTypesModule } from "../../../src/generator/elixir/types-module-emit.js";

describe("renderTypesModule", () => {
  const module = renderTypesModule("MyApp.Types");

  it("declares the `defmodule <App>.Types` block", () => {
    expect(module).toMatch(/defmodule MyApp\.Types do/);
  });
  it("declares @type id :: String.t() — the canonical Ash id shape", () => {
    expect(module).toMatch(/@type id :: String\.t\(\)/);
  });
  it("declares @type timestamp :: DateTime.t()", () => {
    expect(module).toMatch(/@type timestamp :: DateTime\.t\(\)/);
  });
  it("declares the parameterised @type result(t) :: {:ok, t} | {:error, Ash.Error.t()}", () => {
    expect(module).toMatch(/@type result\(t\) :: \{:ok, t\} \| \{:error, Ash\.Error\.t\(\)\}/);
  });
  it("declares @type result_list(t) :: {:ok, [t]} | {:error, Ash.Error.t()}", () => {
    expect(module).toMatch(
      /@type result_list\(t\) :: \{:ok, \[t\]\} \| \{:error, Ash\.Error\.t\(\)\}/,
    );
  });
  it("carries a @moduledoc pointing readers at the vocabulary discipline", () => {
    expect(module).toMatch(/@moduledoc/);
    expect(module).toMatch(/Shared type vocabulary/);
  });
  it("starts with the auto-generated banner so it's recognisable in the tree", () => {
    expect(module).toMatch(/^# Auto-generated\./);
  });
  it("scales to a different app module prefix", () => {
    const acme = renderTypesModule("Acme.Types");
    expect(acme).toMatch(/defmodule Acme\.Types do/);
    expect(acme).not.toMatch(/MyApp/);
  });
});
