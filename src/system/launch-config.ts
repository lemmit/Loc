// ---------------------------------------------------------------------------
// `.vscode/launch.json` — system-root VS Code debug configuration wrapping
// each debuggable deployable's own `PlatformSurface.debugLaunch()` fragment
// (M18 phase 8 slice 1, Node debug wiring; M26 extends the seam to .NET
// `coreclr` and Java `java` configs). See docs/plans/dap-node-debug.md.
//
// Emitted ONLY under `--sourcemap` (a `SourceMapRecorder` is present) —
// additive, sits alongside `docker-compose.yml` at the system output root.
// `src/system/index.ts` collects one config per deployable whose platform
// implements `debugLaunch` (node/dotnet/java today; python, elixir, and the
// frontends return `undefined` and are skipped), in deployable order, and
// this module just wraps the pre-built config objects — it owns no
// per-backend naming knowledge itself.
// ---------------------------------------------------------------------------

export function renderVsCodeLaunchJson(configs: ReadonlyArray<Record<string, unknown>>): string {
  return (
    JSON.stringify(
      {
        version: "0.2.0",
        configurations: configs,
      },
      null,
      2,
    ) + "\n"
  );
}
