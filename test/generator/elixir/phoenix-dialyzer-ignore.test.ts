// Tests for `.dialyzer_ignore.exs` template emission + the paired
// mix.exs `dialyzer:` config block.
//
// Per docs/proposals/cross-stack-static-analysis.md, this lands the
// `.dialyzer_ignore.exs` template as future-proofing for the Tier 4
// Dialyzer gate.  The file sits unused until Dialyxir is added as a
// dep; once it is, `mix dialyzer` picks up the ignore_warnings file
// automatically via the project config.

import { describe, expect, it } from "vitest";
import { renderDialyzerIgnoreExs } from "../../../src/generator/elixir/dialyzer-ignore-emit.js";
import { renderMixExs } from "../../../src/generator/elixir/shell/project.js";

describe("renderDialyzerIgnoreExs", () => {
  const ignore = renderDialyzerIgnoreExs("my_app");

  it("starts with the auto-generated banner", () => {
    expect(ignore).toMatch(/^# Auto-generated\./);
  });

  it("declares an Elixir list of (pattern, warning) tuples", () => {
    // The file is read as `Code.eval_file(".dialyzer_ignore.exs")` by
    // Dialyxir — must be a single expression that returns a list.
    expect(ignore).toMatch(/^\[/m);
    expect(ignore).toMatch(/\]\s*$/);
  });

  it("filters Ash framework internals", () => {
    expect(ignore).toMatch(/\{~r\/lib\\\/ash\\\/\.\*\/, :_\}/);
  });

  it("filters AshPostgres data-layer macros", () => {
    expect(ignore).toMatch(/\{~r\/lib\\\/ash_postgres\\\/\.\*\/, :_\}/);
  });

  it("filters AshPhoenix integration macros", () => {
    expect(ignore).toMatch(/\{~r\/lib\\\/ash_phoenix\\\/\.\*\/, :_\}/);
  });

  it("filters the per-app Phoenix.Router module (macro-heavy DSL)", () => {
    expect(ignore).toMatch(/\{"lib\/my_app_web\/router\.ex", :_\}/);
  });

  it("scales the router path to the app's snake-cased name", () => {
    const acme = renderDialyzerIgnoreExs("acme_inc");
    expect(acme).toMatch(/\{"lib\/acme_inc_web\/router\.ex", :_\}/);
    expect(acme).not.toMatch(/my_app/);
  });
});

describe("renderMixExs — dialyzer config block", () => {
  const mix = renderMixExs("my_app", "MyApp");

  it("adds a `dialyzer:` key to the project keyword list", () => {
    expect(mix).toMatch(/dialyzer: \[/);
  });

  it("points dialyzer at the .dialyzer_ignore.exs template", () => {
    expect(mix).toMatch(/ignore_warnings: "\.dialyzer_ignore\.exs"/);
  });

  it("pre-declares :mix + :ex_unit in plt_add_apps for Dialyxir compatibility", () => {
    expect(mix).toMatch(/plt_add_apps: \[:mix, :ex_unit\]/);
  });

  it("keeps the deps list and aliases block unchanged (no regression on the existing config)", () => {
    // Spot-check a couple of pre-existing entries to catch any
    // accidental edit to the surrounding mix.exs structure.
    expect(mix).toMatch(/\{:ash, "~> 3\.24"\}/);
    expect(mix).toMatch(/\{:phoenix, "~> 1\.8"\}/);
    expect(mix).toMatch(/setup: \["deps\.get", "ash\.setup"\]/);
  });

  it("declares dialyxir as a dev/test-only dep so `mix dialyzer` is available in CI", () => {
    // Dialyxir wraps OTP Dialyzer for the `mix dialyzer` task.  Skipped
    // by `mix deps.get --only prod` (used in the Docker build), so it
    // never lands in the release image; CI's phoenix-dialyzer workflow
    // runs `mix deps.get` without --only to pull it.
    expect(mix).toMatch(/\{:dialyxir, "~> 1\.4", only: \[:dev, :test\], runtime: false\}/);
  });
});
