# Flutter mobile — implementation plan

> Status: **MOSTLY DONE (updated 2026-07-20).** The "not started" note is stale:
> Phase 0, all five Phase-1 tracks (A wire-model, B target, C pack, D riverpod,
> E composer), and Phase-2 steps 1–2 (`index.ts` wiring +
> `generated-flutter-build.yml`) shipped. Genuinely still deferred: Phase-2
> step 3 (`integration_test` / `test e2e` third arm) and the native (apk/ipa) CI
> surface — both tracked in
> [`../proposals/flutter-parity-and-native-gates.md`](../proposals/flutter-parity-and-native-gates.md).
> Turns
> [`../proposals/flutter-mobile-frontend.md`](../proposals/flutter-mobile-frontend.md)
> into a slice-by-slice build with an **agent-swarm execution strategy**.
> Grounded in a four-agent recon of the actual seams (Nov 2026): the
> `PlatformSurface`/compose mechanics, the `WalkerTarget` checklist + Feliz
> precedent, the design-pack/required-emit system + CI, and the validator/IR
> foundation touchpoints. Nothing here is merged yet.

## 0. The one-paragraph shape

Flutter is **structurally a Feliz clone**: a non-JSX, function-call-tree
(`Column(children: […])` ≈ Feliz's `Html.div [ prop.children [ … ] ]`),
non-JS-embedded-language target that rides the shared `walkBody` engine through
a `WalkerTarget` seam object — it does **not** add a column to
`WALKER_PRIMITIVES`; it reuses the `tsx` renderers and diverges purely through
seams. So the emitter is well-trodden. The genuinely-new work is in three
places: (1) a **Dart** wire-model + Riverpod projector (nothing in
`src/generator/_frontend/` transfers — it's all TS emitters), (2) the
**composer** must learn to emit a deployable that produces artifacts and joins
no network (today every deployable becomes a compose service, no opt-out), and
(3) verification is **CI-only for the Dart compile** (no Flutter SDK locally).

## 1. Dependency DAG — what gates what

```
Phase 0  FOUNDATION (sequential, blocks everything)
  grammar enums → langium:generate+commit → validator → Platform IR type
  → platform surface/registry/metadata/dispatch → generator skeleton
  → FlutterWalkerTarget interface STUB → 1 example .ddd → golden test
        │
        ▼   (defines every interface Phase 1 codes against)
Phase 1  FAN-OUT (swarm — 5 tracks, each owns DISJOINT files)
  A  Dart wire-model emitter        flutter/dart-model-emit.ts, flutter/wire.ts
  B  flutterTarget WalkerTarget     flutter/flutter-target.ts, flutter/dart-expr.ts
  C  flutterMaterial pack           designs/flutterMaterial/**, required-primitives.ts(+flutter)
  D  Riverpod state/effect projector flutter/riverpod-emit.ts
  E  composer per-surface + opt-out  platform/flutter.ts, system/index.ts(servesNoRuntime), pubspec/build
        │
        ▼   (integrate: index.ts wires A–E; enable in registry)
Phase 2  INTEGRATION & GATES (sequential)
  flutter/index.ts orchestrator wiring → generated-flutter-build.yml (SDK+analyze+build web)
  → integration_test emitter + `test e2e` third arm → example matrix → docs
```

**Why the shape:** Phase 0 is an inherent bottleneck — it defines the
`FlutterWalkerTarget` interface and the `flutter/index.ts` stub that every
Phase-1 track imports, so it *cannot* be parallelized. Once the stubs exist,
Phase 1's five tracks touch **disjoint files** and run in true parallel. Phase 2
re-serializes to wire them together and add the SDK-gated CI.

## 2. Phase 0 — Foundation (one careful agent, or inline)

*Verifiable entirely by `npm test` — no Flutter SDK needed. Touches committed
generated files, so it must land as one coherent, green commit before fan-out.*

**Copy Feliz, not react/angular — everywhere.** Flutter is not a vite static
bundle; Feliz is the exact structural template (self-hosting, own build,
absent from `STATIC_BUNDLE_FRAMEWORKS`/`FRONTEND_GENERATORS`, dispatches
directly through its own `emitProject`).

| Step | File(s) | Edit |
|---|---|---|
| Grammar enums | `src/language/ddd.langium` (L375, L386) | `Framework += 'flutter'`; `Platform += 'flutter'` (before `STRING`) |
| Regenerate | `src/language/generated/{grammar,ast}.ts` | `npm run langium:generate` + **commit** (`grammar.ts` changes; `ast.ts` likely no diff since both rules `return string`; gated by `langium-generated.yml`) |
| IR Platform union | `src/ir/types/loom-ir.ts` (L2945-2956) | `+ "flutter"`. **No `Framework` union exists** — framework flows as free-form `uiFramework?: string` (L3047), no edit |
| Validator menu (real gate) | `src/language/validators/data/platform-rules.ts` | `FRONTEND_KEYWORDS += "flutter"` (L34-41 — makes `platform: flutter` a legal bareword); `expectedFrameworkFor` flutter arm (L110-128, copy the feliz line); `expectedPackFormatFor` → leave `undefined` for flutter (Feliz-style — `design:` isn't a pixel-pack menu) |
| Validator (cosmetic only) | `src/language/validators/deployable.ts` (L77, L247) | add `flutter` to the hardcoded platform lists in the two error strings — the menu itself is table-driven, no structural change |
| Descriptor (**forced**) | `src/platform/metadata.ts` `PLATFORM_DESCRIPTORS` (L152) | new `flutter` entry (copy feliz L204-212): `isFrontend:true, mountsUi:true, needsDb:false, defaultPort:3006, hostableFrameworks:new Set(["flutter"])`. **Not** added to `STATIC_BUNDLE_FRAMEWORKS` (`surface.ts` L39-45) |
| Platform surface | `src/platform/flutter.ts` (**new**) | copy `feliz.ts` wholesale; `emitProject → generateFlutterForContexts`; `composeService` (web surface) may stub in foundation |
| Registry (**forced**) | `src/platform/registry.ts` (import + L60) | `flutter: flutterPlatform` (non-partial `Record` → adding to the `Platform` union forces this) |
| Lowering | `src/ir/lower/lower-deployment.ts` (L53-68, L84-119) | add a `flutter` arm to the `uiFramework` fallback ladder; make the `design` default return **`undefined`** for flutter (else it wrongly defaults to `mantine`) |
| Format registry | `src/util/builtin-formats.ts` | `PackFormat += "flutter"` (l.32); `BUILTIN_PACK_FORMATS["flutterMaterial@v1"]="flutter"`; `BUILTIN_PACK_LATEST.flutterMaterial="v1"` — *only if a pack ships in foundation; else defer to Track C* |
| Generator skeleton | `src/generator/flutter/index.ts` (**new**) | `generateFlutterForContexts(...) → Map<path,content>`: minimal project + **stubbed calls** to the A–E modules; export the `FlutterWalkerTarget` interface stub |
| Example + golden test | inline `.ddd` (Feliz model) + `test/generator/flutter/skeleton.test.ts` (**new**) | one aggregate + a `node` backend + a `platform: flutter` frontend + one page; assert the emitted tree (`pubspec.yaml`, `lib/main.dart`). **Don't** reuse a 200-line showcase |

**No edit needed** (recon-confirmed): `src/system/index.ts` (dispatch is by
platform *surface* at L474/L488, generic), `src/ir/enrich/enrichments.ts`
(frontend context-inheritance is platform-generic → Flutter gets it free from
`isFrontend:true`), `src/platform/frontend-dispatch.ts` +
`STATIC_BUNDLE_FRAMEWORKS` (Flutter isn't a static bundle — Feliz-model direct
dispatch), `PLATFORM_SAVING_SHAPES`/`BACKEND_ADAPTER_METADATA` (partial Records,
frontend has no persistence/adapters). **Verify** `src/language/print/print-structural.ts`
(mentions feliz; likely platform-string-generic — confirm no flutter branch
needed). **Pinning tests to satisfy:** `descriptor-consistency.test.ts`
(descriptor ≡ live surface); `frontend-dispatch.test.ts` won't trip (Flutter
joins neither map).

**Exit gate:** `npm test` green; `node bin/cli.js generate system <inline>.ddd
-o /tmp/out` produces a project tree. No Dart compiled yet (no local SDK).

## 3. Phase 1 — Fan-out tracks (swarm; disjoint file ownership)

Each track owns its files, writes its own `test/generator/flutter/*.test.ts`
string-assertion tests, and self-verifies with `npm test`. Because ownership is
disjoint, worktree changes **union cleanly** — that is the entire reason the
decomposition is by-file, not by-feature.

**Track A — Dart wire-model emitter.** Consumes `agg.wireShape` /
`wire-projection` / `unions` exactly as `zod-schemas.ts` does, emits Dart:
`class`es with `fromJson`/`toJson` (`json_serializable`), `sealed class` +
Dart-3 `switch` for discriminated payload unions, id/VO/event/DTO models.
Owns `flutter/dart-model-emit.ts`, `flutter/dart-types.ts`.

**Track B — `flutterTarget: WalkerTarget`.** The seam object (model:
`feliz/feliz-target.ts`). Required seams: `renderStateRead/Write/NestedWrite`,
`defaultInitFor`, `renderNavigate`, `buildHookUse`/`renderApiCall`/
`renderApiHoisting`, `renderMatch`/`renderMatchChild`, the markup seams
(`renderComment/Interpolation/AttrBinding/ConditionalChild/StyleAttr/
escapeText/renderForEach`), plus the **seven whole-primitive overrides**
(`renderCreateForm/OperationForm/DestroyForm/WorkflowForm/Modal/Action/
UserComponent` — Flutter owns these like Feliz, the shared RHF/JSX path is
meaningless in Dart), plus a **`DART_LEAVES`** expression table
(`exprLiteral/Binary/Unary/Ternary/Convert/List/Object` — no JS fallback).
Skip Feliz's offside/`oneLine` (Dart isn't whitespace-sensitive). Owns
`flutter/flutter-target.ts`, `flutter/dart-expr.ts`.

**Track C — `flutterMaterial` design pack.** Procedural pack (Feliz model —
emit Dart widget trees, not `.hbs` strings) OR Handlebars (loader supports
both); **procedural recommended** for a widget-tree language. Provide the
`flutter` required-emit set (clone `angular`: display primitives, forms inline,
`pubspec` shell in place of `package-json`/`vite-config`). Owns
`designs/flutterMaterial/v1/**`, the `flutter` block in `required-primitives.ts`
(coordinate with Phase 0 stub), and `flutter/pack.ts` if procedural. Gate:
`test/platform/flutter-pack-groundwork.test.ts` (mirror
`angular-pack-groundwork.test.ts`).

**Track D — Riverpod state/effect projector.** The `update-emit.ts` analogue.
The view seams (Track B) emit reads + intent; this projects `state{}` + named
`action`s + `match await` async effects into a `Notifier`/`AsyncNotifier`
(recommended: inert writes + Notifier methods, the Elmish pattern Feliz uses —
keeps the view pure). Owns `flutter/riverpod-emit.ts`, `flutter/collect.ts` (or
reuse the neutral `collectPage*` logic).

**Track E — composer per-surface + artifact opt-out.** The system-layer
novelty. `platform/flutter.ts` `composeService` for the **web** surface (served
bundle, `flutter build web` Dockerfile). Introduce a `servesNoRuntime`
descriptor flag consulted at `system/index.ts:587` (`renderDockerCompose`
loop) so **native** surfaces emit a build target, not a compose service; audit
`frontendOrigins` (l.531) so a native `isFrontend` target doesn't pollute CORS.
Emit `pubspec.yaml` + per-surface build scripts. Owns `src/platform/flutter.ts`
(composeService half), `src/system/index.ts` (the flag + loop guard),
`flutter/project-files.ts` (pubspec/build).

## 4. Phase 2 — Integration & gates (sequential)

1. **Wire `flutter/index.ts`** — enable the A–E modules (remove Phase-0 stubs),
   assemble per-page `walkBody(page.body, flutterTarget, flutterPack(), …)` +
   the Riverpod projector output. Full `npm test`.
2. **`generated-flutter-build.yml`** — clone `generated-feliz-build.yml` (the
   SDK + inline-`.ddd` shape, not the vite matrix): swap `setup-dotnet` →
   `subosito/flutter-action` (**new dependency — add it**), `dotnet fable` →
   `flutter analyze`, `vite build` → `flutter build web`. `paths:` scope to
   `src/generator/flutter/**`, `src/generator/_walker/**`, `designs/flutterMaterial/**`,
   `src/platform/{flutter,metadata,registry}.ts`, `src/util/builtin-formats.ts`,
   the grammar, the test. **This is the load-bearing compile gate** (see §6).
3. **`integration_test` emitter + `test e2e` third arm** — reimplement the
   Playwright page-objects/smoke (`_frontend/*page-object*`, `smoke-spec.ts`) as
   `flutter_test`/`WidgetTester`; the `test e2e … against <flutter-deployable>`
   dispatch lowers to `integration_test`, not Playwright.
4. **Example matrix + docs** — flip the proposal status; add `docs/generators.md`
   / `docs/platforms.md` rows.

## 5. Agent-swarm execution strategy

**The decomposition IS the parallelism.** By-file ownership (§3) means
worktree diffs union without conflict, so Phase 1 is a clean fan-out. Phase 0
and Phase 2 are irreducibly sequential.

**Recommended first run — the walking skeleton, not full parity.** Prove the
whole pipe end-to-end on the smallest surface before committing the big
fan-out: Phase 0 + a thin Track A (id/VO/aggregate models) + a thin Track B
(List/Detail only) + a thin Track C (Material pack, display primitives) + Track
E web-surface only, all `npm test` green. Defer forms/workflows/match-await,
native surface, and the CI SDK gate to run 2.

### The Workflow script (Phase 0 → parallel Phase 1 → Phase 2)

```js
export const meta = {
  name: 'flutter-target',
  description: 'Build the Flutter mobile target: foundation → fan-out → integration',
  phases: [
    { title: 'Foundation' }, { title: 'Fan-out' }, { title: 'Integration' },
  ],
}

// Phase 0 — sequential, on the shared base. Gate: npm test green.
phase('Foundation')
const foundation = await agent(FOUNDATION_PROMPT, {
  label: 'phase0:foundation', schema: DONE_SCHEMA,
})   // writes grammar+generated+validator+platform+skeleton+stub+example+golden test

// Phase 1 — 5 disjoint-file tracks in isolated worktrees (diffs union cleanly).
phase('Fan-out')
const TRACKS = [
  { key: 'A-wire',     prompt: TRACK_A },   // flutter/dart-model-emit.ts, dart-types.ts
  { key: 'B-target',   prompt: TRACK_B },   // flutter/flutter-target.ts, dart-expr.ts
  { key: 'C-pack',     prompt: TRACK_C },   // designs/flutterMaterial/**, pack.ts
  { key: 'D-riverpod', prompt: TRACK_D },   // flutter/riverpod-emit.ts, collect.ts
  { key: 'E-composer', prompt: TRACK_E },   // platform/flutter.ts, system/index.ts, project-files.ts
]
const tracks = await parallel(TRACKS.map(t => () =>
  agent(t.prompt, {
    label: `phase1:${t.key}`, phase: 'Fan-out',
    isolation: 'worktree',            // disjoint files → trivial union merge
    schema: TRACK_RESULT_SCHEMA,      // { files:[{path,sha}], testCmd, testPassed, notes }
  })))

// (Between phases: collect the worktree diffs, union-apply to the base, npm test.)

// Phase 2 — sequential integration on the merged tree.
phase('Integration')
const integrated = await agent(INTEGRATION_PROMPT, {
  label: 'phase2:integrate', schema: DONE_SCHEMA,
})   // wire index.ts, generated-flutter-build.yml, integration_test, docs
return { foundation, tracks, integrated }
```

**Honest caveats on the swarm (do not skip these):**
- **Merge is union, not auto.** The Workflow returns agent *results*, not merged
  commits. Because Track ownership is disjoint, applying each worktree's diff to
  the base is a no-conflict union — but it's a **deliberate collect+apply step**
  between phases, done by the driver, not magic. If two tracks ever need the
  same file (e.g. both touch `required-primitives.ts`), that file belongs to
  exactly one track (Phase 0 stubs it) — never split a file across tracks.
- **No local Dart compile.** Every track self-verifies with `npm test` (string
  assertions on emitted Dart), which is real but *not* a compile check. The only
  gate that proves the Dart is valid is `generated-flutter-build.yml` in CI
  (§6). Budget for a "CI said the Dart doesn't analyze" fix loop after Phase 2.
- **Phase 0 is not swarmable.** Resist the urge to fan it out — it defines the
  interfaces the swarm imports. One careful agent (or the driver inline).

## 6. Verification strategy

| Layer | How | Where |
|---|---|---|
| Generator logic (emitted-string shape) | `npm test` — `test/generator/flutter/*.test.ts` | **local**, every track |
| Pack load + required-emit set | `test/platform/flutter-pack-groundwork.test.ts` (pure TS) | **local** |
| Platform/registry/descriptor wiring | `descriptor-consistency.test.ts`, `frontend-dispatch.test.ts` | **local** |
| **Generated Dart actually compiles** | `flutter analyze` + `flutter build web` | **CI only** (`generated-flutter-build.yml`; no SDK in dev env) |
| Runtime (widget smoke) | `integration_test` via `WidgetTester` | **CI** (run 2) |

The local `npm test` tier catches ~everything about *what strings we emit*; the
"is the Dart real" question is structurally CI-only until/unless a Flutter SDK
is provisioned in the dev environment.

## 7. Risks & open decisions

1. **State-write model (Track B/D).** Inert view writes + Riverpod Notifier
   methods (Elmish-style, Feliz precedent — recommended) **vs** direct
   `ref.read(p.notifier).state = …`. Pin before Track B/D start.
2. **`match await` → Riverpod async.** How async effects map onto
   `AsyncNotifier`. Feliz collects these separately (`collectPageAsyncEffects`);
   mirror that in Track D.
3. **Pack: procedural vs Handlebars.** Procedural (Feliz `pack.ts`) recommended
   for widget-tree emission; Handlebars works but fights code output.
4. **Native-surface opt-out shape (Track E).** `servesNoRuntime` descriptor
   flag is the recommendation; confirm it composes with the `frontendOrigins`
   CORS filter without leaking a native target into the allowlist.
5. **`subosito/flutter-action`** is a new CI dependency — vet/pin it.
6. **Scope creep.** Feliz is ~6k LOC / 8 files; full-parity Flutter is a
   comparable band. The walking skeleton (§5) is the de-risking first milestone;
   do not fan out full parity before it's green.

## 8. Sequencing summary

1. Phase 0 (sequential) → green `npm test`, commit.
2. Walking-skeleton fan-out (thin A/B/C + E-web) → union-merge → green.
3. `generated-flutter-build.yml` → **first real Dart compile signal** → fix loop.
4. Full-parity fan-out (forms, workflows, match-await, unions) → merge → green.
5. Native surface (Track E artifact path) + `integration_test` gate.
6. Docs + status flip.
