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

There are three graphical editors (the "Code" tab's sub-views),
all backed by craft.js / React Flow, that edit the **same `.ddd` source**
round-trip — they parse the current source, let you manipulate it visually,
then splice the result back in (preserving everything else) and push it
through the live Monaco model so the source tab and Problems panel update
immediately:

- a **page builder** (`src/builder/page/`) — drag/drop the page-body
  primitives (`List`/`Detail`/`Form`/`Stack`/…) onto a craft.js canvas;
- a **model builder** (`src/builder/system-v2/`, over the shared edit
  library in `src/builder/system/`) — a React-Flow **drill-down navigator**
  where the canvas *is* the breadcrumb: each level shows the children of the
  current construct (system → module → context → aggregate → operation →
  statement flow), and every node carries its own rename / delete / clause
  edits. At the root it also offers **Overview** — the whole model as one
  flat, *read-only* graph, with the coverage heatmap, cross-model search +
  kind filter, module/context nesting and the wire-shape (DTO) inspector;
  opening a construct there jumps the navigator to it, ancestors and all.
  (Until M-T8.13 this shipped as *two* panes — a flat "Model" editor and a
  "Model v2" drill-down. They are one pane now: one mutation surface, with
  the flat canvas surviving as the read-only Overview mode.)
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

## Workspaces across tabs

Each workspace is one git repo over one IndexedDB (LightningFS +
`isomorphic-git`), so **two tabs on the same workspace are two writers on one
filesystem**. LightningFS's own mutex only covers 500 ms activation windows,
which is far shorter than a git sequence (`stageAll` → `commit` → `writeRef`),
so the playground coordinates a level up:

- **One writer.** Opening a workspace takes an exclusive **Web Lock**
  (`loom.workspace.<gitDb>.writer`, `web/src/workspace/tab-lock.ts`), held for
  the tab's session. The first tab is the writer; a second tab opens the same
  workspace **read-only** — every mutation is refused at the `GitStore` choke
  point (`WorkspaceReadOnlyError`), so auto-commit, the generated-tree merge
  and History's "Restore this version" are all suppressed, not just greyed out.
  Two tabs on *different* workspaces are both writable.
- **Take over.** The read-only tab shows a header banner and a **Take over**
  button; it steals the lock, and the previous holder visibly flips to
  read-only rather than continuing to write. Closing or crashing the writer
  tab releases the lock automatically (that is the Web Locks contract), and
  the waiting tab becomes the writer with no reload.
- **Live readers.** A per-workspace `BroadcastChannel`
  (`web/src/workspace/tab-channel.ts`) carries file / commit / role /
  deleted invalidations. The receiving tab drops its stale LightningFS
  activation window and replays the message into the store's existing
  notifier, so the editor follows through the same external-content `epoch`
  a history restore uses, and History reloads on the commit channel.
  Received messages never re-broadcast, so there is no echo loop.
- **Deleting a workspace** broadcasts first, so other tabs close their
  IndexedDB connection and `deleteDatabase` completes instead of hanging on
  `blocked`; the workspace *list* also syncs across tabs through the
  registry's localStorage `storage` event (the active workspace stays
  per-tab).

A browser without `navigator.locks` / `BroadcastChannel` degrades to the old
single-tab assumption — every tab writable — rather than to a hard failure or
a spurious read-only banner.

## Crash reporting & diagnostics

The playground is a static GitHub Pages site: **there is no telemetry and no
beacon**, and nothing is ever transmitted automatically. A crash is therefore
only reportable if the app can hand you a self-sufficient artifact — which is
what this layer does.

**On device.** Every crash-class event lands in a 12-entry ring persisted at
`localStorage["loom.diag"]`, so it survives the reload a crash causes. Read it
either in **Output → Diagnostics** (newest first, with the message and stack
inline) or from the console:

```js
__loomDiag()          // the whole ring, oldest-first
```

Five reasons are error classes — `react-error` (the root boundary),
`react-error-pane` (a pane boundary; carries the pane name),
`window-error`, `unhandledrejection`, and `worker-error` (the build worker
died — previously invisible). Everything else (`hidden`, `pagehide`) is a
pressure breadcrumb: heap and storage readings captured *before* a crash. Each
entry carries the **build SHA** of the bundle that produced it; the deployed
bundle ships minified with no sourcemap, so the SHA is the key that makes a
stack resolvable (rebuild that commit).

**Reporting.** *Copy crash report* and *Report on GitHub* sit on both crash
fallbacks, on the "crashed last session" notice, and in the Diagnostics
stream. Copy puts the complete markdown report on the clipboard **and renders
it on screen** so you can read exactly what you are about to share. *Report on
GitHub* opens the [crash-report issue form](https://github.com/lemmit/Loc/issues/new?template=crash-report.yml)
with the report prefilled (abridged to fit the URL — the clipboard copy is
always complete); it is an ordinary link, nothing is sent until you submit.

**A report contains** the build SHA and build time; the crash class, pane,
message, stack and React component stack; the user-agent, viewport and page
URL (path only); heap/storage pressure; and a workspace *fingerprint* — one
row per file with its path, byte length and a truncated SHA-256.

**A report never contains** `.ddd` or generated source text (files appear as
the fingerprint only), the URL query or hash (the share hash encodes your
whole model), any credential shape found in free text (`sk-…`, `ghp_…`,
bearer tokens, JWTs, `key=`/`token=` parameters — all replaced with
`[redacted]`), or your BYOK provider key. That last one is structural, not a
filter: the assembler (`web/src/util/crash-report.ts`) performs no ambient
storage read at all, and a unit test pins that it never names the settings
entry the key lives in.

**Self-test.** `?crash=app` forces a throw inside the root boundary and
`?crash=pane` inside a pane boundary — the way to check that reporting works
on your device without waiting for a real crash (and how the e2e spec covers
the boundaries, which run in the production bundle).

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
