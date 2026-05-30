# `frontend` as a first-class citizen — UI + stack, hosted by a deployable

> Status: **proposal / problem-framing.** Nothing here is implemented. This
> note promotes the **frontend** to a first-class declaration that bundles a
> UI definition with its framework and stack, and makes **hosting** an explicit
> relation: a `deployable` *hosts* a frontend, and a platform declares whether
> it *can* host a given frontend. It replaces the current model where the UI
> framework is **derived from the backend platform** and the embed target is
> hardcoded. No `family@version` machinery; this is a grammar-level reshape of
> the UI/host seam.

## TL;DR

Today a UI's framework is inferred from whatever backend happens to mount it
(`expectedFrameworkFor(dotnet, hasUi) → "react"`), the embed is hardcoded to
React inside the .NET generator, and `platform: react` secretly means
"React **built and served by Vite**." Three things that should be independent —
**what the UI is**, **what framework/stack builds it**, **who serves it** — are
fused.

Promote the middle one to a declaration:

```ddd
ui WebPages { ... }                       // pages only — already first-class today

frontend WebApp {                         // NEW first-class citizen
    ui: WebPages                          // the page definitions it renders
    framework: react                      // react | liveview | (angular | vue …)
    design: mantine                       // design pack
    stack: v3                             // react-dom 19 + react-router 7 + react-query 5
}

deployable Web { platform: vite,    hosts: WebApp, targets: Api }   // standalone
deployable Api { platform: dotnet,  hosts: WebApp }                 // embedded (same grammar)
```

A frontend is the **buildable artifact**. A deployable's platform is its **host**.
Whether hosting is *standalone* or *embedded* is **not a keyword** — it falls out
of whether the host owns a backend (`needsDb`): `vite`/`static` serve standalone
and `targets:` a backend; `dotnet`/`phoenix`/`hono` embed because they already
run a server.

**The host-compatibility relation is principled, not a lookup table:** a host can
serve a frontend **iff it provides the runtime that frontend's framework
requires.** React compiles to static assets → any static-capable host (Vite,
static, dotnet `wwwroot`, hono, Phoenix `priv/static`). LiveView is *not* a static
bundle — it needs the Phoenix runtime → **only Phoenix can host it.** That single
rule explains "LiveView only on Phoenix" and "React anywhere" without enumerating
pairs.

## 1. Why today can't express this (the defect, briefly)

The framework is welded to the host at three layers — full line-numbered evidence
is unchanged from the prior draft, summarised here:

- **Generator** (`dotnet/index.ts:274`) — calls `generateReactForContexts`
  unconditionally when `!!deployable.uiName`. No dispatch on a framework value.
- **Validator** (`platform-rules.ts:94`) — `expectedFrameworkFor(dotnet, ui)`
  returns `"react"`; Rule 13 (`deployable.ts:93`) *errors* on any other
  `framework:`. The `framework:` field is validated-against, never selects.
- **Grammar** (`ddd.langium:207`) — `Framework` is `react | phoenixLiveView`;
  no other token parses.

The shape of the model is the tell: **`ui { }` already exists as a first-class
declaration, but only carries pages.** Framework/design/stack live on the
*deployable's* `ui:` binding (`UiBlockBinding`, `design:`, and a derived stack).
The UI's identity is split across two unrelated declarations, and the half that
decides "what is this UI, technically" is owned by the host. That split is the
root cause — promoting `frontend` heals it.

## 2. The model

### 2.1 Three things, three homes

| Concern | Owner | Example |
|---|---|---|
| **What the UI shows** (pages, components, state, match) | `ui { }` — *unchanged, already first-class* | `ui WebPages { page Orders … }` |
| **What framework/stack builds it** | `frontend { }` — **NEW** | `framework: react, design: mantine, stack: v3` |
| **Who serves it** | `deployable { platform:, hosts: }` | `platform: vite` / `platform: dotnet` |

`frontend` is the missing middle. It references a `ui`, pins a `framework`, a
`design` pack, and a `stack` (the bundler/runtime/router/query version set that
`stacks/v1|v2|v3` already encode). It owns **everything that makes the UI a
buildable artifact** — and nothing about *where* it runs.

### 2.2 Hosting is a relation, and embedded-vs-standalone is emergent

A deployable `hosts:` a frontend. The host's **platform** decides *how*:

- **Standalone** — host platform owns no backend (`needsDb === false`): `vite`
  (dev server + `vite build`), `static` (prod static serve). The frontend
  `targets:` a separate backend deployable for its API base URL (today's
  cross-origin + CORS path).
- **Embedded** — host platform owns a backend (`needsDb === true`): `dotnet`
  (`wwwroot/` + `MapFallbackToFile`), `phoenix` (`priv/static`), `hono` (static
  middleware). The bundle is built and dropped into the backend's static root;
  API base becomes same-origin `/api`.

**No `hosting: embedded|standalone` keyword.** The split is a *derived* property
of the host platform — exactly the `needsDb`/`ownsBackend` flag the registry
already carries. This is the cleanest part of the reshape: the thing the prior
draft wanted to add as an option (an inward `targets:` modifier) is already
latent in the platform registry.

### 2.3 Host-compatibility is a capability, derived from runtime coupling

Replace the boolean `mountsUi` + the hardcoded `expectedFrameworkFor` with a
single capability on the host platform:

```ts
// PlatformSurface
readonly hostableFrameworks: ReadonlySet<Framework>;
```

Populated from the **principled** rule, not hand-enumerated pairs:

| Framework | Output kind | Hostable by |
|---|---|---|
| `react` | static assets (`vite build` → `dist/`) | any static-capable host: `vite`, `static`, `dotnet`, `hono`, `phoenix` |
| `liveview` | **none — server-rendered, needs the Phoenix runtime** | `phoenix` **only** |
| `angular`/`vue` (future) | static assets | same set as `react` — *for free*, no host edits |

"React anywhere / LiveView only on Phoenix" is then a **consequence** of one
predicate — *does the host provide the runtime the framework requires?* — rather
than a matrix someone maintains. A frontend that compiles to static assets is
hostable wherever assets can be served; a runtime-coupled frontend is hostable
only by its runtime.

Validation becomes a membership check: `host.hostableFrameworks.has(frontend.framework)`.
LiveView-on-Vite fails *because* `vite.hostableFrameworks` doesn't (and can't)
contain `liveview` — not because of a special-cased string compare.

## 3. Grammar sketch (against the real rules)

```
Frontend:
    'frontend' name=ID '{'
        ('ui'        ':' ui=[Ui:ID] ','?)
        ('framework' ':' framework=Framework ','?)
        ('design'    ':' design=DesignPack ','?)?
        ('stack'     ':' stack=StackVersion ','?)?
    '}';

// Framework grows static-bundle frameworks freely; liveview stays runtime-coupled.
Framework returns string:
    'react' | 'liveview' /* | 'angular' | 'vue' */ ;
```

On `Deployable` (`ddd.langium:107`), the `(uiSugar | uiCompose | uiBlock)` choice
is **replaced** by a `hosts:` clause referencing a `Frontend`, plus the existing
`targets:` for the standalone API edge:

```
        ('hosts' ':' hosts=[Frontend:ID]
            ('{' apiBindings+=UiApiBinding* '}')? ','?)?   // compose-block survives, re-homed
```

`platform: vite` and `platform: static` become **frontend-host platforms** in the
registry (`needsDb: false`, `hostableFrameworks: {react, …}`). `platform: react`
is retired as a *platform* — it was always "Vite hosts React," now spelled
`frontend { framework: react } + deployable { platform: vite }`.

## 4. What it subsumes (migration story)

| Today | Becomes | Notes |
|---|---|---|
| `deployable W { platform: react, targets: Api }` | `frontend WebApp { ui: …, framework: react }` + `deployable W { platform: vite, hosts: WebApp, targets: Api }` | `platform: react` desugars to Vite-host + react-frontend — making the hidden Vite explicit |
| `deployable Api { platform: dotnet, ui: WebPages { framework: react } }` | `frontend WebApp { ui: WebPages, framework: react }` + `deployable Api { platform: dotnet, hosts: WebApp }` | embed is now a `hosts:` edge dispatching on `frontend.framework`, not a `generateReactForContexts` hardcode |
| `phoenixLiveView` fullstack | `frontend WebApp { ui: …, framework: liveview }` + `deployable { platform: phoenix, hosts: WebApp, serves: … }` | LiveView's phoenix-only constraint becomes a `hostableFrameworks` fact |
| `design:` on deployable | `design:` on `frontend` | design is a property of the artifact, not the host |
| derived stack (`v1/v2/v3`) | explicit `stack:` on `frontend` | the stack axis surfaces where it belongs |

A desugaring shim (`platform: react` → frontend+vite-host) keeps existing `.ddd`
sources parsing during transition, mirroring how `platform: "hono@v4"` desugars
to a family+version.

## 5. What this buys (and the success test)

- **`dotnet`-embeds-Angular** = write an Angular frontend generator + add `angular`
  to the static-bundle frameworks. **Zero** changes to the .NET host: it already
  serves static assets, so `angular ∈ dotnet.hostableFrameworks` the moment
  `angular` is a static-bundle framework.
- **`phoenix`-embeds-React, `hono`-embeds-React** — same, free, because hosting is
  a capability not a per-generator hardcode.
- **The Vite truth is no longer hidden** — `platform: react` stops lying; the host
  (Vite) and the artifact (React) are separately named.

**Success test (unchanged from the prior draft, now achievable):** adding a new
host×framework pairing should touch *the framework's generator and a capability
set* — never the host generator's serving code.

## 6. Open questions

0. **Does `frontend` survive, or does framework move onto `ui`? (OPEN — blocks
   the spine.)** `frontend` is thin: a `ui:` pointer plus `framework`/`design`/
   `stack`. The simpler model folds those three fields onto `ui` and **deletes
   `frontend`**, leaving two concepts (`ui` = pages+framework+stack, `deployable`
   = host). The *only* thing lost is **source-level framework-neutrality** — one
   `ui` block backing both a React and a LiveView frontend. That neutrality is
   load-bearing in the *compiler* (the body-walker renders the same primitives to
   TSX **or** HEEx) but does **not** require the *source* `ui` to be neutral — the
   walker stays shared either way. So the cost of merging is only the rare
   "one page-set, two frameworks" source pattern. **Recommendation: merge onto
   `ui`, drop `frontend`,** unless one-ui-many-frameworks is a wanted capability.
   Either way the two load-bearing wins below survive (host ≠ framework; `hosts:` +
   `hostableFrameworks`). The hybrid (framework on `ui` as a default, overridable
   per host) is rejected — it reintroduces two-places-to-look, the exact tangle
   this proposal kills.

1. **Is Vite a host, or a build step every host shares?** `vite build` runs even
   for the dotnet-embedded case (it produces the bundle dropped into `wwwroot`).
   So Vite is arguably the *frontend's builder* (belongs to `stack:`), while the
   *host* is "Vite **preview/dev server**" only in the standalone case. Decision:
   does `platform: vite` mean "Vite's own server hosts it" (standalone), with the
   build tool living in the frontend's `stack:` regardless of host? (Leaning yes —
   keeps "host = what serves the built assets" clean.)
2. **`stack:` vs `design:` independence.** Today stack-version flips react-dom
   18→19 and router 6→7; design picks the component lib. Are these fully
   orthogonal on `frontend`, or does a design pack constrain a stack range?
3. **One frontend, many hosts.** With hosting as an edge, the *same* `frontend`
   could be hosted standalone in dev and embedded in prod, or by two backends.
   In scope, or one-host-per-frontend for v1?
4. **`hostableFrameworks` source of truth.** Derive it from a per-framework
   `outputKind` (static-assets | runtime-coupled) + a per-host `servesStatic` /
   `runtime` capability, so the *predicate* is encoded once and the set is
   computed — rather than each host re-listing frameworks.
5. **`targets:` overlap.** A standalone frontend host both `hosts:` a frontend and
   `targets:` a backend. An embedded host `hosts:` but needs no `targets:` (same
   origin). Validator rule: `targets:` required iff host is standalone.

## 7. Relationship to other proposals

- **`elixir-ecto-and-api-only-backends.md`** — "API-only = absence of a `ui`
  mount" becomes, under this model, "a backend deployable with no `hosts:`." The
  `apiBaseUrl`/CORS seam (`react/index.ts:48–52`) it flags is exactly the
  standalone-vs-embedded fork §2.2 formalises.
- **`storage-and-platform-config*.md`** — those open the backend platform into
  composable axes (style/layout/persistence). This is the **frontend** twin:
  `platform: react` was a frozen bundle the same way `platform: dotnet`'s
  persistence was; `frontend` + host-capability is the frontend-side
  decomposition.
- **Supersedes** the prior `embedded-frontend-composition.md` framing (registry /
  inward-`targets:` / `embeds:` options): those fixed the *framework* axis but
  left UI identity split across `ui`-binding + deployable. Promoting `frontend`
  fixes the split at the source, and embedded-vs-standalone stops being an option
  to add — it's derived from `needsDb`.
