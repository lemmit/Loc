# Node debug wiring — spike findings + emission (Milestone 18, phase 8 slice 1)

**Created:** 2026-07-06
**Status:** Shipped (partial, by design) — import-specifier fix + debug script
+ `.vscode/launch.json` land for the node/Hono backend; a real, documented
gap (value-object constructors) is called out below as follow-up, not
papered over.

See [`../proposals/source-map-and-debugging.md`](../proposals/source-map-and-debugging.md)
§6E ("DAP — breakpoints in `.ddd`") and §9's phase table row 8
(`ddd-dap` — "Large" effort, depends on phases 5/6/7). This doc is the first
slice of phase 8: it does **not** build the `ddd-dap` adapter itself: it
proves (or disproves) the cheapest live payoff the phase-8 scout identified
— making the phase-5 `.ts.map` sidecars (`docs/plans/span-tracking-emission.md`)
actually reachable by a debugger / Node's own stack traces on the generated
Hono backend, bypassing the tsx/tsup map hops entirely. This is
**spike-first**: every emission decision below follows from an empirical
finding recorded in Phase A, not the other way round.

## Phase A — the spike

Fixture: `examples/acme.ddd` generated with `--sourcemap` (`node bin/cli.js
generate system examples/acme.ddd -o <out> --sourcemap`), node deployable
`catalogWeb` → `catalog_web/`. Host: Node v22.22.2 (`--experimental-strip-types`
required); docker image the generated `Dockerfile` pins: `node:24-alpine`
(type stripping unflagged). Both were exercised.

### 1. Import specifiers — extensionless (Bundler-style), NOT `.js`/`.ts`

The generated node/Hono project's `tsconfig.json` sets
`"moduleResolution": "Bundler"`, and every relative import is extensionless:

```ts
// catalog_web/domain/product.ts (flag off, today's shape)
import * as Ids from "./ids";
import type { Money } from "./value-objects";
```

This is neither the `nodenext`/`.js`-specifier convention type-stripping
docs assume, nor bare `.ts`. **Plain Node's ESM loader does not probe
extensions for a relative specifier** (unlike CommonJS `require`, which
tries `.js`/`.json`/`.node` in turn) — it resolves the literal string. So
`node --experimental-strip-types` fails on the FIRST relative import,
independent of and prior to any type-stripping question:

```
$ node --experimental-strip-types --enable-source-maps probe.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../catalog_web/domain/ids' imported from '.../catalog_web/domain/product.ts'
```

`npx tsx` (the project's own `dev` script) DOES resolve extensionless
specifiers — but see finding 3: it doesn't chain to `.ddd`.

### 2. Domain-module probe — SUCCEEDS, once imports carry an explicit extension

Fixing the import specifiers is sufficient. With every relative specifier in
a small copy of `product.ts` + its siblings rewritten to carry `.ts`
(`from "./ids.ts"`), then running plain Node against the phase-5-mapped file:

```
$ node --experimental-strip-types --enable-source-maps probe.mjs   # host node 22
$ docker run … node:24-alpine node --enable-source-maps probe.mjs  # node 24, unflagged
```

Both produce a stack trace that resolves **straight through the phase-5
`.ts.map` sidecar to the `.ddd` source**, not the generated `.ts`:

```
DomainError: Invariant violated: sku.length > 0
    at Product._assertInvariants (/home/user/Loc/examples/acme.ddd:63:13)
    at new Product (/home/user/Loc/examples/acme.ddd:63:13)
    at Product.create (/home/user/Loc/examples/acme.ddd:63:13)
    at file:///app/probe.mjs:3:11
```

This is the actual north star for this slice: Node's own crash reporting,
zero new dependencies, pointing at the `.ddd` line/column. Confirmed on both
host Node 22 (with the flag) and the docker image's Node 24 (unflagged,
`--enable-source-maps` alone).

**Without `--enable-source-maps`** (but with the extension fix), the same
crash resolves to the generated `.ts` file/line/col instead
(`product.ts:41:40`) — still useful (it's exactly what `ddd trace`,
already shipped, consumes), but not the `.ddd`-native experience.

**Non-erasable syntax — a real, separate gap found by this spike.** The
generated TS is erasable-only for aggregates/entities (no `enum`, no
`namespace`; verified by grep across the generated project). **Value
objects are the exception**: `src/generator/typescript/emit/value-objects.ts`
emits a TypeScript **parameter-property** constructor —

```ts
export class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: string
  ) { … }
}
```

— which both `--experimental-strip-types` and Node 24's unflagged stripping
**reject outright**, since parameter properties are sugar the type checker
must desugar, not syntax that erases to nothing:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter
property is not supported in strip-only mode
```

Booting the FULL generated server (`index.ts`, not just an isolated domain
probe) reliably hits this: any valueobject with fields that's constructed
at runtime somewhere outside an `import type` (the common case — a
repository hydrating a row, or an HTTP route parsing a request body, both
construct `new Money(...)`) forces Node to actually parse
`value-objects.ts`, and the boot crashes on the parameter-property syntax.
`import type { Money } from "./value-objects"` sites (e.g. the aggregate's
own field-type reference) are erased WHOLESALE by type stripping and never
force the load — which is exactly why the isolated aggregate-level probe
above succeeds even though the full server does not.

**This is a genuine, separate finding this slice does not fix.** Rewriting
`emit/value-objects.ts`'s constructor to explicit field declarations +
assignment (semantically identical output, no runtime behavior change) would
close it, but that emitter is stable, byte-identical-gated, unconditional
output (every generated project, not just `--sourcemap` runs) — changing it
is a correctly-scoped, small, but **separate** follow-up slice with its own
review, not something to fold silently into "Node debug wiring." Tracked
below under Follow-ups.

**RESOLVED (slice 2, Milestone 19).** `emit/value-objects.ts` now emits
explicit field declarations + constructor assignments instead of parameter
properties, unconditionally (every generated node project, flag on or off) —
`test/generator/typescript/strip-erasable-constructors.test.ts` pins it. Both
probes from Phase A re-run clean on the rewritten emitter: the isolated
domain-module probe still succeeds, and — new for this slice — the value
object itself no longer trips `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` when a full
`index.ts` boot forces `value-objects.ts` to actually parse.

**Adjacent gap found while re-proving the full-boot probe, NOT fixed by
slice 2 (new follow-up, see below):** the full-server boot probe still hits
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — just one file later. Every
repository/reader class (`src/generator/typescript/repository-builder.ts`
and its `-document`/`-embedded`/`-eventsourced` siblings,
`base-reader-builder.ts`) and the `mikroorm` persistence adapter
(`emit/mikroorm.ts`) inject their dependencies via the same parameter-property
shape (`constructor(private readonly db: Db, private readonly events:
DomainEventDispatcher) {}`), and these ARE on the request-handling load path
(every route touches a repository). The Playwright page-object emitters
(`src/generator/_frontend/page-objects-builder.ts` and friends) emit the same
shape for their `constructor(public readonly page: Page)`, though those are
test-only `.ts` files under `e2e/pages/`, not part of a server boot. This
slice's spike-first discipline applies again: mechanical, low-risk, but its
own correctly-scoped follow-up — see below.

### 3. tsx/tsup path — resolves, but does NOT chain to `.ddd` (confirmed, as expected)

`npx tsx --enable-source-maps probe.mjs` runs (extensionless imports resolve
fine — esbuild-based loaders always probe extensions), but the stack trace
lands on the generated `.ts` file, never the `.ddd` source: tsx's own
in-memory source map (type-erasure only, 1:1 back to the same `.ts`
positions) has no way to chain through the phase-5 sidecar sitting next to
the file on disk — Node's `--enable-source-maps` consumer only follows the
map for the module it ACTUALLY loaded (tsx's transient in-memory transform),
not a second, unrelated sidecar file. Confirmed quickly, as the brief
predicted, without sinking further time into it.

### 4. js-debug prerequisites — present; full VS Code confirmation remains open

Checked directly against the emitted `.map` JSON (not a manual VS Code
session, which is unavailable headless):

- The sidecar is discoverable: `product.ts` carries a single trailing
  `//# sourceMappingURL=product.ts.map` line naming the sibling file
  (Milestone 5).
- `sources` names the `.ddd` path (the Langium document URI's `.path`).
- `sourcesContent` is embedded (phase 5's existing behavior; re-verified
  here, not new).

These are exactly what `js-debug` (VS Code's built-in Node/Chrome debugger)
needs to resolve a breakpoint set on a `.ddd` line back to the generated
position it should stop at, once phase 8's full adapter exists — **a manual
VS Code confirmation of that resolution is still open**, since this
environment has no VS Code UI to drive interactively. Everything scriptable
about the prerequisite is now verified.

## Phase B — the emission decision

**Ship the smallest slice the spike actually proves, scoped honestly around
the value-object gap — not a "boot the whole server" script framed as
universally working.**

### What ships

1. **Import-specifier fix**, gated on `--sourcemap`:
   `src/generator/typescript/debug-imports.ts`'s `addTsExtensionsForNodeDebug`
   suffixes every relative import specifier that resolves to an emitted
   `.ts`/`.tsx` module with its real extension. Called from
   `src/platform/hono/v4/emit.ts` (shared by `node@v4` **and** `node@v5` —
   both packages resolve through `makeHonoPlatform`, so one call site covers
   both), right after the existing `rewriteRelativeImports` layout pass, only
   when the `SourceMapRecorder` (`sourcemap`) is present. This alone is
   necessary and sufficient to make Node's own ESM loader resolve the whole
   module graph — the domain-probe win from Phase A finding 2.
2. **`tsconfig.json` grows `allowImportingTsExtensions: true`**, same gate
   (`projectTsconfigJson` in the same file). Required because TS5097
   ("An import path can only end with a '.ts' extension …") otherwise fails
   the project's own `npm run typecheck` once imports carry `.ts` —
   confirmed empirically against a live `tsc --noEmit` run. `noEmit` (already
   set) is the flag's other precondition. `tsx`/`tsup` (esbuild) accept
   `.ts`-suffixed relative imports unconditionally either way, so `npm run
   dev` / `npm run build` are unaffected regardless of this flag.
3. **`package.json` grows a `debug` script**, same gate:
   `"debug": "node --enable-source-maps index.ts"` — **no**
   `--experimental-strip-types`. Decision: the docker image this project
   ships (`node:24-alpine`) has type stripping unflagged by default, and the
   generated `package.json` pins no `engines` field naming an older Node —
   so the emitted config targets Node 24 semantics. Confirmed the flag is
   harmless-but-unnecessary on Node 24 (accepted, no warning) and a hard
   `bad option` failure on Node 20 (exit 9) — since we cannot know a
   developer's LOCAL host Node version, omitting it is the safer default; a
   host on Node 22.6–23.5 needs the flag added by hand (documented here,
   not silently assumed).
4. **`.vscode/launch.json` at the system output root** (sibling of
   `docker-compose.yml`), same gate: `src/system/launch-config.ts`'s
   `renderVsCodeLaunchJson`, called from `emitSystem` in `src/system/index.ts`.
   One `type: "node"` / `request: "launch"` configuration per **node-family**
   deployable (`platformFor(d.platform).name === "node"` — covers both
   `node@v4` and `node@v5`; a dotnet/python/java/elixir deployable gets none):
   `program`/`cwd` pointing at `<slug>/index.ts`, `runtimeArgs:
   ["--enable-source-maps"]`, `outFiles` + `resolveSourceMapLocations`
   scoped to the slug directory, `skipFiles: ["<node_internals>/**"]`.
   Emitted only when the system has at least one node-family deployable (an
   empty `configurations` array would be a config nobody can select).

All four are additive and gated on the identical `sourcemap` truthiness
check the rest of this milestone already uses — flag-off output stays
byte-identical (verified: `test/system/sourcemap.test.ts`'s existing
byte-identical gate now also normalizes these four divergences before
comparing, the same pattern the .NET `#line` weave and the Java `injectSmap`
fence already established for their own gated content changes).

### What does NOT ship, and why

- **No change to `emit/value-objects.ts`.** The parameter-property
  constructor is the one remaining blocker to a FULLY reliable "boot the
  whole generated server under plain Node" story. Fixing it is small and
  mechanical (explicit field declarations are semantically identical to
  parameter properties — no runtime behavior changes), but it is a change to
  a stable, unconditional (every generated project, flag on or off) emitter
  with its own snapshot/fixture surface — a correctly-scoped follow-up in
  its own right, not something to fold into a Node-debug-wiring slice
  silently. See Follow-ups.
- **No forced claim that `npm run debug` boots a real server today.** For any
  system with a valueobject that's constructed at a runtime boundary (the
  common case — Money is the standing example throughout this repo's
  fixtures), `npm run debug` / the launch config will hit
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in `value-objects.ts` before serving a
  request. This is now an HONEST, informative failure (Node's own error
  names the exact file/line/construct), a strict improvement over today's
  status quo (no native Node debug path exists at all), but it is not "fully
  works" — this doc says so plainly rather than shipping a doc that implies
  otherwise.
- **No DAP adapter.** Phase 8's actual `ddd-dap` workspace (breakpoint set
  in `.ddd`, adapter remaps to the generated position) is unbuilt — this
  slice only proves and wires the substrate it would sit on for the node
  target.

## Fan-out plan

- **Value-object constructor rewrite** — **DONE (slice 2, Milestone 19).**
  `emit/value-objects.ts` now emits explicit field declaration + constructor
  assignment instead of TS parameter properties, unconditionally.
- **Repository/reader/persistence-adapter constructor rewrite** — **RESOLVED
  (slice 3, Milestone 20).** The same parameter-property shape lived in
  `src/generator/typescript/repository-builder.ts` and its
  `-document`/`-embedded`/`-eventsourced` siblings, `base-reader-builder.ts`,
  and `emit/mikroorm.ts` (`constructor(private readonly db: Db, private
  readonly events: DomainEventDispatcher) {}`). Unlike the VO gap, these ARE
  on the request-handling load path (every route touches a repository), so
  this was the ACTUAL remaining blocker to a full generated node server
  booting cleanly under plain Node's type stripping. Same mechanical
  low-risk rewrite; deserves its own review pass for the same reason the VO
  rewrite did.
- **Playwright page-object constructor rewrite** — **RESOLVED (slice 3,
  Milestone 20).** These are test-only `.ts` files under `e2e/pages/`, never
  on a server boot path: `src/generator/_frontend/page-objects-builder.ts`
  and its siblings (plus the elixir backend's
  `src/generator/elixir/page-objects-emit.ts` and the shared
  `api/api-client.hbs` / `sveltekit/api-client.hbs` `ApiError` class) emitted
  `constructor(public readonly page: Page) {}`. Matters because the strip-
  erasable tripwire (`test/generator/typescript/strip-erasable-constructors.test.ts`)
  now covers every emitted `.ts`/`.tsx` file, not just `domain/`.
- **.NET debug config** (`launch.json` `type: "coreclr"` against the
  already-shipped `#line` → PDB weave, phase 6a) — later slice, same
  `.vscode/launch.json` file, additional configurations.
- **JVM debug config** (`type: "java"`, attaching via JDWP against the
  already-shipped JSR-45 SMAP injection, phase 6b) — later slice, same file.
- **Full `ddd-dap` adapter** (phase 8's actual north star: breakpoints set
  directly in `.ddd`, remapped by the adapter to the generated position via
  the same source-map/SMAP/`#line` substrate every earlier phase built) —
  the "Large effort" item the phase table names; this slice's job was
  de-risking the JS leg of it, which it did.
- **VS Code manual confirmation** (Phase A finding 4's open item): drive an
  actual `js-debug` session against the emitted `.map`, set a breakpoint on
  a `.ddd` line, confirm it resolves — needs an interactive VS Code
  environment this sandbox doesn't have.
