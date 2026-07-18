# Flutter — mobile as a new development axis

> Status: **NOTE (exploratory).** Nothing here is implemented. This scopes
> **Flutter** as Loom's first *mobile* target and argues it is a **new axis
> of development**, deliberately **outside the T10 web-target-matrix freeze**
> ([`../../new-plan/T10-new-targets.md`](../../new-plan/T10-new-targets.md)) —
> not a 6th SPA frontend competing in the frozen roster. The interesting
> work is **neither the emitter** (the shared `walkBody` engine already drives
> a non-JSX target — Feliz) **nor the grammar** (it comes to ~two enum values —
> §4); it is the **composer/deployment layer**: one `platform: flutter`
> deployable emits *per-surface* (a served web bundle *and* native artifacts
> that join no network), which `src/system/` has never modelled.
> Sibling of [`angular-frontend.md`](./angular-frontend.md) and
> [`blazor-server-frontend.md`](./blazor-server-frontend.md) (the non-JSX
> `WalkerTarget` precedents); its true novelty is closer to
> [`deployable-networking.md`](./deployable-networking.md) — a new
> deployment-unit *shape*.

## TL;DR

1. **Mobile is a genuinely new quadrant**, not a flavour — a native app
   artifact (APK/IPA), app-store bound, device-resident, talks to a backend
   over the wire. You want **exactly one** mobile target (RN *and* Flutter
   would be the Kotlin-plus-Java mistake).
2. **Flutter over React Native** — short rationale in §1. Both clear the
   "new quadrant" bar; Flutter is the more *coherent* codegen target and the
   better type-fit for Loom's payload unions.
3. **It sits outside the T10 freeze legitimately** (§2): the freeze exists
   to bound the per-*backend* emit treadmill (~37–70 files of
   entity/schema/repo/routes + re-mirrored authorization-filter sentinels, a
   cross-tenant-leak risk). A mobile **client** re-lands *none* of that — it
   runs no domain logic, owns no DB, has no per-tenant query filter. Its cost
   profile is a *frontend's*, not a backend's.
4. **The emitter is cheap, and so is the grammar** (§3–§4). One
   `FlutterWalkerTarget` on the shared engine + a Dart wire-model emitter is
   well-trodden. The **grammar delta is two enum values** (`framework:
   flutter`, `platform: flutter`) — app identity, permissions, and native-vs-
   web all **derive/reuse/defer** rather than adding syntax (§4). The real
   novelty is in the **composer/deployment semantics**: one `platform:
   flutter` deployable emits *per-surface* (served web bundle + native
   artifacts), which `src/system/` has never modelled.

## 1. Flutter vs React Native — the short version

RN's pull is real and I won't wave it away: RN is TypeScript, so it **reuses
the entire non-visual substrate** already shared across the JSX frontends
(`src/generator/_frontend/` — zod wire models, menu derivation, the API
client) and the state/`match` logic. That is more code-reuse than Flutter,
which re-emits all of it in Dart.

But RN **forks the entire *visual* layer**: its primitives are a different
vocabulary (`<View>`/`<Text>`/`<TextInput>`/`<FlatList>`, and bare strings
throw — all text must be `<Text>`-wrapped), its styling is not CSS
(`StyleSheet` is a flexbox-only subset, camelCased, numeric), and **the
design packs don't port** (Mantine/shadcn/MUI/Chakra are CSS component libs).
So RN's mobile output is the *least idiomatic, least polished* target Loom
could ship — a StyleSheet-and-pack-assembly job — and the shared substrate is
a *coupling* that pulls RN-specific quirks (AsyncStorage vs localStorage,
`fetch`/`URL` polyfills) *upward* into a layer web depends on, against Loom's
one-directional rule.

**Flutter wins on coherence and fit**, which is what a codegen target should
optimise:

- **Material is built in** — Loom's "looks good for free" promise holds on
  mobile out of the box; the design-pack axis collapses to one Material pack
  (Cupertino later), no CSS.
- **Dart 3 `sealed` + exhaustive `switch`** maps onto Loom's payload unions +
  the `match` primitive *better than any current frontend* — this is the
  single strongest fit argument:

  ```
  // .ddd
  match cmd {
    Approve       => "approved"
    Reject r      => "rejected: " + r.reason
  }
  ```
  ```dart
  // generated Dart 3 — exhaustive, compiler-checked
  switch (cmd) {
    Approve()             => 'approved',
    Reject(:final reason) => 'rejected: $reason',
  }
  ```
- **`flutter analyze`** is a strict static gate ≈ the existing per-frontend
  `tsc --noEmit` / `vue-tsc` legs — it slots straight into the CI model.
- **Total separation** (Dart, no `_frontend/` reuse) is *architecturally
  cleaner* than RN's shared-substrate coupling, even though it is more code.

**Decision: Flutter.** Pick RN only if maintainer economy is the dominant
constraint (one TS wire/state layer serving web *and* mobile, debuggable by
whoever reads the React output) — a defensible but different objective.

## 2. Why this is outside the T10 freeze

The 2026-07-17 freeze closed the **web target matrix** because each new
*backend* re-lands the largest un-abstractable emit surface
(entity/schema/repository/routes, per-ORM, ~37–70 files) **and** re-mirrors
every authorization-filter sentinel by hand — an unbounded treadmill with a
silent cross-tenant-leak tail (see
[`../../audits/direction-review-2026-07.md`](../../audits/direction-review-2026-07.md)).

A mobile client incurs **none** of that cost:

| Freeze cost driver | Mobile client |
|---|---|
| Per-ORM entity/schema/repo/routes emit | none — no DB, no ORM |
| Authorization-filter sentinels re-mirrored | none — no query filter surface |
| Migration emission (`MigrationsIR` ×N) | none — consumes the wire |
| Domain logic (`render-expr`/`render-stmt`) | none — renders `wireShape` only |

Mobile's cost profile is a **frontend's** (a `WalkerTarget` + a pack + a
wire-model emitter), and its *value* is a **new deployment axis** the web
matrix never covered. That is precisely the "add a paradigm, not a flavour"
test — so it belongs on its own track, not as a T10 line item. (If adopted,
T10 should gain a one-line pointer noting mobile is a separate axis, not a
reopening of the web-frontend roster.)

## 3. Architecture fit — cheap emitter, one real new seam

**Reuses (proven):**

- **`walkBody` + a `FlutterWalkerTarget`.** The scariest assumption — "a
  widget tree isn't JSX, so it needs a forked engine like HEEx" — is **false**.
  `src/generator/feliz/feliz-target.ts` already rides the shared `walkBody`
  emitting a *function-call tree* (`Html.div [ …; prop.children [ … ] ]`),
  which is structurally identical to Flutter's `Column(children: [ … ])`.
  Flutter is a `WalkerTarget` like Feliz, **not** a parallel engine like
  Phoenix/HEEx. The primitives map onto Material 1:1 —

  ```
  // .ddd
  page TaskList area Tasks { List of Task { column Title; column Done } }
  ```
  ```dart
  // generated
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Tasks')),
    body: ListView.builder(
      itemCount: tasks.length,
      itemBuilder: (_, i) => ListTile(
        title: Text(tasks[i].title),
        subtitle: Text(tasks[i].done ? 'Done' : 'Open'),
      ),
    ),
  );
  ```
  `List`→`ListView.builder`, `Detail`→`Column`/`ListTile`, `Form`→`Form`+
  `TextFormField`+`GlobalKey<FormState>`, `Button`→`ElevatedButton`,
  `Card`→`Card`, `Toolbar`→`AppBar`, `Heading`→`Text(style: …)`, `match`→
  Dart `switch`, lambdas→Dart closures, `state := …`→Riverpod
  `ref.read(x.notifier)` (Feliz already proved the walker handles a non-
  `setState` state model).
  - ⚠️ **Naming collision to guard:** Loom `Stack` = vertical layout →
    Flutter `Column`. Flutter's *own* `Stack` widget is z-overlap; the target
    must never emit `Stack` for Loom `Stack`.
- **`agg.wireShape`** — consumed by a Dart model emitter (`fromJson`/`toJson`
  via `json_serializable`) exactly as the zod emitter consumes it; no
  re-resolution. Dart 3 `sealed class`es carry the discriminated payload
  unions.

**Genuinely new (the cost is here, not the emitter):**

- **Testing.** Playwright page-objects + the smoke spec don't transfer —
  Flutter uses `flutter_test`/`integration_test` with `WidgetTester`. The
  `test e2e` dispatch (`api` vs `ui`→Playwright) needs a third arm:
  `ui`-against-Flutter → `integration_test`.
- **The deployment unit** — see §4; this is the real novelty.

## 4. The language layer — smaller than it looks

An earlier draft of this note invented three new constructs — an `output:`
mode, an `app { … }` identity block, and a `capabilities: […]` permission
list. **All three are un-Loomish and are retracted.** Held against Loom's own
conventions (derive-don't-stamp, platform-neutral IR, reuse existing slots,
add as few keywords as possible), the mobile grammar delta collapses to **two
enum values**; everything else derives, reuses, or defers. This *sharpens* the
thesis rather than weakening it: the real novelty is in the **composer /
deployment semantics** (§4d), not in new surface syntax.

**(a) Page content — reused wholesale.** `ui`, pages, and the primitive
library are device-agnostic; the walker handles the Dart output. `framework:
flutter` (one `Framework` enum value) is the only addition, and it's the same
slot `react`/`vue`/`svelte`/`angular`/`feliz` already occupy.

**(b) The deployment unit — `platform: flutter`, one enum value.** The one
genuinely-new *fact* is that a `platform: flutter` deployable produces
**per-surface output**: the web surface is a served bundle (like `platform:
static` — joins the stack), the native surfaces (iOS/Android/desktop) are
build artifacts (join no network). That native-vs-served split is **derived by
the composer from the platform**, not chosen by an `output:` toggle — Flutter
is *one source → all surfaces*, so a mode knob would stamp a fact the platform
already implies. Surface *narrowing* (ship iOS only) is a deferred refinement,
and a list when it lands — never a native/web boolean.

**(c) App identity — derived, not declared.** None of it needs a block:
- **icon** → the existing **`favicon:`** clause on `deployable` (already
  present). Not new.
- **display name** → derived from the deployable/ui name (`naming.ts`
  title-cases everywhere already).
- **bundle id** → defaults `com.example.<system>.<deployable>` (reverse-DNS
  convention). The *only* external datum is the DNS root — an optional,
  **system-level `namespace:`** that isn't even mobile-specific (it would
  inform JVM/.NET package names too), not a per-mobile-unit block.
- **version** → not in `.ddd` at all; a release concern, injected at build
  time (`ddd generate … --app-version`). Keeping non-domain metadata out of
  the DSL is the Loomish call.

**(d) Device permissions — derived from use, not a declared list.** A
`capabilities: […]` clause fails twice: it **collides** with Loom's existing
`capability` concept (the pure-mixin domain capabilities — `auditable` /
`tenantOwned`, applied via `with` / `implements`), *and* naming
`camera`/`location`/`push` in the source **leaks OS specifics into the
platform-neutral IR**. The Loomish treatment: the source names a *neutral
intent* (a page *captures a photo*), and the **Flutter target** maps that to
`NSCameraUsageDescription` / `<uses-permission>` / the plugin dep — the DSL
never spells an OS permission. Permissions are therefore **derived from
device-feature use**. And since the primitive library is closed with **no
device primitives today**, **v1 has no permission surface at all** — the
question only arises if/when a `Capture`-style primitive is proposed, and then
it is derivation in the target, not a list in the source.

**Explicitly deferred (scope control, not oversight):**

- **Offline / local persistence + sync.** The deepest divergence from web:
  Loom assumes the UI reaches the domain *over the wire* (online). Offline-
  first (local SQLite/Drift store + conflict resolution + sync) is a **whole
  architectural axis**, not a knob. **v1 is online-only, exactly like the web
  frontends.** The biggest *future* language-layer question — not a v1 blocker.
- **Push notifications.** A natural consumer of domain events — hook the
  existing eventing/dispatch surface ([`channels.md`](./channels.md),
  [`dispatch-delivery-semantics.md`](./dispatch-delivery-semantics.md))
  rather than inventing grammar. Out of v1.
- **Mobile navigation** (stack/tab/drawer vs URL routes) most likely reuses
  `area` with a mobile interpretation (areas → bottom tabs); revisit only if
  it doesn't map.

### Surface sketch (concrete)

The whole surface: **two enum values plus one reused clause.** No `output:`,
no `app { … }`, no `capabilities:`.

```
// page content: the existing ui surface, verbatim
ui TasksApp {
  framework: flutter            // enum add #1: Framework += 'flutter'
  page TaskList area Tasks { List of Task { column Title; column Done } }
}

deployable TasksMobile {
  platform: flutter             // enum add #2 — ONE source → ALL surfaces
  targets: ApiGateway           // reused (wire binding)
  ui: TasksApp                  // reused (ui binding)
  favicon: "assets/icon.png"    // reused → becomes the app icon
}
```

**What the composer/target derives from this (no extra source):**

- `platform: flutter` → a Flutter project emitting **every surface**: `flutter
  build web` (served bundle, joins the stack) **and** `flutter build apk` /
  `ipa` / desktop (artifacts, no `docker-compose.yml` service). The
  native-vs-served split is derived, not declared.
- **bundle id / display name** → derived from the system + deployable names
  (`com.example.<system>.tasksmobile`, "Tasks Mobile"); **version** injected at
  build time; **icon** from the reused `favicon:`.
- **permissions** → none in v1 (no device primitives to derive from); a future
  `Capture`-style primitive would let the Flutter target derive
  `NSCameraUsageDescription` / `<uses-permission>` — the source stays neutral.

**Grammar deltas (the entire list):**

| Surface | Grammar change | Enforcement |
|---|---|---|
| `framework: flutter` | `Framework += 'flutter'` | — |
| `platform: flutter` | `Platform += 'flutter'` | `checkDeployable` (`deployable.ts`) — the `'react'`/`'phoenixLiveView'` pattern |
| *(optional, non-mobile-specific)* `namespace:` on `System` | one clause on `System` | reverse-DNS default; informs package/bundle ids across targets |

Everything mobile beyond these lives in the **Flutter generator + the composer
per-surface logic** — not the grammar.

## 5. A first slice

**Flutter *web*, Material pack only, Riverpod state, `match`→Dart-3 `switch`,
one example × the Material pack through `flutter analyze` + `flutter build
web`.** Flutter web *is* a served static bundle, so it slots into the existing
composition model and defers the two hardest new bits — the native-artifact
deployment unit (§4a) and the `integration_test` runtime gate (§3) — to slice
2. That proves the `FlutterWalkerTarget` + Dart wire-model + `flutter analyze`
gate end-to-end before any grammar change lands.

**Open decisions to pin before slice 2:** the composer's per-surface emission
model (§4b/§4d — served web bundle *and* native artifacts from one `platform:
flutter` deployable), the reverse-DNS bundle-id default vs an optional
system-level `namespace:` (§4c), and where the Dart wire-model emitter lives (a
Dart sibling of `_frontend/`, since it can't share the TS one).
