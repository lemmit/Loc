# Testing Flutter in the playground — parity lint (shipped) + real-Flutter preview (proposal)

> Status: **PARTIAL.** Tier A (the **Flutter parity lint**) is **SHIPPED** —
> `src/generator/flutter/parity.ts` (`analyzeFlutterParity` / `flutterParitySummary`),
> browser-safe, tested. Tier C (real `flutter build web` preview via a compile
> service) is the design below; it is the *only* path to pixel-perfect Material
> in-browser and is a backend project, not a slice. Tier B (a React structural
> proxy) is **rejected** — it can never be pixel-perfect (it renders Mantine, not
> Flutter), so it fails the "only if pixel-perfect" bar.

## The problem

The playground bundles + boots generated projects **entirely client-side**:
`esbuild-wasm` bundles the emitted TS/JS in a Worker, PGlite runs the Hono
backend in-process, and it renders in an iframe. That pipeline is a **JavaScript
toolchain**. Flutter emits **Dart**, and:

- There is **no in-browser Dart→JS compiler** (unlike esbuild-wasm for JS/TS);
  `dart2js` / the Dart front-end are Dart programs, not a browser library.
- `flutter build web` needs the **Flutter SDK** — a native, multi-GB toolchain
  that only runs on a host.

So a Flutter app cannot be compiled or run in the browser the way a React app is.
Even DartPad compiles Flutter **server-side**. "Real Flutter in the browser"
therefore *requires a compile server* — that part is a genuine constraint, not a
choice.

## Tier A — parity lint (SHIPPED)

The cheap, client-side, high-value check answers the question users actually
have: **"will my `.ddd` FULLY lower to Flutter, or hit a fallback?"** Every
Flutter fallback is a diagnostic the emitters already write — a `/* … */` block
comment (`flutterTarget.renderComment`: a deferred user component `unknown layout
component: <name>`, a mis-shaped `Modal`/`Action`/`WorkflowForm`, …) or a `//
TODO(flutter …)` line (a store-action call, an unsupported action statement).

`analyzeFlutterParity(files)` scans the emitted Dart VFS for those markers and
attributes each to its source construct (`page Edit`, `components`, `forms`);
`flutterParitySummary(files)` rolls them into a badge (`fullyRenders`, counts by
kind). It uses the **generator as the source of truth** — scanning emitted output
rather than re-deriving fallback conditions (which would rot). Pure + browser-safe.

**Playground wiring (the remaining Tier-A step):** the playground already produces
the generated file map for the file-tree view. For a `framework: flutter`
deployable, pass that map to `flutterParitySummary` and render a "Flutter
coverage" panel — green "fully renders on Flutter" or a list of findings linking
`file:line` → source construct. A few lines in the pipeline reducer + a small
panel component; no backend.

**Known limitation:** this catches the LOUD fallbacks (those that emit a marker).
A few gaps drop content SILENTLY (a form field of an unsupported kind is omitted
with no marker). Fixing that is an emitter-side change — emit a marker on the drop
— after which this pass sees it for free. Tracked as a follow-up.

## Tier B — React structural proxy (REJECTED)

Because Flutter is a WalkerTarget clone of the same `ui` IR that React renders, the
playground *could* preview the same `ui` through the existing React harness (a
phone-framed iframe) as a proxy for flow/behavior. It reuses 100% of the current
pipeline and needs no backend. **But it renders Mantine components, not Material-
Dart widgets — it is structurally faithful and visually wrong.** Under a
"pixel-perfect with real Flutter" requirement it does not qualify, so it is not
pursued. (Recorded here so the option — and why it was declined — is on the record.)

## Tier C — real `flutter build web` via a compile service (proposal)

The only path to pixel-perfect Material in-browser: run the user's actual compiled
Dart. We already do this exact compile in CI (`generated-flutter-build.yml`); this
exposes it interactively.

### 1. Compile microservice
- Container: Flutter SDK (pinned to the emitted `pubspec` env) + a pub cache
  **pre-populated** with exactly the deps the generator emits (`flutter_riverpod`,
  `http`) + `flutter precache --web`. Per-build: no network, no `pub get`.
- `POST /build` ← the generated project VFS (the file map `generate()` already
  produces) → `flutter build web --release` in an ephemeral, network-isolated
  workdir → returns the `build/web` output.
- Sandbox each build (fresh workdir, resource + time limits, no egress). The
  user's Dart runs in the *client* iframe; the server only compiles.

### 2. Caching (what makes it usable, not painful)
- Key = **content-hash of the generated project** (deterministic from `.ddd` +
  generator version). Unchanged model → serve the cached bundle instantly; you
  pay the compile only when the emitted Dart actually changes.
- The **engine/CanvasKit assets are identical across every build** → serve those
  from a fixed CDN path, never rebuild. Only `main.dart.js` (the app) is per-
  project, so the cached artifact is small.
- First compile ~30–90s; every hit after is instant. A warmer variant — a per-
  session `flutter run -d web-server` daemon — gives sub-second hot-restart after
  the first compile, at the cost of a stateful per-user process.

### 3. Client wiring
- A "Preview: Flutter (real)" button beside the current preview. Click → POST the
  VFS, honest spinner ("compiling Flutter — first build ~1 min, instant when
  cached") → load the returned bundle in a **phone-framed iframe**. Genuine
  `flutter build web` ⇒ pixel-perfect.
- **The integration catch — the API bridge.** The emitted app makes real `http`
  calls to `API_BASE_URL` (already a `--dart-define` we emit). To keep it live,
  register a **service worker** in the iframe scope that intercepts `/api/*` and
  proxies to the **same in-browser PGlite+Hono backend** the React preview uses
  (via `postMessage`). This is the one genuinely new piece of engineering.

### 4. Deploy / ops
- Container behind an autoscaling endpoint (Cloud Run / Fly / k8s), min-1 warm to
  hide cold-start, rate-limited, cache-first. Graceful fallback to Tier A (+ the
  React proxy if it were ever built) when the service is unavailable, so the
  static playground never hard-breaks.

### Honest cost
- You now **own a backend** — the playground stops being a pure static site.
- ~30–90s first compile (mitigated by hashing + the warm-daemon option).
- The service-worker API bridge is real work.
- Sandbox/security + autoscaling cost for public use.

### DartPad note
DartPad *is* "Tier C as a service" (the open-source `dart-services` backend), so
it proves feasibility — but it enforces a curated **package allowlist** (no
arbitrary `pub add`) and is effectively single-file. Our multi-file project with
real deps would need flattening + dep-trimming to ride DartPad, or we stand up our
own `dart-services` with our package set. Either way it's the same backend
commitment.

## Recommendation

Ship **A** (done) and wire its playground panel. **Skip B** (fails the pixel-
perfect bar). Treat **C** as a discrete backend project to fund when a live
Material preview is worth owning a compile service for — the architecture above is
ready to pick up. CI already guarantees "the Dart compiles," so A + the CI gate
cover correctness today; C only adds interactive Material pixels.

## Pointers

- Parity lint: `src/generator/flutter/parity.ts`; tests `test/generator/flutter/parity.test.ts`.
- The fallback markers it scans: `flutterTarget.renderComment` (`src/generator/flutter/flutter-target.ts`), the `// TODO(flutter …)` lines (`src/generator/flutter/riverpod-emit.ts`), the shared `unknown layout component` fallback (`src/generator/_walker/walker-core.ts`).
- CI compile we already run: `.github/workflows/generated-flutter-build.yml`.
- Playground pipeline the wiring plugs into: `web/src/pipeline/`, `web/src/preview/`.
