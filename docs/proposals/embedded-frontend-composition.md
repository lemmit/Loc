# Embedded-frontend composition — decoupling the hosted UI framework from the backend platform

> Status: **proposal / problem-framing.** Nothing here is implemented. This
> note isolates a modelling defect uncovered while scoping a Phoenix-hosts-React
> variant: the DSL can express *that* a backend embeds a UI, but not *which*
> frontend it embeds. The framework is **derived from the backend platform**,
> not chosen. The note documents the three hardcode sites, gives the clean
> counterexamples that break the current model, and sketches three options for a
> real composition seam. No platform name is added; this is about a seam, not a
> backend.

## TL;DR

`platform: dotnet` + a `ui:` mount today means, at every layer, **"embed a React
SPA"** — never "embed *a* SPA." The frontend framework is inferred from the host
backend (`expectedFrameworkFor(dotnet, hasUi) → "react"`), the validator
*rejects* any other `framework:`, and the generator calls `generateReactForContexts`
unconditionally. Three independent facts are collapsed onto one keyword:

| Independent fact | Should be | Is |
|---|---|---|
| **Domain layer** (EF / Ash / Ecto / Hono) | the platform's real identity | `platform:` ✓ |
| **UI framework** (React / Angular / Vue / HEEx) | a free choice | *derived* from the platform |
| **UI hosting** (separate container / embedded same-origin) | a free choice | implied by `!!deployable.uiName` on a backend |

The consequence: any host×framework pairing the curator didn't pre-bless is
**inexpressible**, not merely unimplemented. `dotnet`-embeds-Angular,
`phoenix`-embeds-React, `dotnet`-embeds-Vue — none of these has a slot in the
grammar, because "embed" reaches *inside* the React stack and hardcodes it rather
than *composing* two stacks.

Crucially, this is **not** an argument to expose the bundler/router. `platform:
react` hiding "Vite + react-router + react-query + a design pack" is *good*
encapsulation — the right altitude for a DDD model. The leak is narrower and
worse: **`dotnet` hides `react`.** A backend stack reaches into a frontend stack
and freezes the choice. Fixing *that* seam is the whole proposal.

## 1. The defect, with line numbers

Three layers, each independently pinning the embedded framework to React.

### 1a. The generator hardcodes React (`src/generator/dotnet/index.ts`)

```ts
const hasEmbeddedSpa = !!system?.deployable.uiName;   // :151 — a backend "becomes fullstack"
...
if (hasEmbeddedSpa && system) {
  const spaFiles = generateReactForContexts(            // :274 — the ONLY frontend generator called
    contexts, system.sys, system.deployable,
    { apiBaseUrl: "/api", pathPrefix: "ClientApp/" },
  );
  ...
}
```

There is no dispatch on a framework value — one boolean (`hasEmbeddedSpa`) flips
`.NET` from "plain backend" to "fullstack host," and the host it builds is
*always* React. (`grep generateAngular src/` → nothing, as expected.)

### 1b. The validator forces React and rejects alternatives (`src/language/validators/data/platform-rules.ts`)

```ts
export function expectedFrameworkFor(platform, hasUi): string | undefined {
  const fam = platformFamily(platform);
  if (fam === "react" || fam === "static") return "react";
  if (fam === "phoenixLiveView")           return "phoenixLiveView";
  if (fam === "dotnet" && hasUi)            return "react";   // :94 — dotnet+ui is hardwired to react
  return undefined;
}
```

`deployable.ts:93` (Rule 13) cross-checks the deployable's declared
`framework:` against this expectation and **errors on mismatch**. So even a
well-formed `ui: WebApp { framework: angular }` would be rejected with
*"expected 'react'"*. The `framework:` field looks like an escape hatch but is
only ever a value to be *validated against*, never one that *selects* a
generator.

### 1c. The grammar enum has no other frontend (`src/language/ddd.langium`)

```
Framework returns string:
    'react' | 'phoenixLiveView';
```

`angular` / `vue` aren't tokens — they don't even parse. The comment already
anticipates extension (`blazor-wasm`, `blazor-server`, …) but the *mechanism* to
honour a new value doesn't exist downstream: adding `'angular'` here would parse,
then immediately fail Rule 13 (1b) and never reach a generator (1a).

## 2. Why the model can't express it — root cause

Every platform keyword is a **bundle-name, not a layer-name**:

- `react` = Vite 5 + react-dom (18/19 by stack) + react-router (6/7) + @tanstack/react-query 5 + ⟨design pack⟩
- `dotnet` = ASP.NET + EF + Mediator (+ secretly an embedded React SPA when `ui:`)
- `hono` = Hono + a fixed TS runtime/bundler set
- `phoenixLiveView` = Phoenix + Ash + HEEx

Collapsing a stack behind one word is the **value proposition** of the DSL —
nobody wants to hand-pick a bundler in a domain model, and `platform: react`
being "really Vite" is correct encapsulation, not a bug. The defect appears at
exactly two seams:

- **D-EMBED-FRAMEWORK** — when a *sub-choice* of the embedded UI must vary
  (Angular under .NET). No slot exists because the choice was made by the host.
- **D-EMBED-COMPOSE** — when two stacks should *compose* (backend embeds
  frontend). The embed isn't a composition; it's a baked-in pair frozen inside
  the host generator (1a).

`react` hiding Vite is encapsulation. `dotnet` hiding `react` is a leak. The
proposal targets only the second.

## 3. The counterexamples that motivate this

| Scenario | Expressible today? | Why not |
|---|---|---|
| `dotnet` + React SPA | ✅ | the one hardcoded pair |
| `dotnet` + **Angular** SPA | ❌ | no enum token; Rule 13 forces `react`; generator calls `generateReactForContexts` |
| **`phoenix`/Ecto** backend + React SPA | ❌ | `expectedFrameworkFor` has no non-Ash Elixir host that embeds React; embed code lives in `dotnet/index.ts` only |
| `dotnet` + **Vue** SPA | ❌ | same three blocks as Angular |
| Two backends embedding the **same** React app | ❌ | embed is keyed off `deployable.uiName` on a single backend |

Each "❌" is blocked by the *same three sites* in §1 — strong evidence the fix is
one seam, not N features.

## 4. Design options

The shared goal: make **host × frontend** a *composition of two encapsulated
stacks*, so each new pairing is "point a backend stack at a frontend stack," with
neither stack leaking into the other.

### Option A — Inward `targets:` (embed = a frontend that targets a backend *in-process*)

A frontend deployable already names its backend(s) via `targets:`. Add a hosting
modifier so a `react` (or future `angular`) deployable can be *embedded by* its
target instead of shipping as its own container:

```ddd
deployable Api      { platform: dotnet }
deployable WebApp   { platform: react, targets: Api, hosting: embedded }
```

- **Pros:** framework comes from the *frontend's own* `platform:` (no derivation,
  no enum coupling); embedding becomes a property of the existing `targets:`
  edge; one backend can be targeted by an embedded *or* standalone frontend with
  no host-side change; generalises to every backend for free.
- **Cons:** lowering must fold the embedded deployable's file map into the host's
  output tree (today `dotnet/index.ts` *pulls* React in; this *pushes* the
  frontend out and asks the host to receive it) — a real inversion in
  `src/system/` compose + `PlatformSurface`.
- **Touches:** drop `hasEmbeddedSpa` special-case (1a); generalise `composeService`/
  emit to accept an embedded child; delete the `dotnet+ui→react` line (1b);
  `mountsUi`/`isFrontend` semantics on the surface contract.

### Option B — Explicit `embeds:` on the backend (host pulls a named frontend)

Keep the host-pulls model but make the pulled thing *named and typed* instead of
hardcoded:

```ddd
deployable WebApp { platform: react }
deployable Api    { platform: dotnet, embeds: WebApp }
```

- **Pros:** smallest conceptual move from today (host still owns the embed);
  framework still comes from the referenced frontend deployable's `platform:`;
  the generator dispatches on `embeds.platform` instead of assuming React.
- **Cons:** adds a *second* way to relate frontend↔backend alongside `targets:`
  (a frontend that's embedded is also, implicitly, targeting that backend — risk
  of two edges to keep consistent). Needs a validator rule that `embeds` ⇒ the
  referenced deployable is a frontend platform.
- **Touches:** grammar (new `embeds:` clause); generator dispatch keyed on the
  referenced platform's frontend generator; Rule 13 retired in favour of "is the
  embedded deployable a frontend?"

### Option C — Frontend-generator registry (dispatch, keep current surface)

Leave the DSL surface alone; fix only the generator/validator so the existing
`framework:` field *selects* rather than is *validated*:

```ts
// src/generator/_frontends/registry.ts (new)
const FRONTEND_GENERATORS = {
  react:   generateReactForContexts,
  angular: generateAngularForContexts,   // when it lands
};
```

`dotnet/index.ts` calls `FRONTEND_GENERATORS[framework]`; `expectedFrameworkFor`
becomes `allowedFrameworksFor` (a *set* the host can embed) and Rule 13 checks
membership instead of equality.

- **Pros:** smallest blast radius; unblocks `dotnet`+Angular the moment an
  Angular generator exists; no new DSL keyword; `framework:` finally does what it
  looks like it does.
- **Cons:** doesn't fix **D-EMBED-COMPOSE** — embedding still lives *inside* each
  backend generator (every backend that wants to embed re-implements the
  pull+filter+`/api` rewrite that `dotnet/index.ts` has). It makes the *framework*
  composable but not the *hosting*. A good first step, not the whole fix.

## 5. Recommendation

**Option C as a mechanical first step** (it directly unblocks the framework axis
and makes `framework:` honest with a small, well-bounded change), evolving toward
**Option A as the target model** (hosting as a property of the existing `targets:`
edge is the only option that fixes *both* seams and generalises to every backend
without per-host embed code). Option B is viable but introduces a second
frontend↔backend edge that overlaps `targets:`; prefer A's single edge.

Whatever lands, the success test is one sentence: **adding `dotnet`-embeds-Angular
(or `phoenix`-embeds-React) should require writing an Angular generator and zero
changes to the .NET generator's hosting code.** Today it requires editing all
three sites in §1.

## 6. Open questions

1. **Where does the embedded bundle live across hosts?** .NET uses
   `wwwroot/` + `MapFallbackToFile`; a JVM/Elixir host has a different static-serve
   story. Does `PlatformSurface` grow a `receiveEmbeddedUi(files)` method, or does
   compose handle the relocation generically?
2. **`/api` prefix + CORS.** The embed today rewrites controllers to `/api/*` and
   sets `apiBaseUrl: "/api"` (`dotnet/index.ts:274`). A standalone frontend uses a
   cross-origin base URL + CORS. The hosting mode must drive this branch — it's the
   same fork the Ecto note flagged for API-only Phoenix (`react/index.ts:48–52`).
3. **Design-pack format coupling.** `expectedPackFormatFor` ties `react→tsx`,
   `phoenixLiveView→heex`. A new frontend framework needs its pack format
   registered the same way — keep it in the same table as the framework registry.
4. **Does `static` compose too?** `static` is a frontend platform (`react`
   framework, no backend). If hosting becomes an edge property, an embedded
   `static` site is suddenly expressible — desirable or out of scope?

## 7. Relationship to other proposals

- **`elixir-ecto-and-api-only-backends.md`** — its "API-only = absence of a `ui`
  mount" finding is the *mirror* of this note: that one removes the UI from a
  backend, this one makes the embedded UI's framework a free choice. Both converge
  on the `react/index.ts:48–52` `apiBaseUrl` branch as the consumption seam.
- **`storage-and-platform-config*.md`** — the `platform:`-as-bundle framing here
  is the frontend analogue of the backend storage/config axis those notes open up.
