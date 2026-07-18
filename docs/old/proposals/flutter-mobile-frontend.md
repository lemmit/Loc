# Flutter — mobile as a new development axis

> Status: **NOTE (exploratory).** Nothing here is implemented. This scopes
> **Flutter** as Loom's first *mobile* target and argues it is a **new axis
> of development**, deliberately **outside the T10 web-target-matrix freeze**
> ([`../../new-plan/T10-new-targets.md`](../../new-plan/T10-new-targets.md)) —
> not a 6th SPA frontend competing in the frozen roster. The interesting
> work is **not the emitter** (the shared `walkBody` engine already drives a
> non-JSX target — Feliz); it is the **language/deployment layer**: a native
> app is not a `docker compose` service, and the grammar has no word for it.
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
4. **The emitter is cheap; the language layer is the work** (§3–§4). One
   `FlutterWalkerTarget` on the shared engine + a Dart wire-model emitter is
   well-trodden. What's *new* is a **mobile deployment unit** the compose/k8s
   composer has never modelled, plus a small grammar surface for **app
   identity** and **device capabilities/permissions**.

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

## 4. The language layer — the part that needs design

This is where mobile stops being "another frontend." The **page-content
grammar is reusable wholesale** — `ui`, pages, and the primitive library are
device-agnostic; the walker handles the Dart output. The new surface is the
**deployment/device layer**, and it splits into one hard decision and two
small additions.

**(a) The deployment unit — the hard decision.** Every current `deployable`
composes into a `docker compose` service / k8s workload. A native app is a
**build artifact (APK/IPA) that joins no network** — it has no service, no
port, no place in `docker-compose.yml`. `src/system/` has never composed "a
unit that produces an installable artifact and participates in no stack." The
grammar needs a way to say it. Three shapes, in preference order:

1. **A `deployable` kind** — `deployable Mobile { kind: mobile, platforms:
   [ios, android], targets: Backend }`. Reuses the `targets:` wire-binding
   the SPA frontends already have; the composer learns one new kind that
   emits a build target instead of a service. *Recommended* — smallest
   grammar delta, largest reuse.
2. **A device-host** — extend the `embedded-frontend-composition` `hosts:`
   model with a "device host" (renders, serves nothing). Elegant if that
   proposal lands first; couples this to it otherwise.
3. **A new top-level `app` citizen** — cleanest conceptually, most grammar +
   IR + validator + composer surface. Reserve for if mobile grows a large
   dedicated feature set.

**(b) App identity — cheap declarative metadata.** `bundleId` /
`applicationId`, version + build number, display name, icon, splash, min OS.
Web bundles have none of this; native builds require all of it. A small
metadata block on the mobile unit, no semantics — low risk.

**(c) Device capabilities / OS permissions — the axis most deserving
dedicated grammar.** Camera, geolocation, biometrics, push, notifications,
file access are **OS-permission-gated** and flow into `Info.plist` /
`AndroidManifest.xml`; they are consent-relevant, not mere metadata. A
`capabilities: [camera, location, push]` surface (declared, or inferred from
primitive usage) is the one mobile concern that genuinely touches both the
page body and the generated native manifests — the strongest candidate for a
first-class grammar addition.

**Explicitly deferred (scope control, not oversight):**

- **Offline / local persistence + sync.** The deepest divergence from web:
  Loom assumes the UI reaches the domain *over the wire* (online). Offline-
  first (local SQLite/Drift store + conflict resolution + sync) is a **whole
  architectural axis**, not a knob. **v1 is online-only, exactly like the web
  frontends.** Flag it as the biggest *future* language-layer question, not a
  v1 blocker.
- **Push notifications.** A natural consumer of domain events — hook the
  existing eventing/dispatch surface ([`channels.md`](./channels.md),
  [`dispatch-delivery-semantics.md`](./dispatch-delivery-semantics.md))
  rather than inventing grammar. Out of v1.
- **Mobile navigation** (stack/tab/drawer vs URL routes) most likely reuses
  `area` with a mobile interpretation (areas → bottom tabs); revisit only if
  it doesn't map.

### Surface sketch (concrete)

`ui:` and `targets:` are **existing** clauses — only three things are new
(`framework: flutter`, `platform: flutter { output: … }`, and the mobile
metadata: `app`/`buildFor`/`capabilities`):

```
// page content: the existing ui surface, verbatim
ui TasksApp {
  framework: flutter                       // NEW #1: Framework += 'flutter'
  page TaskList area Tasks { List of Task { column Title; column Done } }
}

deployable TasksMobile {
  platform: flutter { output: native }     // NEW #2: Platform += 'flutter';
                                           //   realization axis  output: native | web
  targets: ApiGateway                      // REUSED: wire binding (existing clause)
  ui: TasksApp                             // REUSED: ui binding (existing clause)
  buildFor: [ios, android]                 // NEW #3a: native build targets

  app {                                    // NEW #3b: app-identity metadata
    bundleId:    "com.acme.tasks"
    displayName: "Acme Tasks"
    version:     "1.4.0"  build: 42
    icon:        "assets/icon.png"
  }

  capabilities: [camera, location, push]   // NEW #3c: OS permissions
}
```

**Refinement to §4a, driven by the repo's own *"derive, don't stamp"* rule:**
drop the `kind: mobile` field. "This is an artifact that joins no network" is
a pure function of `platform: flutter { output: native }`, so the composer
*derives* it (as page-kind is derived from name+area, not stamped). `output:
web` slots into the existing served-bundle model; `output: native` emits a
build target, no compose service.

**What each new clause generates:**

- `platform: flutter { output: native }` + `targets: ApiGateway` → a Flutter
  project + build script (`flutter build apk --dart-define=API_URL=…`; `ipa`
  for iOS; web build for `output: web`), **no `docker-compose.yml` service**.
- `app { … }` → `pubspec.yaml` (`version: 1.4.0+42`) + iOS `Info.plist`
  (`CFBundleIdentifier`/`CFBundleShortVersionString`/`CFBundleVersion`) +
  Android `build.gradle` (`applicationId`/`versionName`/`versionCode`). Pure
  metadata, cheap.
- `capabilities: [camera, location, push]` → the payoff line: one clause fans
  out to three files — `Info.plist` usage-description keys +
  `AndroidManifest.xml` `<uses-permission>` entries + the `pubspec.yaml`
  plugin deps (`camera`/`geolocator`/`firebase_messaging`).

**Grammar deltas (where each lands):**

| Surface | Grammar change | Enforcement |
|---|---|---|
| `framework: flutter` | `Framework += 'flutter'` | — |
| `platform: flutter` | `Platform += 'flutter'` | `checkDeployable` (`deployable.ts`) — the `'react'`/`'phoenixLiveView'` pattern |
| `output: native \| web` | new realization axis in the `platform { … }` sub-block (beside `persistence`/`directoryLayout`) | validator menu (the `design:` precedent — parser takes `LooseName`) |
| `buildFor: [ios, android]` | one order-independent clause on `Deployable` | validator: only meaningful when `output: native` |
| `app { … }` | new metadata block | validator: required when `output: native` |
| `capabilities: […]` | one order-independent clause | validator-enforced menu → manifest/plugin table |

**Open design call — declared vs inferred capabilities.** Spelled *declared*
here because the page-primitive library is closed and has no device
primitives today (nothing to infer from). If a `Capture`/scanner primitive
ever enters the walker, inference (`camera` auto-added when a page uses it)
becomes possible; until then, declared is the pragmatic v1.

## 5. A first slice

**Flutter *web*, Material pack only, Riverpod state, `match`→Dart-3 `switch`,
one example × the Material pack through `flutter analyze` + `flutter build
web`.** Flutter web *is* a served static bundle, so it slots into the existing
composition model and defers the two hardest new bits — the native-artifact
deployment unit (§4a) and the `integration_test` runtime gate (§3) — to slice
2. That proves the `FlutterWalkerTarget` + Dart wire-model + `flutter analyze`
gate end-to-end before any grammar change lands.

**Open decisions to pin before slice 2:** the deployment-unit shape (§4a — a
`deployable` kind is the recommendation), whether device capabilities are
declared or inferred (§4c), and where the Dart wire-model emitter lives (a
Dart sibling of `_frontend/`, since it can't share the TS one).
