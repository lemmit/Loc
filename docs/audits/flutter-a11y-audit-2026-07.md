# Flutter accessibility audit — 2026-07

> Status: **empirical pass — 2026-07-29.** Answers one question the
> [accessibility mission (M-T1.12)](../new-plan/T1-ui-frontend.md) leaves
> open for the **sixth** frontend: **does the Flutter target actually emit the
> a11y semantics the per-primitive contract declares, and is any of it gated?**
>
> Read against `main` @ `bab550b`. Every claim below was re-derived from the
> code on fresh `main`; the emitted-Dart column was **reproduced with the CLI**
> (`ddd generate system` → the Dart in §4). **When this prose and the cited
> lines disagree, the code wins.**
>
> Sibling reading: [`accessibility.md`](../old/proposals/accessibility.md) (the
> proposal), [`frontend-parity-audit-2026-07.md`](frontend-parity-audit-2026-07.md)
> (the general frontend-parity pass — a11y is out of its scope), and
> [`flutter-parity-and-native-gates.md`](../old/proposals/flutter-parity-and-native-gates.md)
> (the Flutter parity plan — a11y is not on it).

## Headline

Flutter has **partial, author-hint-only accessibility, and zero automated
coverage.** Of the *underivable* a11y facts a human supplies, three of four are
wired — `Image` alt → `semanticLabel`, `Icon` label → `semanticLabel`, `Button`
label → `Semantics` — but `Avatar` alt is dropped. And every *derived
whole-structure* obligation the contract declares — heading semantics, the
`Toolbar` accessible name, the `Loader` status role, the `Alert` live region —
is **silently dropped** on Flutter, because Flutter renders through its own
procedural pack (`src/generator/flutter/pack.ts`) that never received the
Slice 1–7 emit work the JSX/markup/HEEx targets did. And **no gate can see
it**: Flutter is absent from the axe CI matrix (`generated-a11y.yml`), from the
cross-pack render guard (`a11y-contract-cross-pack.test.ts`), and has no
Semantics unit tests of its own.

The gaps are **not** WCAG failures the user authored — they are floor-clearing
semantics the compiler emits *for free on the other five frontends* and drops
on the sixth. That is exactly the silent-drop class the Flutter parity plan
prioritises, applied to accessibility.

## 1 — Why Flutter is structurally different for a11y

The a11y machinery the other frontends share does not reach Flutter, by
construction:

| Layer | JSX / markup / HEEx (5 frontends) | Flutter |
|---|---|---|
| Contract SSOT | `src/generator/_walker/a11y.ts` (`A11yObligation` on every `PrimitiveDef`) | same — framework-neutral, so it *applies* |
| Emit helper | `src/generator/_walker/a11y-emit.ts` renders HTML-ish ARIA fragments (` role="…" aria-label="…"`) that every JSX/markup/HEEx pack splices verbatim | **not consumed** — Dart is not HTML, so the string fragments are meaningless |
| Rendering | Handlebars/JSX design packs under `designs/` | a **procedural** `LoadedPack` — `pack.ts`'s `RENDERERS` map, Dart-emitting functions |
| a11y idiom | ARIA attributes (`role`, `aria-label`, `aria-live`, `aria-busy`, `aria-invalid`) | Flutter **`Semantics(...)`** widget + widget-native props (`semanticLabel`, `excludeFromSemantics`) |

Consequences that shape the rest of this audit:

- **The walker still hands Flutter the derived a11y context.** `emitToolbar`
  (`primitives/layout.ts:294`) computes `a11yAttr: toolbarA11yAttr(...)`;
  `emitButton` (`primitives/controls.ts:170`) computes `ariaLabel`; `emitIcon`
  (`primitives/icon.ts`) passes `label`/`decorative`. Flutter's pack receives
  every one of these ctx fields — it just **reads some and ignores others**
  (§3). The information is present at the emit site; the drop is in `pack.ts`.
- **axe-core cannot audit Flutter.** axe walks a live DOM. A Flutter-web build
  renders to a CanvasKit `<canvas>` with an off-screen semantics overlay that
  axe does not traverse as ARIA — so the `generated-a11y.yml` tripwire the
  proposal leans on is structurally unavailable here. Flutter's equivalent is
  the framework's own **`SemanticsTester`** / `meetsGuideline(...)` in a
  `flutter_test`, which the repo does not emit or run.

## 2 — Method

Audited the same four layers as the frontend-parity pass, a11y-scoped:

1. **Contract** — `_walker/a11y.ts`: the obligation each primitive declares.
2. **Emit** — `flutter/pack.ts` `RENDERERS` (+ the whole-primitive overrides in
   `flutter/flutter-target.ts`, `flutter/forms-emit.ts`): what Dart each emits,
   and whether it clears the obligation.
3. **Ground truth** — a scaffold page exercising the a11y-bearing primitives,
   run through `ddd generate system` for a `platform: flutter` deployable; the
   emitted `product_list_page.dart` is quoted verbatim in §4.
4. **Gates** — `generated-a11y.yml`, `a11y-contract-cross-pack.test.ts`,
   `test/generator/flutter/*` for any Semantics assertion.

## 3 — The obligation → emit matrix

Every primitive carrying an `A11yObligation`, its contract, the Dart Flutter
emits, and the verdict. Line numbers are `src/generator/flutter/pack.ts`
unless noted.

| Primitive | Contract (`a11y.ts`) | Flutter emit | Verdict |
|---|---|---|---|
| **Image** | `needsAlt` | `Image.network(src, semanticLabel: alt)` — `primitiveImage:360` | 🟢 **wired** (alt → `semanticLabel`) |
| **Icon** | `decorativeByDefault`, `needsName` | `label`+non-decorative → `Icon(..., semanticLabel: label)`; decorative → bare `Icon` (Material auto-excludes from semantics) — `primitiveIcon:376` | 🟢 **wired** |
| **Button** | `role: button, needsName` | `label:` → `Semantics(label: …, child: ElevatedButton(...))` — `primitiveButton:439` | 🟢 **wired** |
| **Avatar** | `needsAlt` | `CircleAvatar(radius, backgroundImage: NetworkImage(src))` — **`alt` ctx ignored** — `primitiveAvatar:367` | 🔴 **alt dropped** — the image has no accessible name; the JS/markup packs honour `alt` on `Avatar` |
| **Toolbar** | `role: toolbar, needsName` | bare `Row(...)` — **`a11yAttr` ctx ignored** — `primitiveToolbar:175` | 🔴 **name dropped** — no `role="toolbar"` / `aria-label` equivalent |
| **Heading** | `headingLevel: derive` | `Text(text, style: textTheme.<level>)` — style only, **no `Semantics(header: true)`** — `primitiveHeading:188` | 🔴 **not a heading to AT** — screen-reader heading navigation lost |
| **Alert** | `role: alert, live: assertive` | bare bordered `Container(...)` — **no `Semantics(liveRegion: true)`** — `primitiveAlert:261` | 🔴 **not announced** — async status is silent |
| **Loader** | `busy` / status | `CircularProgressIndicator()` — **no `Semantics(label:'Loading', …)`** — `primitiveLoader:281` | 🔴 **silent spinner** — the raw JS packs emit `role="status" aria-label="Loading"` |
| **Skeleton** | `busy` | bare `Container(height:96,…)` — no busy/hidden semantics — `primitiveSkeleton:276` | 🟡 **minor** — decorative placeholder, ideally `excludeSemantics` + an ancestor `aria-busy` analogue |
| **Divider** | `role: separator` | `const Divider()` — Material `Divider` carries separator semantics | 🟢 **free from framework** |
| **Anchor / IdLink** | link name | `TextButton(onPressed: nav, child: Text(label))` — button semantics + name from the child `Text` | 🟢 **free from framework** |
| **Field** (forms) | `labelled: associate` | Material `TextFormField(decoration: InputDecoration(labelText: …))` + validator error text — `forms-emit.ts:871` | 🟢 **label + error announced by framework** (no explicit `aria-invalid`/`describedby` needed — Material wires it) |
| **Modal** | `modal`, `focus: trap-restore` | `showDialog(...)` / `AlertDialog` — Material traps + restores focus, `aria-modal` equivalent native | 🟢 **free from framework** |
| **App shell** | landmarks (`header`/`nav`/`main`) + skip link | `Scaffold(appBar: AppBar(...), body: …)` — `flutter/index.ts:342,451,713` | 🟡 **partial** — Scaffold/AppBar give a header/body split for free; there is no landmark-nav or skip-link concept on a mobile target (arguably N/A), but nothing is *derived* from the page's `Section`/named-layout structure the way the web shell is |

**The pattern:** the 🟢 rows are either (a) the author-hint trio Flutter's
`pack.ts` explicitly reads (`Image`/`Icon`/`Button`), or (b) Material widgets
that carry semantics natively (`Divider`, links, forms, `Modal`). Every 🔴 row
is a **derived** obligation whose emit work (Slices 1–7 of M-T1.12) landed on
the string-fragment targets and never reached the procedural Dart pack.

## 4 — Ground truth (emitted Dart)

`ddd generate system` on a scaffold page exercising the a11y primitives
(`platform: flutter`), `app/lib/pages/product_list_page.dart`, verbatim:

```dart
Text('Products catalogue', style: Theme.of(context).textTheme.headlineMedium),   // Heading level 1 — no Semantics(header:true)
Text('Featured', style: Theme.of(context).textTheme.titleLarge),                 // Heading level 2 — no Semantics(header:true)
Container(width: double.infinity, padding: const EdgeInsets.all(12),
  decoration: BoxDecoration(border: Border.all(color: Colors.green), …),
  child: Column(… children: <Widget>[Text('Prices updated')])),                  // Alert — no liveRegion
Image.network("/logo.png", semanticLabel: "Shop logo"),                          // 🟢 alt wired
CircleAvatar(radius: 20, backgroundImage: NetworkImage("/u.png")),               // 🔴 alt "Owner avatar" dropped
Icon(Icons.circle, size: 20.0, semanticLabel: 'Featured'),                       // 🟢 label wired
Icon(Icons.circle, size: 20.0),                                                  // decorative — auto-excluded (ok)
Semantics(label: 'Refresh products', child: ElevatedButton(onPressed: null, child: Text('Refresh'))), // 🟢 label wired
const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),        // 🔴 Loader — silent
Container(height: 96, decoration: BoxDecoration(color: …surfaceContainerHighest, …)),                 // 🟡 Skeleton
```

(The `Icons.circle` placeholder for every named icon is a *separate* known
gap — `pack.ts:376` `TODO(flutter full-parity): map the icon name to Icons.*` —
not an a11y finding; the `semanticLabel` wiring on top of it is correct.)

## 5 — Gate coverage: none

| Gate | Covers Flutter? | Evidence |
|---|---|---|
| `generated-a11y.yml` (axe-core) | ❌ | matrix is 11 JSX/markup packs + `feliz`; `grep -c flutter` → 0. Structurally can't (canvas render). |
| `a11y-contract-cross-pack.test.ts` | ❌ | `PACKS` list excludes the two non-Handlebars targets (Feliz, Flutter); `grep -c flutter` → 0 |
| `generated-a11y-e2e.test.ts` | ❌ | has a `feliz` profile; no `flutter` profile |
| `test/generator/flutter/*` | ❌ | 25 suites, **none** assert a `Semantics(`/`semanticLabel:` emit |

So the three 🟢 rows that *do* work (Image/Icon/Button) are also **unpinned** —
a refactor of `pack.ts` could drop them with zero CI signal, exactly the
contract↔emit drift the M-T1.12 audit called out for the JSX targets, still
live for Flutter.

## 6 — Correction to the mission record

[`docs/new-plan/T1-ui-frontend.md`](../new-plan/T1-ui-frontend.md) M-T1.12
describes Slices 1–3 as landing "mechanical ARIA **across all 6 targets**"
(icon/toolbar/skeleton). For Flutter this is **half true**: the icon `label`
reached `pack.ts` (via the shared ctx), but the **Toolbar accessible name and
the Loader status role did not** — `primitiveToolbar`/`primitiveLoader` ignore
the a11y ctx entirely. The "6th target" in those slices is the string-fragment
consumer set; the procedural Dart pack was not actually updated. The mission
line should be narrowed to "5 JSX/markup/HEEx targets + the Feliz F# leaf
table", with Flutter tracked as an open follow-up (this audit).

## 7 — Recommendations (phased, Flutter-idiomatic)

All fixes are localized to `src/generator/flutter/pack.ts` (+ tests); none
touch the framework-neutral contract, which is already correct. The idiom is
**wrap-in-`Semantics`**, the Dart twin of adding an ARIA attribute.

**Phase A — clear the 🔴 derived drops (the priority, silent class):**
1. `primitiveHeading` → wrap the styled `Text` in `Semantics(header: true, child: …)`. (Derived level already drives the text style; `header: true` is the AT signal.)
2. `primitiveAlert` → wrap in `Semantics(liveRegion: true, container: true, child: …)` so the callout announces on insertion (contract `live: assertive`).
3. `primitiveLoader` → `Semantics(label: 'Loading', liveRegion: true, child: CircularProgressIndicator())` — the `role="status"` twin.
4. `primitiveToolbar` → read the `label`/`a11yAttr` ctx (as `primitiveButton` already reads `ariaLabel`) and wrap the `Row` in `Semantics(container: true, label: '<name>', child: …)`.
5. `primitiveAvatar` → thread the `alt` ctx (already passed) into `Semantics(label: alt, image: true, child: CircleAvatar(...))`, matching `primitiveImage`.

**Phase B — pin what exists so it can't regress:**
6. A `test/generator/flutter/a11y.test.ts` asserting the `Semantics(`/`semanticLabel:` emit per primitive — the Flutter analogue of the per-pack a11y unit tests. This is the only gate Flutter can realistically carry (axe is out).
7. Optionally add Flutter to `a11y-contract-cross-pack.test.ts` via a Dart-shaped assertion set (it currently early-outs on non-Handlebars packs), so contract/caller drift is caught centrally.

**Phase C — runtime (optional, heavier):**
8. Emit a `flutter_test` using `SemanticsTester` / `meetsGuideline(textContrastGuideline, labeledTapTargetGuideline)` over the scaffold pages, run in `generated-flutter-build.yml` (which already boots a headless `flutter test` per M-T1.18 Phase 4). This is the closest Flutter analogue to the axe tripwire.

Phase A is small and self-contained (five wraps + tests), removes the entire
silent-drop set, and is the natural next slice of M-T1.12 — it brings the
sixth frontend up to the floor the other five already clear.

## Appendix — reproduction

```bash
# The scaffold used in §4 (Heading×2, Alert, Image+alt, Avatar+alt, Icon+label,
# Icon decorative, Button+label, Loader, Skeleton) on a platform: flutter
# deployable, then read app/lib/pages/product_list_page.dart.
node bin/cli.js generate system <scaffold>.ddd -o out
sed -n '/class ProductListPage/,/^}/p' out/app/lib/pages/product_list_page.dart
```
