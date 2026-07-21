# Flutter target — parity audit &amp; gap-fill plan

> Status: **AUDIT + PLAN (2026-07-20).** The Flutter frontend ships far more than
> its own banners claimed (forms, workflows, `match await`, Riverpod state,
> user components, a real `composeService`, three build surfaces). This doc is
> the **code-verified ground-truth map** of what remains, plus a phased,
> agent-pickable gap-fill plan. It was written after a stale "native is
> deferred / composeService is a stub" comment caused a real misread; the
> docs-truthfulness half shipped in **#2185**, this is the engineering half.
>
> Live gap-scan tool: `src/generator/flutter/parity.ts` (`analyzeFlutterParity`).
> Feature reference: [`docs/generators.md`](../../generators.md) → "Flutter mobile".
> Missions are tracked in [`docs/new-plan/T1-ui-frontend.md`](../../new-plan/T1-ui-frontend.md).

## Why this doc exists

Flutter is a `WalkerTarget` seam (`flutterTarget`, `flutter-target.ts`) riding the
shared `walkBody` engine, exactly like Feliz. The display path, forms, workflows,
`match await`, Riverpod state/actions, and user components all emit real Dart;
`composeService` (`src/platform/flutter.ts`) is shape-identical to Feliz's real
web service; the one Dart source builds **web / Android / iOS** from its
`Makefile`. What's left is a specific, bounded set of gaps — but several of them
are **silent** (content vanishes from the output with no diagnostic), which is
the worst failure mode for a codegen target and the reason this needs a plan
rather than ad-hoc fixes.

The governing distinction throughout:

- **SILENT gap** — valid `.ddd` compiles, but a construct is dropped from the
  emitted Dart with no marker. The user sees a missing widget/field, not an
  error. **Highest priority — these lose work invisibly.**
- **LOUD gap** — the emitter renders a diagnostic comment (`/* … */` or
  `// TODO(flutter …)`) in place of the widget. Visible, and `parity.ts` catches
  most of them.
- **HONEST gap** — a `loom.*` validator warns/errors at compile time. The user
  is told up front.

## Ground-truth parity map

| # | Area | Evidence (file:line) | Gap type | vs React / Feliz |
|---|------|----------------------|----------|-------------------|
| G1 | **Standalone input/interactive primitives** — `Field`, `NumberField`, `PasswordField`, `MultilineField`, `SelectField`, `Toggle`, `FileUpload`, `Tabs` | `pack.ts:448-457,524`; `required-primitives.ts:143-155` (`FLUTTER_INLINE_OR_DEFERRED`) | **SILENT** to tooling (pack emits a `//` line comment invisible to the parity lint) | React (Mantine) + Feliz (daisyUI) render all; flutter pack is display-only |
| G2 | **Form-field silent drops** — nested-VO sub-fields, mixed VO-arrays, enum/bool/datetime/id element arrays, `File` fields | `forms-emit.ts:239,271-274,290-301,303-304` | **SILENT** (field omitted, no marker; admitted at `forms-emit.ts:35-36`) | — |
| G3 | **Auth gate** — `page { requires … }`, `currentUser`, action-level gates | `flutter-target.ts:289` (deferred comment); `riverpod-emit.ts:106` (`authUi: false` hardcoded) | **SILENT** (predicate + forbidden view + action hiding simply not rendered) | Feliz has `auth-gate.ts` (`renderFelizGate`, `CurrentUser` decoder, `forbiddenView`, `opActionGate`) |
| G4 | **Realtime** — `on <channel>.<Event>` handlers | no `flutter/realtime.ts`; `system-checks.ts:219-225` (`loom.ui-realtime-unsupported`) | **HONEST warn → then SILENT drop** | Feliz has `realtime.ts` (EventSource + toast + refetch) |
| G5 | **Parity lint blind spots** | `parity.ts:17-20,86-88` | tooling gap — lint sees `/* … */` + `// TODO(flutter…)` only, so it misses **both** G2 (silent form drops) **and** the G1 pack `// flutter pack: no renderer` line | Phoenix's gaps are frozen by `heex-parity.test.ts`; flutter has **no** parity-freeze test |
| G6 | **No native CI gate** — `apk`/`ipa` never compiled | `.github/workflows/generated-flutter-build.yml` (web only) | verification gap | — |
| G7 | **No runtime / e2e gate** — flutter absent from `frontend-fullstack-e2e.yml` + `behavioral-ui-e2e.yml`; no `integration_test`/`WidgetTester` run | grep: no flutter in either workflow | verification gap | react/vue/svelte/angular/feliz all have an e2e gate |
| G8 | **No Dart method-call seam** — `recv.member(args)` rendered JS-style verbatim | `walker-core.ts:1472`; `dart-expr.ts:31-68` (no `lambda` leaf, no method-call arm) | **potential SILENT divergence** (bounded — frontend page bodies reach a small method set) | Feliz has `renderFsMethodCall` (`fs-expr.ts:109-147`, maps `.contains`/`.toUpper`, throws on unknown) |
| — | composeService | `flutter.ts:37-46` (≈ `feliz.ts:32-41`) | **NONE (shipped)** — stub comment was stale, fixed in #2185 | — |
| — | Form field kinds (9), `match await`, `state :=`, user components | `forms-emit.ts:85-94`; `riverpod-emit.ts:217-310,161-206`; `flutter-target.ts:395` | **NONE (shipped, LOUD on mis-shape)** | — |

## The plan

Phased so each mission is independently landable and the earlier phases make the
later ones cheaper (Phase 1 turns silent gaps loud → Phase 2 can measure them →
Phase 4 can verify them). Priority follows the failure-mode severity: **silence
before loudness before absence.**

### Phase 1 — Stop the silent drops (P1, the data-loss class)

The unifying fix: **every drop must leave a marker.** A silent omission is a cache
with no invalidation story — the emitter that forgets it is the bug.

- **M-A · Emitter markers for every form-field drop (G2).** `S`. In
  `prepareFields` (`forms-emit.ts`), replace each `continue`/`break`-and-skip with
  an emitted `// TODO(flutter form-field): <field> (<reason>)` line on the form
  widget, so the drop is visible in the Dart **and** parseable by the parity lint.
  No new rendering — just make the existing gaps loud. Unblocks measuring G2.
- **M-B · Standalone input primitives → real widgets, or a loud marker (G1).**
  `M`. Give the flutterMaterial pack renderers for `Field`/`NumberField`/
  `PasswordField`/`MultilineField`/`SelectField`/`Toggle`/`Tabs` (Material
  `TextField`/`Switch`/`DropdownButton`/`TabBar` — the form emitter already builds
  these widgets, so it's mostly extraction). `FileUpload` depends on M-T1.2
  slice 4 (the cross-frontend upload primitive) and is deferred to it. Until a
  renderer lands, change `pack.ts:524`'s `//` line to the `/* … */` form the
  parity lint recognizes.
- **M-C · Auth gate parity (G3).** `M`. Port Feliz's `auth-gate.ts` to Dart: a
  `CurrentUser` provider, a `requires`-predicate forbidden view, and op-action
  gating. Flip `riverpod-emit.ts:106` `authUi` from a hardcoded `false` to the
  real signal. This is the largest Phase-1 item and the one users hit on any
  authenticated app.

### Phase 2 — Make the parity lint honest (P1, unblocks everything)

- **M-D · Parity lint sees silent + pack gaps (G5).** `S`. Teach
  `analyzeFlutterParity` to recognize (a) the pack `// flutter pack: no renderer
  for "X"` line and (b) the Phase-1 `// TODO(flutter form-field:…)` markers, and
  update its LIMITATION note. After M-A/M-B this makes the lint a true coverage
  gauge.
- **M-E · Flutter parity-freeze test (G5).** `S`. Add
  `test/generator/flutter/parity-freeze.test.ts`, the analogue of
  `heex-parity.test.ts`: emit a fixture exercising the full primitive set, assert
  the exact set of primitives that still fall back, and pin each with a reason.
  A new gap then fails CI until it's rendered or explicitly pinned — turning the
  parity gap from silent drift into a reviewed decision.

### Phase 3 — Realtime + expression seam (P2)

- **M-F · Flutter realtime consumption (G4).** `M`. Add `flutter/realtime.ts`
  (an SSE `EventSource`-equivalent on `package:http`/`dart:html` → toast +
  Riverpod refetch), and add `flutter` to `SSE_REALTIME_FRONTENDS`
  (`system-checks.ts`) so the `loom.ui-realtime-unsupported` warning stops
  firing. Feliz's `realtime.ts` is the template.
- **M-G · Dart method-call seam (G8).** `S`, verify-first. Confirm the divergence
  is real (audit flagged it low-confidence — page-body method calls are a small
  set and share walker territory). If real, add a Dart method-call arm mirroring
  `renderFsMethodCall`. If the reachable method set turns out already-correct,
  close with a pinned test instead of code.

### Phase 4 — Verification gates (P2, prerequisite to trusting the above)

> **DECISION (pinned 2026-07-20, maintainer-signed): per-PR CI covers only what
> runs on a plain Linux runner. "Full mobile CI" is explicitly out of scope.**
> The verification surface is a ladder, not a single gate — two rungs are cheap
> and land per-PR, two are expensive and stay deferred:
>
> | Gate | Runner | Cadence | Why |
> |---|---|---|---|
> | `flutter analyze` + `flutter build web` | Linux | per-PR (shipped) | baseline "is the Dart real" |
> | `flutter build apk` (compile only) | Linux | **per-PR (M-H)** | native-compile regressions; SDK installs on Linux, no device |
> | `flutter_test` `WidgetTester` smoke (headless runtime) | Linux | **per-PR (M-I)** | genuine "does it boot &amp; render" **without an emulator** |
> | `flutter build ios --no-codesign` | macOS | 🌙 nightly at most | needs a macOS runner (~10× cost); no real IPA without signing |
> | on-device `integration_test` | emulator / macOS | ❌ deferred | slow, flaky, device-farm cost — the classic infra-noise red build |
>
> Rationale: Android build + the headless widget-test harness together close
> most of the G6/G7 hole entirely on Linux. iOS build (macOS cost) and real
> on-device e2e (emulator flakiness) buy little per-PR signal for a lot of cost
> and infra risk, so they are a documented "not now," not an oversight.

- **M-H · Android native build gate (G6).** `M`. Add a `flutter build apk` job to
  `generated-flutter-build.yml` (or a sibling) over the showcase — `flutter-action`
  installs the Android SDK on the existing **Linux** runner, then `make prepare`
  (`flutter create --platforms=android`) + `make apk`. Compile-only, no device.
  **Android only** per the decision above; iOS is the pinned macOS/nightly
  follow-up. Catches native-only regressions the web gate is blind to.
- **M-I · Flutter headless runtime gate (G7).** `M` (reduced from `L` by the
  decision — the on-device `integration_test` half is deferred, leaving only the
  headless smoke). Emit a `flutter_test` `WidgetTester` smoke (boot the app,
  assert it renders) run under plain `flutter test` on the **Linux** runner — no
  emulator. This is the genuinely-deferred item from
  `flutter-mobile-implementation.md` Phase-2 step 3, scoped down to what runs
  device-free. It is the only path to "does the Flutter app actually RUN," not
  just compile. Full on-device / `frontend-fullstack-e2e.yml` inclusion stays out
  of scope per the decision.

## Sequencing &amp; dependencies

```
Phase 1 (M-A → M-B → M-C)  ── makes gaps LOUD
        │
Phase 2 (M-D, M-E)         ── makes gaps MEASURED  (needs Phase 1 markers)
        │
Phase 3 (M-F, M-G)         ── new consumption paths (independent)
        │
Phase 4 (M-H, M-I)         ── VERIFIES the above    (Linux-only per the pinned decision)
```

M-A is the cheapest and unblocks the measurement story; do it first. M-B and M-C
are the visible user payoff. M-D/M-E lock the ceiling so it can't silently
regress. Phase 4 is the standing safety net — both gates run device-free on the
existing Linux runner (iOS + on-device e2e are pinned out of scope, see the
Phase 4 decision block).

## Open questions (maintainer decisions)

1. **`FileUpload` on Flutter** — fold into M-T1.2 slice 4 (the cross-frontend
   upload primitive), or a Flutter-specific slice? (Recommend: fold in — the wire
   `FileRef` is already frozen and shared.)
2. ~~**iOS CI** — macOS runner or Android-only?~~ **RESOLVED (2026-07-20):**
   per-PR CI is Linux-only (Android `build apk` + headless `flutter_test`); iOS
   build is nightly-macOS at most and on-device e2e is deferred. See the Phase 4
   decision block.
3. **M-G scope** — worth a seam, or is the reachable frontend method set small
   enough to pin-and-close? Needs the verify-first audit before committing code.
4. **Realtime transport on Flutter (M-F)** — `dart:html EventSource` (web-only) vs
   a `package:http` streamed-response reader (works on native too). The mobile
   axis argues for the latter; confirm before building.

## Superseded / corrected docs

- `docs/old/proposals/flutter-mobile-frontend.md` and
  `docs/old/plans/flutter-mobile-implementation.md` carry stale "not
  implemented / not started" status headers — corrected to point here (the
  build shipped; only Phase-2 runtime e2e + native CI remain).
- The web-side reference (`docs/generators.md`, `docs/platforms.md`) and the code
  banners were corrected in #2185.
