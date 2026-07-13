# Debugging generated Loom apps

Loom emits **native debug metadata** for every target that has a native
debugger, so you debug in your own language *and* step back to the `.ddd`
source that produced the code. Everything here is gated behind one flag —
`--sourcemap` — and is fully additive: with the flag off, generated output
is byte-for-byte unchanged.

There are two independent paths, and the first is the one you want almost
always:

1. **Native editor debugging** (§2) — the emitted `.vscode/launch.json`
   points your editor's *own* debugger (Node, .NET, JVM) at the emitted
   source maps. Set a breakpoint in the `.ddd` file, it binds; step through
   and the stack shows `.ddd`. This is real, live, stepping-and-inspection
   debugging, working today.
2. **CLI trace/breakpoint translation** (§3) — `ddd trace` and `ddd
   breakpoints` translate positions between `.ddd` and generated code from
   the terminal, no editor required. Useful for a crash log from
   production, or scripting.

A third, standalone path — the `ddd-dap` debug adapter (§4) — is a DAP
server built directly on the same maps; see its section for what it does
and doesn't do today.

## 1. Generate the maps

Pass `--sourcemap` to `generate system`:

```bash
node bin/cli.js generate system app.ddd -o out --sourcemap
```

This adds, alongside the normal output:

- **`out/.loom/sourcemap.json`** — the generic, cross-target map (`.ddd`
  spans ↔ generated file regions) that `ddd trace` / `ddd breakpoints` /
  `ddd-dap` all read.
- **Per-target native debug metadata**, woven into the generated projects
  themselves:

  | Target | What ships | Consumed by |
  |---|---|---|
  | Node / Hono | Source Map v3 `.ts.map` sidecars (`//# sourceMappingURL`) pointing back to `.ddd` | the Node inspector, VS Code `js-debug`, browser devtools |
  | .NET | `#line` directives → the PDB carries `.ddd` line/column spans | VS Code `coreclr`, `dotnet` debugger |
  | Java / Spring | JSR-45 SMAP in the class file's `SourceDebugExtension` | any JDWP debugger (VS Code `java`) — the same mechanism JSP debugging uses |
  | Python / Elixir | *no native `#line`* — use the CLI trace path (§3) | `ddd trace` |

- **`out/.vscode/launch.json`** — one launch configuration per debuggable
  deployable (node / .NET / Java), pre-wired to the metadata above.

## 2. Native editor debugging (recommended)

**In the browser playground:** the Run/boot path always bundles the
in-browser Hono backend with an inline Source Map v3 chaining back to
`.ddd` — no toggle to find. Open DevTools → Sources, find the backend's
blob module, and set a breakpoint on a `.ddd` line; it binds via the
inline map. The Files pane and the git-backed workspace store stay
byte-identical to a `sourcemap`-off generate: the playground generates
the source you see/persist and the mapped boot bundle from two separate
generate calls of the same source, so the maps never leak into what you
view, hand-edit, or download (see `web/src/build/strip-sourcemap.ts`).
One caveat: a hand edit to a generated file that carries a map sidecar
isn't reflected in the *mapped* boot (the freshly-generated version is
what DevTools can chain back to `.ddd`) — everything else in the
workspace, including hand edits to files the flag doesn't touch, bundles
as edited.

Open the generated `out/` directory in VS Code. The emitted
`.vscode/launch.json` already contains a config per backend. Pick one from
the Run and Debug panel, set a breakpoint **in the `.ddd` file**, and run.

### What each config looks like

A Node deployable named `honoApi` (slug `hono_api`):

```jsonc
{
  "type": "node",
  "request": "launch",
  "name": "Debug honoApi (node --enable-source-maps)",
  "program": "${workspaceFolder}/hono_api/index.ts",
  "cwd": "${workspaceFolder}/hono_api",
  "runtimeArgs": ["--enable-source-maps"],
  "outFiles": ["${workspaceFolder}/hono_api/**/*.ts"],
  "resolveSourceMapLocations": ["${workspaceFolder}/hono_api/**", "!**/node_modules/**"],
  "skipFiles": ["<node_internals>/**"]
}
```

A .NET deployable named `dotnetApi`:

```jsonc
{
  "type": "coreclr",
  "request": "launch",
  "name": "Debug dotnetApi (.NET)",
  "program": "${workspaceFolder}/dotnet_api/bin/Debug/net10.0/DotnetApi.dll",
  "cwd": "${workspaceFolder}/dotnet_api",
  "console": "integratedTerminal",
  "stopAtEntry": false
}
```

A Java deployable named `javaApi`:

```jsonc
{
  "type": "java",
  "request": "launch",
  "name": "Debug javaApi (Java)",
  "mainClass": "com.loom.javaapi.Application",
  "projectName": "javaapi",
  "cwd": "${workspaceFolder}/java_api"
}
```

### How the `.ddd` breakpoint binds

Source-map debugging is bidirectional: the debugger reads the map, so a
breakpoint you set in the original source (`.ddd`) *binds* to the generated
location, and a stack frame reported in generated coordinates *displays* as
`.ddd`. This is the same mechanism that lets you debug TypeScript, Kotlin,
or a `.jsp` — Loom just emits the map.

- **Set a breakpoint** on, say, a `precondition` or a workflow statement in
  the `.ddd` file → it binds to the emitted guard / statement.
- **When it hits**, the call stack shows `.ddd` frames for the code Loom
  generated (framework frames stay in their own language, honestly
  labelled).

### Assumptions each config makes

Each config **assumes a prior build/boot step** — it is deliberately not a
`preLaunchTask` (that's your project's choice):

- **Node** — assumes the deployable is runnable as-is. The config uses
  plain `node --enable-source-maps` with no `--experimental-strip-types`
  flag, targeting the runtime the shipped docker image uses (`node:24`,
  where type-stripping is unflagged). A *local* host Node older than 23.6
  needs the flag added by hand; older than 22.6 can't strip types at all.
- **.NET** — assumes a prior `dotnet build` (the config points at
  `bin/Debug/<TFM>/<Assembly>.dll`).
- **Java** — assumes the project is importable by the editor's Java
  extension (which builds it); `mainClass` is the emitted
  `@SpringBootApplication` class.

## 3. CLI trace / breakpoint translation (no editor)

Two commands translate positions from the terminal, reading
`.loom/sourcemap.json`. Both default to `<out>/.loom/sourcemap.json` (or
`./.loom/sourcemap.json`); pass `--map <path>` to override.

### `ddd trace` — generated stack trace → `.ddd`

Feed it a crash log / stack trace file; each recognized frame is annotated
with the `.ddd` construct + source location it maps to. Unrecognized frames
(framework internals) pass through unchanged.

```bash
node bin/cli.js trace crash.log --map out/.loom/sourcemap.json
```

This is the path for **Python and Elixir** (no native `#line`), and for any
production stack trace you have as text but not a live process.

### `ddd breakpoints` — `.ddd` line → generated location(s)

The reverse: resolve a `.ddd` source line to the generated `file:line` (or
`file:line:column`, when the line carries a fine expression region) it
produced.

```bash
node bin/cli.js breakpoints app.ddd --line 42 --map out/.loom/sourcemap.json
# hono_api/domain/order.ts:55:12
```

A `.ddd` line that fans out to several generated files lists them all; a
line with no mapping is reported as such (exit 0 — a valid answer, not a
failure).

## 4. The `ddd-dap` debug adapter

`packages/ddd-dap` is a standalone [Debug Adapter
Protocol](https://microsoft.github.io/debug-adapter-protocol/) server built
on the same `.loom/sourcemap.json`. It exists so an editor can drive
`.ddd`-native breakpoints/stack-frames through one adapter regardless of
target language.

**Today it ships the remap layer**: the `initialize` / `setBreakpoints` /
`stackTrace` requests, answered by resolving `.ddd` ↔ generated positions
through the map. Launch it over stdio pointed at a generated map:

```bash
npx ddd-dap --map out/.loom/sourcemap.json
# or: LOOM_DAP_MAP=out/.loom/sourcemap.json npx ddd-dap
```

**What it does not do yet:** delegate to a running target debugger. Live
stepping (`launch`/`attach`/`continue`/`stepIn` against an actual running
backend) requires the adapter to spawn and proxy the target's own debugger
(`js-debug` / `coreclr` / JDWP) and remap only line/scope on top — the
documented, editor-verified frontier (see
[`docs/proposals/source-map-and-debugging.md`](proposals/source-map-and-debugging.md)
§6E). **For live stepping today, use the native editor path in §2** — it
drives each target's real debugger directly and needs no delegation.

## See also

- [`docs/proposals/source-map-and-debugging.md`](proposals/source-map-and-debugging.md)
  — the full design: the Origin spine, per-target metadata, and the phased
  roadmap.
- [`docs/loom-artifacts.md`](loom-artifacts.md) — the `.loom/` output
  bundle, including `sourcemap.json`.
- [`docs/tools.md`](tools.md) — the full `ddd` CLI surface.
- [`packages/ddd-dap/README.md`](../packages/ddd-dap/README.md) — the debug
  adapter package.
