import type { DeployableIR, EnrichedBoundedContextIR, SystemIR } from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import type { StyleAdapter } from "../_adapters/index.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { generateVanillaElixirProject } from "./vanilla/index.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView generator orchestrator.
//
// `generateElixirProject` is the single entry point called by the platform's
// `emitProject`.  `platform: elixir` generates Phoenix LiveView on plain
// Ecto/Phoenix, delegating straight to the `vanilla/` emit subtree.
//
// File layout (vanilla/):
//   lib/<app>/<ctx>/<agg>.ex                  — Ecto schema modules
//   lib/<app>/<ctx>/workflows/<wf>.ex          — workflow modules
//   lib/<app>/<ctx>.ex                         — context module
//   lib/<app>/repo.ex                          — Ecto.Repo
//   lib/<app>/application.ex                   — supervision tree
//   lib/<app>_web.ex                           — __using__ macro
//   lib/<app>_web/endpoint.ex                  — Phoenix.Endpoint
//   lib/<app>_web/router.ex                    — router
//   lib/<app>_web/components/layouts.ex        — layout components
//   config/config.exs, dev.exs, prod.exs, runtime.exs
//   priv/repo/migrations/<ts>_create_<table>.exs
//   priv/repo/seeds.exs
//   rel/env.sh.eex, rel/overlays/bin/server
//   mix.exs, .formatter.exs, Dockerfile, .dockerignore
// ---------------------------------------------------------------------------

export interface GenerateElixirArgs {
  contexts: EnrichedBoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** Per-deployable slice of `buildMigrations(sys, snapshots)` — only the
   *  modules this deployable owns (via `module.migrationsOwner ===
   *  deployable.name`).  Empty array when this deployable owns no
   *  migrations or the system orchestrator was invoked without a
   *  snapshot store; in either case the emitter is a no-op. */
  migrations?: MigrationsIR[];
  /** Compile-time --trace switch.  When true, the controllers emit a
   *  `wire_in` Logger.debug line at each CRUD action entry so the parsed
   *  `params` key set surfaces on the structured stream — mirroring Hono
   *  Phase 6d / .NET v6 wire_in's intent. */
  emitTrace?: boolean;
  /** The deployable's resolved STYLE adapter (D-REALIZATION-AXES
   *  `application:` → the `layered` controller → context → repository
   *  surface).  The system orchestrator resolves it from
   *  `deployable.application` via `resolveStyle` and threads it in.
   *  Absent in legacy single-context mode → falls back to the
   *  `layeredStyleAdapter`. */
  styleAdapter?: StyleAdapter;
  /** Generate-time source-map recorder (`--sourcemap`).  Threaded straight
   *  through to the vanilla orchestrator, which records whole-file
   *  construct regions as it places each per-aggregate/-workflow/-page
   *  artifact.  Absent → every recorder call is a no-op (see
   *  `SourceMapRecorder.file`). */
  sourcemap?: SourceMapRecorder;
}

export function generateElixirProject(args: GenerateElixirArgs): Map<string, string> {
  return generateVanillaElixirProject(args);
}
