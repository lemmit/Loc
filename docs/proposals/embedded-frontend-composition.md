# UI framework + hosting — decoupling the served UI from the backend platform

> Status: **proposal / problem-framing.** Nothing here is implemented. This
> note moves a UI's **framework and stack onto the `ui` declaration itself**, and
> makes **hosting** an explicit relation: a `deployable` *hosts* a `ui`, and a
> platform declares which UIs it *can* host. It replaces the current model where
> the UI framework is **derived from the backend platform** and the embed target
> is hardcoded to React. No new top-level declaration, no `family@version`
> machinery — a grammar-level reshape of the UI/host seam.

## TL;DR

Today a UI's framework is inferred from whatever backend happens to mount it
(`expectedFrameworkFor(dotnet, hasUi) → "react"`), the embed is hardcoded to
React inside the .NET generator, and `platform: react` secretly means
"React **built and served by Vite**." Three things that should be independent —
**what the UI is + how it's built**, and **who serves it** — are fused into the
backend platform.

Split them into two declarations:

```ddd
ui WebApp {
    framework: react           // react | liveview | (angular | vue …)
    design: mantine            // design pack
    stack: v3                  // react-dom 19 + react-router 7 + react-query 5
    page Orders { ... }        // the pages — unchanged
}

deployable Web { platform: vite,   hosts: WebApp, targets: Api }   // standalone
deployable Api { platform: dotnet, hosts: WebApp }                 // embedded (same grammar)
```

A `ui` is now the **buildable frontend artifact** (pages + framework + stack). A
deployable's platform is its **host**. Whether hosting is *standalone* or
*embedded* is **not a keyword** — it falls out of whether the host owns a backend
(`needsDb`): `vite`/`static` serve standalone and `targets:` a backend;
`dotnet`/`phoenix`/`hono` embed because they already run a server.

**Host-compatibility is principled, not a lookup table:** a host can serve a `ui`
**iff it provides the runtime that the ui's framework requires.** React compiles
to static assets → any static-capable host (Vite, static, dotnet `wwwroot`, hono,
Phoenix `priv/static`). LiveView is *not* a static bundle — it needs the Phoenix
runtime → **only Phoenix can host it.** That single rule explains "LiveView only
on Phoenix" and "React anywhere" without enumerating pairs.

We deliberately do **not** keep framework off `ui` to preserve "one page-set,
rendered as two frameworks." If that case ever arises, it's handled at the host
edge — **a deployable can `hosts:` more than one `ui`** — so the model extends
without reopening this decision (see §6).

## 1. Why today can't express this (the defect, briefly)

The framework is welded to the host at three layers — full line-numbered evidence:

- **Generator** (`dotnet/index.ts:274`) — calls `generateReactForContexts`
  unconditionally when `!!deployable.uiName`. No dispatch on a framework value.
- **Validator** (`platform-rules.ts:94`) — `expectedFrameworkFor(dotnet, ui)`
  returns `"react"`; Rule 13 (`deployable.ts:93`) *errors* on any other
  `framework:`. The `framework:` field is validated-against, never selects.
- **Grammar** (`ddd.langium:207`) — `Framework` is `react | phoenixLiveView`;
  no other token parses.

The shape of the model is the tell: `ui { }` is **already** a first-class
declaration, but only carries pages — framework/design/stack live on the
*deployable's* `ui:` binding (`UiBlockBinding`, `design:`, a derived stack). A
UI's technical identity is split across two declarations, with the deciding half
owned by the host. Folding framework/design/stack onto `ui` heals that split at
the source.

## 2. The model

### 2.1 Two things, two homes

| Concern | Owner | Example |
|---|---|---|
| **What the UI is + how it's built** (pages, framework, design, stack) | `ui { }` — *gains framework/design/stack* | `ui WebApp { framework: react, design: mantine, stack: v3, page … }` |
| **Who serves it** | `deployable { platform:, hosts: }` | `platform: vite` / `platform: dotnet` |

No separate `frontend` declaration: it would have been only a `ui` pointer plus
those three fields. The fields belong on `ui` directly.

### 2.2 Hosting is a relation, and embedded-vs-standalone is emergent

A deployable `hosts:` a `ui`. The host's **platform** decides *how*:

- **Standalone** — host owns no backend (`needsDb === false`). This is **exactly
  what `platform: react` / `platform: static` already do today** (and they are
  literally the same surface object — `registry.ts:36` aliases `static:
  reactPlatform`, zero behavioural difference): the deployable is built with
  `vite build` then served by `vite preview --host 0.0.0.0 --port 3000`
  (`dockerfile.hbs`), calling its backend **cross-origin** via a generated
  `VITE_API_BASE_URL` env pointing at the `targets:` deployable's port +
  `apiBasePath` (`react.ts:41`), with runtime overrides
  (`window.__LOOM_API_BASE__`, `import.meta.env`). The standalone host is,
  literally, **Vite's preview server over a built bundle** — no nginx, no dev
  server.
- **Embedded** — host owns a backend (`needsDb === true`): `dotnet` (`wwwroot/` +
  `MapFallbackToFile`), `phoenix` (`priv/static`), `hono` (static middleware). The
  *same* built bundle, dropped into the backend's static root; API base becomes
  **same-origin `/api`** (`dotnet/index.ts:274` passes `apiBaseUrl: "/api"`)
  instead of the cross-origin env.

The standalone path is therefore **unchanged behaviour** under this proposal —
the existing `react`/`static` Vite-preview host *is* the standalone host; only the
spelling moves (framework → `ui`, host platform named for what it is).

**No `hosting: embedded|standalone` keyword.** The split is a *derived* property
of the host platform — the `needsDb`/owns-a-backend flag the registry already
carries.

### 2.3 Host-compatibility is a capability, derived from runtime coupling

Replace the boolean `mountsUi` + the hardcoded `expectedFrameworkFor` with a
single capability on the host platform:

```ts
// PlatformSurface
readonly hostableFrameworks: ReadonlySet<Framework>;
```

Populated from a **principled** predicate, not hand-enumerated pairs:

| Framework | Output kind | Hostable by |
|---|---|---|
| `react` | static assets (`vite build` → `dist/`) | any static-capable host: `vite`, `static`, `dotnet`, `hono`, `phoenix` |
| `liveview` | **none — server-rendered, needs the Phoenix runtime** | `phoenix` **only** |
| `angular`/`vue` (future) | static assets | same set as `react` — *for free*, no host edits |

"React anywhere / LiveView only on Phoenix" is then a **consequence** of one
predicate — *does the host provide the runtime the framework requires?* — rather
than a matrix someone maintains. Validation becomes a membership check:
`host.hostableFrameworks.has(ui.framework)`. LiveView-on-Vite fails *because*
`vite.hostableFrameworks` cannot contain `liveview` — not via a special-cased
string compare.

## 3. Grammar sketch (against the real rules)

On `Ui` (`ddd.langium:250`), add the technical-identity fields:

```
Ui:
    'ui' name=ID withClause=WithClause? '{'
        ('framework' ':' framework=Framework ','?)
        ('design'    ':' design=DesignPack ','?)?
        ('stack'     ':' stack=StackVersion ','?)?
        members+=UiMember*
    '}';

// Framework grows static-bundle frameworks freely; liveview stays runtime-coupled.
Framework returns string:
    'react' | 'liveview' /* | 'angular' | 'vue' */ ;
```

On `Deployable` (`ddd.langium:107`), the `(uiSugar | uiCompose | uiBlock)` choice
is **replaced** by a `hosts:` clause referencing one (later: several) `Ui`, plus
the existing `targets:` for the standalone API edge:

```
        ('hosts' ':' hosts+=[Ui:ID] (',' hosts+=[Ui:ID])*
            ('{' apiBindings+=UiApiBinding* '}')? ','?)?   // compose-block survives, re-homed
```

`hosts+=` (a list from day one) is what makes the deferred one-ui-many-frameworks
case a non-event: today every deployable hosts exactly one `ui`; the grammar
already admits more.

Today's `react` and `static` are **already one host wearing two names** (`static:
reactPlatform`, `registry.ts:36`) — a `needsDb: false` Vite-preview host. Under
this proposal they **collapse into a single standalone host platform** (the
framework that distinguished them moves to `ui`). Name it for what it is — e.g.
`vite` (`needsDb: false`, `hostableFrameworks: {react, …}`). `platform: react`
is retired as a *platform* — it was always "Vite hosts React," now spelled
`ui { framework: react } + deployable { platform: vite }`. The keyword `static`
(if kept) becomes a no-op alias or is dropped, since it never differed from
`react` behaviourally.

## 4. What it subsumes (migration story)

| Today | Becomes | Notes |
|---|---|---|
| `deployable W { platform: react, targets: Api }` + `ui WebApp { … }` | `ui WebApp { framework: react, … }` + `deployable W { platform: vite, hosts: WebApp, targets: Api }` | `platform: react` desugars to Vite-host + react-ui — making the hidden Vite explicit |
| `deployable Api { platform: dotnet, ui: WebApp { framework: react } }` | `ui WebApp { framework: react }` + `deployable Api { platform: dotnet, hosts: WebApp }` | embed is now a `hosts:` edge dispatching on `ui.framework`, not a `generateReactForContexts` hardcode |
| `phoenixLiveView` fullstack | `ui WebApp { framework: liveview }` + `deployable { platform: phoenix, hosts: WebApp, serves: … }` | LiveView's phoenix-only constraint becomes a `hostableFrameworks` fact |
| `design:` on deployable | `design:` on `ui` | design is a property of the artifact, not the host |
| derived stack (`v1/v2/v3`) | explicit `stack:` on `ui` | the stack axis surfaces where it belongs |

A desugaring shim (`platform: react` → vite-host + the referenced `ui` gaining
`framework: react`) keeps existing `.ddd` sources parsing during transition,
mirroring how `platform: "hono@v4"` desugars to family+version.

## 5. What this buys (and the success test)

- **`dotnet`-embeds-Angular** = write an Angular frontend generator + add `angular`
  to the static-bundle frameworks. **Zero** changes to the .NET host: it already
  serves static assets, so `angular ∈ dotnet.hostableFrameworks` the moment
  `angular` is a static-bundle framework.
- **`phoenix`-embeds-React, `hono`-embeds-React** — same, free, because hosting is
  a capability not a per-generator hardcode.
- **The Vite truth stops hiding** — `platform: react` no longer lies; the host
  (Vite) and the artifact (React) are separately named.

**Success test:** adding a new host×framework pairing should touch *the
framework's generator and a capability set* — never the host generator's serving
code.

## 6. Deferred: one page-set, two frameworks

Putting framework on `ui` means a single `ui` block is one framework. The rare
"same pages, shipped as both React and LiveView" case is **not blocked** — it's
just not free:

- **The host edge is already a list** (`hosts+=[Ui]`, §3), so a deployable can
  serve several UIs.
- The two-framework case is then two `ui` declarations (one `framework: react`,
  one `framework: liveview`) hosted together. The cost is page duplication across
  the two blocks — acceptable for a case this rare, and addressable later with a
  shared-page-fragment mechanism if it ever earns one.

This is why merging onto `ui` carries no real downside: the capability we'd
theoretically lose has a clean home at the host edge, and the grammar already
admits it.

## 7. Open questions

1. **Is Vite a host, or a build step every host shares? — answered by the code:
   both, in one container.** Today the standalone container runs `vite build`
   (the build step) *then* `vite preview` (the serving host) — `dockerfile.hbs`.
   For the dotnet-embedded case the same `vite build` runs but the bundle is
   served by ASP.NET, not `vite preview`. So the honest split is: `vite build`
   belongs to the `ui`'s `stack:` (it runs regardless of host); `platform: vite`
   names *the `vite preview` server* (standalone serving), which a backend host
   replaces with its own static middleware. "Host = what serves the built
   assets" holds cleanly.
2. **`stack:` vs `design:` independence.** Stack-version flips react-dom 18→19 and
   router 6→7; design picks the component lib. Fully orthogonal on `ui`, or does a
   design pack constrain a stack range?
3. **`hostableFrameworks` source of truth.** Derive it from a per-framework
   `outputKind` (static-assets | runtime-coupled) + a per-host `servesStatic` /
   `runtime` capability, so the *predicate* is encoded once and the set is
   computed — rather than each host re-listing frameworks.
4. **`targets:` overlap.** A standalone host both `hosts:` a `ui` and `targets:` a
   backend; an embedded host `hosts:` but needs no `targets:` (same origin).
   Validator rule: `targets:` required iff host is standalone.

## 8. Relationship to other proposals

- **`elixir-ecto-and-api-only-backends.md`** — "API-only = absence of a `ui`
  mount" becomes, under this model, "a backend deployable with no `hosts:`." The
  `apiBaseUrl`/CORS seam (`react/index.ts:48–52`) it flags is exactly the
  standalone-vs-embedded fork §2.2 formalises.
- **`storage-and-platform-config*.md`** — those open the backend platform into
  composable axes (style/layout/persistence). This is the **frontend** twin:
  `platform: react` was a frozen bundle the same way `platform: dotnet`'s
  persistence was; `ui`-owns-framework + host-capability is the frontend-side
  decomposition.
