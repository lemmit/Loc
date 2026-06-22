# Playground

The playground is Loom running entirely in your browser: type a `.ddd`
source, watch the multi-project tree regenerate, then bundle and boot the
generated Hono backend on an in-process Postgres and click through the
generated React app — no server, no install, no Docker. It is live at
<https://lemmit.github.io/Loc/playground/> (landing page at
<https://lemmit.github.io/Loc/>) and lives in the `web/` workspace.

The headline point: it runs **the exact same toolchain the `ddd` CLI
runs**. There is no second, browser-flavoured compiler — `web/` imports
the parser, IR lowering, validators, and generators straight from
`../src`. What you see generated in the browser is byte-for-byte what
`ddd generate system` produces on disk.

## How it imports the toolchain

`web/` is a separate Vite + React package, but it has no copy of the
compiler. It imports `../src` directly because the Loom toolchain is pure
TypeScript with no Node-only APIs — the only Node-bound seams are
`src/cli/` and `src/language/main.ts` (plus `src/mcp/`), none of which the
playground imports. Vite's bundler handles the `.js`-extension import
specifiers used throughout `src/`.

One module needs a swap. The React generator's design-pack loader has a
Node variant (`src/generator/_packs/loader-fs.js`) that reads `.hbs`
templates off disk via `node:fs`. A small Vite plugin
(`loomLoaderShim` in `web/vite.config.ts`) resolves any import ending in
`/_packs/loader-fs.js` to `web/src/build/loader-vfs.ts` instead — a
VFS-backed loader that reads the pack templates from an in-memory virtual
filesystem seeded at worker boot. The shim is registered both for the
main app build and for the worker build (the build worker transitively
pulls the generator in), so neither tries to bundle `node:fs`.

Heavy work runs in Web Workers, not on the UI thread:

- an **LSP worker** (`src/lsp/`) — the real Langium language server, the
  same one the VS Code extension speaks, over `monaco-languageclient`;
- a **build worker** — runs the generator over a workspace VFS and returns
  the generated file tree;
- a **runtime worker** (`src/runtime/`) — bundles the Hono backend and
  boots PGlite.

## The four capabilities

The landing page advertises "typed editor + visual system builder + live
preview + in-browser test runner." All four exist in the code; here is
what each actually is.

### Typed editor

A Monaco editor wired to the Langium LSP worker over `monaco-languageclient`
+ `@codingame/monaco-vscode-api` — so diagnostics, completion, hover, and
go-to-definition are the real language server, not a regex highlighter.
The workspace is multi-file: you can add companion `.ddd` files and
`import "./shared/x.ddd"` resolves because every workspace source is pushed
into the LSP worker as a Monaco model. Sources persist to IndexedDB and are
versioned in an isomorphic-git-backed workspace (auto-commit on save). A
single-file source can also be shared by URL (the `s=` / `p=` hash
payload).

### Visual system builder

There are actually three graphical editors (the "Code" tab's sub-views),
all backed by craft.js / React Flow, that edit the **same `.ddd` source**
round-trip — they parse the current source, let you manipulate it visually,
then splice the result back in (preserving everything else) and push it
through the live Monaco model so the source tab and Problems panel update
immediately:

- a **page builder** (`src/builder/page/`) — drag/drop the page-body
  primitives (`List`/`Detail`/`Form`/`Stack`/…) onto a craft.js canvas;
- a **system builder** (`src/builder/system/`, plus a `system-v2/`
  React-Flow graph variant) — edit deployables, modules, aggregates, and
  their wiring as a node graph;
- a **requirements** pane (`src/builder/requirements/`).

These are genuine source-editing surfaces, not read-only diagrams. On
mobile they render as the plain source editor until explicitly opened
(they are heavy to mount).

### Live preview

When the generated tree contains a Hono backend and a React frontend, the
runtime worker bundles both (an in-browser npm install + esbuild-wasm
bundle, `src/engine/`), boots the backend, and the React app renders in a
sandboxed iframe. Iframe `fetch()` calls to `http://localhost:*` are
intercepted by an in-iframe shim and routed via `postMessage` to the
parent, which dispatches them through the runtime worker — so the
generated React → Hono → Postgres round-trip runs end-to-end under one
origin. In live mode the preview refreshes in place as you type (debounced
~5 s).

The runtime is **Hono + React only**. A system that declares only .NET,
Phoenix LiveView, Java, or Python deployables — or a Vue/Svelte frontend —
generates fully and is browsable in the Files pane, but the preview names
those as "run outside the playground" rather than booting them. The
playground surfaces this explicitly instead of failing silently.

### In-browser test runner

The Postgres is **PGlite** — a WebAssembly Postgres — booted inside the
runtime worker (`src/runtime/runtime.worker.ts`). Because Loom emits a
Drizzle `pg-core` schema rather than ready SQL, the worker can't run
Drizzle Kit in a browser; instead `src/runtime/ddl.ts` (`synthDDL`) walks
the bundled schema's table/enum/index metadata and emits the minimal
`CREATE SCHEMA` / `CREATE TYPE` / `CREATE TABLE` / `CREATE INDEX` SQL to
bring a fresh PGlite up to the shape the generated repositories expect. It
is idempotent (`IF NOT EXISTS`, enum-create wrapped in a duplicate-object
catch) so it re-applies cleanly against a persistent OPFS-backed PGlite —
the DB survives reloads, keyed by a hash of the source, with "Reset DB" to
drop and rebuild.

On top of that live runtime, the playground runs the **DSL-emitted test
suites** — the same files `ddd generate system` writes:

- **api/unit tests** (`src/testing/run-api-tests.ts`, `harness.ts`) — the
  generated `e2e/<System>.e2e.test.ts` (vitest + `fetch`) and the
  aggregate unit tests. The harness re-implements the tiny slice of vitest
  those files use (`describe`/`it`/`expect`) and injects a `fetch` backed
  by the runtime dispatch, so they run with no Node, no real vitest, no
  network.
- **ui tests** (`src/testing/run-ui-tests.ts`) — the generated
  `*.ui.spec.ts` Playwright spec, run against the preview iframe through a
  message-driven page-object driver (`packages/ui-test-driver/`) with a
  `@playwright/test` shim, capturing a final-state screenshot per test.

A Backend console (OpenAPI-driven endpoint picker) and a SQL console round
out the runtime panel for poking the booted backend by hand.

## How it's built and deployed

`npm --prefix web run build` runs `tsc -b` + `vite build`; the output is a
fully static bundle (relative `base`, so it runs from any sub-path). The
`pages.yml` workflow typechecks, smoke-tests (a Node-side end-to-end of the
pipeline), prebuilds the same-origin `npm-mirror/` so the deployed runtime
installs without registry round-trips, builds, and stages `web/dist/` under
`docs/_site/playground/` for GitHub Pages — deployed on every push to
`main` that touches `web/**`. The Playwright e2e specs (`web/e2e/`) gate the
production-built playground; see `web/e2e/README.md`.

## One source of truth

The value of the playground is that it is not a demo of Loom — it *is*
Loom, minus the filesystem. Generate, validate, the design-pack rendering,
the wire shape, the emitted tests: every one of those is the code under
`src/` that the CLI and CI run. A `.ddd` that compiles, boots, and passes
its tests in the browser does so because the real toolchain made it,
which is exactly why the playground doubles as a fast feedback loop while
developing the toolchain itself.
