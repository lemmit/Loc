# ddd-dap

A [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
(DAP) server for **Loom** — it maps positions between `.ddd` source and the
code Loom generates, so an editor can work in `.ddd` terms regardless of the
target language.

It is the publish wrapper for the server core in
[`src/dap-server/`](../../src/dap-server) (the same split `ddd-mcp` uses for
`src/mcp/`): this package owns the `bin` and the `@vscode/debugadapter`
dependency; the wiring lives in the core.

## What it does

`ddd-dap` reads a generated `.loom/sourcemap.json` (produced by `ddd
generate system … --sourcemap`) and answers three DAP requests over it:

| Request | Behaviour |
|---|---|
| `initialize` | Advertises the remap-layer capabilities and emits `InitializedEvent`. |
| `setBreakpoints` | Resolves each `.ddd` breakpoint to the generated location that should be armed (via `resolveSetBreakpoints`). |
| `stackTrace` | Rewrites reported frames from generated coordinates back to `.ddd` source (via `remapStackFrames`). |

Both directions reuse the pure, dependency-free resolution cores in
[`src/dap/`](../../src/dap) — the same ones `ddd trace` / `ddd breakpoints`
build on.

## Usage

Run it over stdio, pointed at a generated map:

```bash
npx ddd-dap --map path/to/.loom/sourcemap.json
# or via env:
LOOM_DAP_MAP=path/to/.loom/sourcemap.json npx ddd-dap
```

With neither, it defaults to `./.loom/sourcemap.json`.

An editor launches it as a DAP subprocess; `stdout` is the protocol
channel, so diagnostics go to `stderr`.

## Scope — remap layer only

This adapter ships the **remap layer**: position translation over the map.
It does **not** yet delegate to a running target debugger. Live stepping
(`launch` / `attach` / `continue` / `stepIn` against an actual running
backend) requires spawning and proxying the target's own debugger
(`js-debug` / `coreclr` / JDWP) and remapping only line/scope on top — the
documented, editor-verified frontier (see
[`docs/old/proposals/source-map-and-debugging.md`](../../docs/old/proposals/source-map-and-debugging.md)
§6E).

**For live stepping today**, use the native editor path: `ddd generate
system … --sourcemap` emits a `.vscode/launch.json` that points each
backend's own debugger (Node / .NET / JVM) at the emitted source
maps / PDB / SMAP, so breakpoints set in `.ddd` bind and stepping works
without any delegation. See [`docs/debugging.md`](../../docs/debugging.md).

## Layout

| File | Role |
|---|---|
| `bin.js` | Node launcher → `out/dap-server/main.js`. |
| `index.ts` | Re-exports `LoomDebugSession` from the core for embedders. |
| `package.json` | `bin` + the `@vscode/debugadapter` / `@vscode/debugprotocol` deps; `loom.kind: "dap-server"`. |
