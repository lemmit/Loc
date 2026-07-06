// ---------------------------------------------------------------------------
// `.vscode/launch.json` — system-root VS Code debug configuration for the
// generated node/Hono deployables (M18 phase 8 slice 1, Node debug wiring).
// See docs/plans/dap-node-debug.md for the spike this emission is based on.
//
// Emitted ONLY under `--sourcemap` (a `SourceMapRecorder` is present) —
// additive, sits alongside `docker-compose.yml` at the system output root.
// One configuration per node-family deployable (family "node" covers both
// the `node@v4` and `node@v5` backend packages — see
// src/platform/hono/v4/index.ts's `makeHonoPlatform` factory), launching
// plain Node against that deployable's own `index.ts` with
// `--enable-source-maps` — no `--experimental-strip-types`: the docker image
// this project ships (`node:24-alpine`) has type-stripping unflagged by
// default, so the config targets that runtime. A LOCAL host Node older than
// 23.6 needs the flag added by hand (see the design note); a host Node
// older than 22.6 doesn't support stripping at all. Requires the sibling
// `addTsExtensionsForNodeDebug` import rewrite (src/generator/typescript/
// debug-imports.ts, applied in src/platform/hono/v4/emit.ts) — both are
// gated on the same flag, so they always ship together.
// ---------------------------------------------------------------------------

export interface NodeLaunchTarget {
  /** The deployable's own `.ddd` name — used in the launch config label. */
  name: string;
  /** The deployable's output-directory slug (`serviceSlug(d.name)`). */
  slug: string;
}

export function renderVsCodeLaunchJson(targets: readonly NodeLaunchTarget[]): string {
  const configurations = targets.map((t) => ({
    type: "node",
    request: "launch",
    name: `Debug ${t.name} (node --enable-source-maps)`,
    program: `\${workspaceFolder}/${t.slug}/index.ts`,
    cwd: `\${workspaceFolder}/${t.slug}`,
    runtimeArgs: ["--enable-source-maps"],
    outFiles: [`\${workspaceFolder}/${t.slug}/**/*.ts`],
    resolveSourceMapLocations: [`\${workspaceFolder}/${t.slug}/**`, "!**/node_modules/**"],
    skipFiles: ["<node_internals>/**"],
    console: "integratedTerminal",
  }));
  return (
    JSON.stringify(
      {
        version: "0.2.0",
        configurations,
      },
      null,
      2,
    ) + "\n"
  );
}
