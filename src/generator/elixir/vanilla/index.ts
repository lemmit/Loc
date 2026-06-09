// ---------------------------------------------------------------------------
// Vanilla Elixir orchestrator — `foundation: vanilla` emit subtree.
//
// Plain Phoenix + Ecto (no Ash.Resource, no AshPhoenix.Form, no
// AshPostgres).  Sibling of the Ash path under `../`; called from
// `../index.ts` when `deployable.foundation === "vanilla"`.
//
// Per docs/plans/vanilla-foundation-tdd-plan.md — built in TDD slices:
//
//   Slice 0 (this file's initial scope): orchestrator branch + an empty
//     `vanilla/index.ts` returning the shell files only.  Green = R5
//     gate lifted, shell emits, nothing else asserted yet.
//   Slice 1+ (follow-ups): schema-emit, repository-emit, context-emit,
//     api-emit, parity-closing wire-spec test.
//
// Reuse (do not re-emit): heex-walker (LiveView body walker),
// migrations-emit (foundation-agnostic), render-expr/stmt (with a
// vanilla expr target where Ash filter syntax diverges), OpenAPI emit,
// JasonCamelCase, telemetry, seeds, theme, sidebar, shell renderers
// where they are framework-agnostic.
// ---------------------------------------------------------------------------

import type { GenerateElixirArgs } from "../index.js";
import { toModulePrefix, toSnakeApp } from "../shell-emit.js";
import { emitVanillaShellFiles } from "./shell-emit.js";

export function generateVanillaElixirProject(args: GenerateElixirArgs): Map<string, string> {
  const { deployable } = args;
  const out = new Map<string, string>();
  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // Shell files — mix.exs, application.ex, repo.ex, endpoint, router,
  // config/*, Dockerfile, .formatter.exs.  Plain Phoenix + Ecto, no
  // Ash deps.  See `./shell-emit.ts`.
  emitVanillaShellFiles(appName, appModule, out);

  return out;
}
