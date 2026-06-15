# Auth providers (OIDC) + playground stub — implementation plan

> Tracks: [`../proposals/quickstart-and-day-one-batteries.md`](../proposals/quickstart-and-day-one-batteries.md) §4
> and decision [`D-AUTH-OIDC`](../decisions.md) (PINNED).
> Builds on the shipped auth surface in [`../auth.md`](../auth.md).
> Branch: `claude/auth-providers-planning-hnnrep`.
>
> **Phase 0 shipped (language surface, no codegen).** The system-level
> `auth { … }` block now parses, lowers, and validates end-to-end:
> grammar (`AuthBlock` / `OidcConfig` / `ClaimsMap` / `AuthConfigValue`
> + `AuthMode` widened to `required | ui`), regenerated parser/AST,
> `AuthIR` / `OidcConfigIR` / `ClaimMappingIR` on `SystemIR.auth`,
> provider-preset resolution (`src/util/auth-providers.ts` →
> `src/ir/lower/lower-auth.ts`), the `src/language/validators/auth.ts`
> rule set, and a `print-structural` arm. 10 dedicated tests
> (`test/language/auth-block.test.ts`); full fast suite green
> (5051 passed). No backend consumes `SystemIR.auth` yet — that is
> Phase 1 onward.
>
> **Status: Phase 0 done; Phases 1+ pending.** Decisions locked with the
> maintainer (2026-06-15):
>
> 1. **Scope** = OIDC authentication providers + playground auth stub
>    **+ default-deny enforcement** (the known `auth.md` hole, §4.3 of the
>    proposal). Authorization `policy {}` and multi-tenancy stay **out of
>    scope** — separate proposals that need their own reconciliation pass.
> 2. **Provider surface** = **named presets + raw escape hatch**. Convenience
>    providers (`google`, `github`, `microsoft`, `auth0`, …) desugar to OIDC
>    issuer/endpoint presets; a generic `oidc { issuer: … }` form targets
>    Keycloak / any self-hosted IdP. "Keycloak as the custom one" = the raw
>    issuer path; it is also the bundled dev default.
> 3. **Playground stub** = **identity injection**. A new config tab where the
>    author fills the `user {}` claim shape; the sandbox injects it as
>    `currentUser` (bypassing real OIDC, which the in-browser sandbox can't
>    reach). No fake JWKS / in-browser issuer in this slice.

## 1. Why this exists

`auth.md` already ships the typed identity (`user {}`), `currentUser`,
`permissions {}`, `requires` (403) vs `precondition` (400), and row-level
finds/views across every backend. The one thing it does **not** ship is *who
produces the verified user*: today every backend emits a **verifier seam** the
app author fills in by hand, plus a `DevStubUserVerifier` that accepts every
request.

This plan fills that seam with a **generated OIDC verifier** driven by a new
system-level `auth {}` block, bundles a dev Keycloak so `docker compose up`
logs in out of the box, closes the default-deny hole, and gives the playground
a way to exercise `auth: required` systems without a reachable IdP.

Per `D-AUTH-OIDC`, Loom owns **zero** auth runtime: no `AuthUser` aggregate, no
password column, no login form, no OAuth client code. The IdP owns credentials,
MFA, reset, lockout, and hosted login pages. Loom validates tokens and maps
claims into the existing `user {}` projection.

## 2. What already exists (the seam we fill)

Every backend already emits a verifier hook + dev stub. The OIDC work
**replaces the manual hook registration with a generated verifier** and adds
the `/auth/*` handshake — it does not rebuild the middleware/`currentUser`
plumbing, which is done.

| Backend | Auth emitter | Files today | Verifier seam | Dev stub today |
|---|---|---|---|---|
| Hono | `src/platform/hono/v4/auth-emit.ts` | `auth/user-types.ts`, `auth/verifier.ts`, `auth/middleware.ts` | `registerUserVerifier(fn)` | registry default |
| .NET | `src/generator/dotnet/auth-emit.ts` | `Auth/{User,IUserVerifier,ICurrentUserAccessor,HttpContextCurrentUserAccessor,UserMiddleware,DevStubUserVerifier}.cs` | `IUserVerifier` DI | `DevStubUserVerifier.cs` |
| Java | `src/generator/java/emit/auth.ts` | `{User,UserVerifier,DevStubUserVerifier,UserFilter,CurrentUserAccessor}.java` | `UserVerifier` bean | `DevStubUserVerifier.java` |
| Python | `src/generator/python/auth-emit.ts` | `app/auth/{user,verifier,middleware}.py` | `register_user_verifier(fn)` | registry default |
| Phoenix | `src/generator/elixir/auth-emit.ts` | `auth.ex`, `live_auth.ex` | `verify_token/1` stub | inline stub |
| React/Vue/Svelte | — | none | — | — (backend-driven) |

Grammar / IR anchor points (from inventory):

- Grammar `src/language/ddd.langium`: `UserBlock` (69–72), `UserField`/`UserFieldName` (74–78), `auth: AuthMode` on Deployable (167), `AuthMode` enum = `'required'` (269–270), `PermissionsBlock` (104–110), `RequiresStmt` (1546–1547).
- IR `src/ir/types/loom-ir.ts`: `UserIR` (1580–1582), `SystemIR.user?` (1420–1426), `DeployableIR.auth?: { required }` (2099–2104), `PermissionDeclIR` (1913–1922), `requires` stmt kind (1032), `PageIR.requires?` (1747).
- Validators: `composition.ts:107–133` (duplicate-user-block), `statements.ts:167–175` (`requires` must be `bool`). **No dedicated auth validator file** — we add one.
- `currentUser` lowering: `src/ir/lower/lower-expr.ts:746–752` (magic id + `USER_SHAPE_NAME`).
- Playground: tabs in `web/src/layout/DevToolsDock.tsx` (Output/Runtime/Tests/History); runtime dispatch in `web/src/App.tsx` `runDispatch()`; in-iframe fetch shim `web/src/preview/iframe-html.ts`; in-browser engine = Hono only.

## 3. Surface design

### 3.1 The `auth {}` block (system scope, sibling to `user {}`)

```ddd
system Acme {
  user {
    id: string
    role: string
    email: string
    permissions: string[]
  }

  auth {
    provider: keycloak                          // preset OR raw oidc{} (below)
    oidc {
      issuer:   env("OIDC_ISSUER")              // required for `custom`/keycloak
      clientId: env("OIDC_CLIENT_ID")
      // clientSecret resolved from env at runtime for confidential clients
    }
    sessions: cookie                            // cookie | jwt
    claims:   { role: "realm_access.roles", email: "email" }   // IdP claim → user{} field
    enforcement: denyByDefault                  // denyByDefault | opt (default: opt)
  }

  deployable api { platform: hono, contexts: [...], dataSources: [...], auth: required }
  deployable web { platform: react, targets: api, auth: ui }   // login redirect + guard
}
```

### 3.2 Providers: presets + raw escape hatch

`provider:` names a preset; presets are a static registry (`src/util/` or
`src/language/auth-providers.ts`) of well-known OIDC endpoints. A preset
supplies the `issuer` (and any non-discoverable endpoint quirks); the author
still supplies `clientId` (+ secret via env).

| `provider:` value | Resolves to |
|---|---|
| `google` | `issuer: https://accounts.google.com` |
| `microsoft` / `entra` | `issuer: https://login.microsoftonline.com/{tenant}/v2.0` (tenant via param) |
| `github` | GitHub OAuth (note: not full OIDC — flagged; may ship as a non-OIDC variant or be deferred) |
| `auth0` | `issuer: https://{domain}` (domain via param) |
| `okta`, `zitadel`, `cognito` | issuer-templated presets |
| `keycloak` / `custom` | **raw** — requires the `oidc { issuer, clientId }` block; this is the self-hosted / "custom" path and the bundled dev default |

Resolution rule: `provider: <preset>` may co-exist with `oidc {}` to override
fields; `provider: custom` (or `keycloak`) **requires** `oidc { issuer }`.
Presets desugar in **lowering** to a fully-resolved `OidcConfigIR` so backends
never special-case provider names — they always see `{ issuer, clientId,
authorizeUrl, tokenUrl, jwksUrl, scopes }`.

`github` is the one wrinkle (OAuth2, not OIDC — no `id_token`/JWKS). Options:
ship it as a distinct non-OIDC strategy, or defer it. **Recommend deferring
non-OIDC providers** to keep slice 1 honest to D-AUTH-OIDC; the preset registry
is built to accommodate them later.

### 3.3 What gets generated when `auth {}` is declared

- A **real verifier** filling each backend's existing seam: validates the OIDC
  token (JWKS signature, `iss`/`aud`/`exp`), maps `claims:` into the typed
  `User`, rejects → 401. The hand-written hook stays as an override.
- The **login handshake, not a login form**: `/auth/login` → IdP authorize
  redirect; `/auth/callback` → code exchange + local session (signed `HttpOnly`
  cookie or forwarded JWT per `sessions:`); `/auth/logout` → clears it. **No
  signup/password/verify-email** — the IdP hosts those.
- On `react`/LiveView with `auth: ui`: **route guard + session-aware client +
  "Sign in" affordance**. No login/signup pages.

## 4. Phased plan

Ordered so the **playground-relevant path (Hono) lands first** and each phase is
independently shippable + test-gated.

### Phase 0 — Language: grammar, IR, lowering, validation (no codegen)

1. **Grammar** (`ddd.langium`): add `AuthBlock` (sibling of `UserBlock` inside
   the system body), `OidcConfig`, `Provider` enum, `SessionMode` (`cookie|jwt`),
   `ClaimsMap`, `Enforcement` (`denyByDefault|opt`), and `auth: ui` →
   extend `AuthMode` enum (`'required' | 'ui'`). Use a discriminator-field /
   flat-list style per the grammar conventions in CLAUDE.md. Re-run
   `npm run langium:generate`, commit regenerated `src/language/generated/`.
2. **IR** (`loom-ir.ts`): add `AuthIR` (provider, resolved `OidcConfigIR`,
   sessions, `ClaimMappingIR[]`, enforcement) + `SystemIR.auth?`. Extend
   `DeployableIR.auth` to carry `'required' | 'ui'`.
3. **Lowering** (`src/ir/lower/lower-*.ts`, likely `lower-platform.ts` or a new
   `lower-auth.ts`): resolve `provider:` presets → fully-populated
   `OidcConfigIR`; validate `claims:` targets against `user {}` fields during
   lowering's resolution (or defer to validator). `env(...)` references lower to
   the existing env-expr representation.
4. **Validation** — new `src/language/validators/auth.ts` (the inventory found
   none; rules are currently scattered):
   - `auth {}` without `user {}` → error.
   - `oidc` missing `issuer`/`clientId` (when required by provider) → error.
   - `claims:` entry targeting an unknown `user {}` field → error.
   - `provider: custom|keycloak` without `oidc { issuer }` → error.
   - (Phase 4) `enforcement: denyByDefault` + ungated reachable command → error.
5. **Printer** (`src/language/print/print-structural.ts`): add arms for the new
   structural nodes — `print-completeness.test.ts` fails until present.
6. Tests: parse test, negative validator tests, lowering/preset-resolution test.

### Phase 1 — Hono OIDC verifier + handshake (playground backend)

Extend `src/platform/hono/v4/auth-emit.ts`:
- Emit `auth/oidc.ts`: `jose`-based JWKS verify + claims→User mapping, replacing
  the manual `registerUserVerifier` default when `system.auth` is present.
- Emit `auth/handshake.ts` (or routes into `http/index.ts`): `/auth/login`,
  `/auth/callback`, `/auth/logout`; session cookie/JWT per `sessions:`.
- Wire into the Hono stack deps (`stacks/*`): add `jose`.
- Keep the bypass list (`/health`, `/ready`, `/openapi.json`, `/swagger`).
- Tests: emitter unit tests + `LOOM_TS_BUILD=1` over an `auth {}` example.

### Phase 2 — .NET OIDC verifier + handshake

Extend `src/generator/dotnet/auth-emit.ts`: generate an `IUserVerifier`
registered automatically (replacing the dev stub when `auth {}` present) using
`Microsoft.Identity.Web` / `AddJwtBearer` + the `/auth/*` handlers. .NET has the
most existing plumbing (`ICurrentUserAccessor`, `UserMiddleware`), so this is
mostly the verifier body + handshake controllers + `Program.cs` registration.

### Phase 3 — Bundled dev Keycloak (zero-config quick-start)

In `src/system/` compose generation: when `auth {}` is declared (and provider is
keycloak/custom or a dev flag is on), add a **Keycloak service** to the generated
`docker-compose.yml` with a pre-provisioned realm (client, redirect URIs) and a
**seeded demo user**, and default `issuer:` to point at it. The demo user is
seed data (gated on the seeding feature, `database-seeding.md` §5.4 — if seeding
isn't landed, ship a static realm-import JSON instead). Production repoints
`issuer:` at a real IdP. Tests: compose-shape assertion; optionally an e2e that
boots the stack + Keycloak and completes the handshake (heavy — likely opt-in
`LOOM_*` gated).

### Phase 4 — Default-deny enforcement (`enforcement: denyByDefault`)

In `src/ir/validate/checks/` (a new or existing check leaf): when a deployable
is `auth: required` and the system's `auth.enforcement == denyByDefault`, every
**reachable** operation / find / view / workflow must declare a `requires` gate
(or explicit `requires anonymous`). Add `requires anonymous` as an allowed form
(a `requires` whose expr is the literal `anonymous` magic identifier, lowering to
`true`). `enforcement: opt` (default) preserves today's behaviour. Tests:
positive (gated commands pass) + negative (ungated reachable command rejected).

### Phase 5 — Phoenix / Python / Java parity

Extend each backend's `auth-emit.ts` with the OIDC verifier + handshake using
the idiomatic lib (`oidcc`/`Ueberauth` for Phoenix; `authlib`/`jose` for Python;
`spring-security-oauth2`/`nimbus` for Java). Parity gated by the per-backend
build workflows. Sequenced after the two headline backends; can be parallelised.

### Phase 6 — React `auth: ui` (route guard + sign-in)

In `src/generator/react/` (+ Vue/Svelte later): emit a route guard, a
session-aware API client (sends the session cookie / bearer), and a "Sign in"
affordance that hits `/auth/login`. **No login form.** Gated by
`generated-react-build.yml`.

### Phase 7 — Playground auth stub tab (identity injection)

The in-browser sandbox can't reach a real IdP, so the OIDC verifier path is
non-functional there. Instead, add an **"Auth" config tab** that injects a
`currentUser`:

1. **State**: `web/src/layout/ctx.ts` `LayoutCtx` gains
   `authConfig: AuthStubConfig` + setter, persisted via `usePersistedState`
   (`loom.authConfig`). Shape:
   ```ts
   interface AuthStubConfig {
     enabled: boolean;
     claims: Record<string, unknown>;   // mirrors the system's user{} fields
   }
   ```
2. **Tab**: register an `auth` tab in `web/src/layout/DevToolsDock.tsx` (desktop)
   + the mobile tab list, rendering a new `web/src/layout/AuthConfigPanel.tsx` —
   a form whose fields are **derived from the parsed `user {}` block** (so the
   claim editor matches the system), with a preset from the `auth-capabilities`
   example.
3. **Injection**: the runtime dispatch path (`App.tsx` `runDispatch()` →
   `engine.dispatch()`) attaches the stub identity. Cleanest seam: have the
   generated Hono dev-stub verifier read an injected header (e.g.
   `x-loom-dev-claims: <base64 json>`) — the playground sets it, and the same
   header is what the bundled `DevStubUserVerifier`-equivalent consumes. This
   keeps the sandbox honest: it exercises the real middleware + `currentUser`
   plumbing + `requires` gates, only short-circuiting the OIDC token-verify.
4. Tests: a Playwright spec (`web/`) — set claims in the Auth tab, dispatch a
   request to a `requires`-gated route, assert 200 vs 403 flips with `role`.

## 5. Validation rules (new — Phase 0 + Phase 4)

| Situation | Diagnostic |
|---|---|
| `auth {}` without a `user {}` block | "auth block requires a `user { … }` block to define the identity shape." |
| `oidc {}` missing `issuer`/`clientId` (provider needs it) | "oidc requires `issuer` and `clientId` (env-bound)." |
| `claims:` maps a field absent from `user {}` | "claim mapping targets unknown user field 'X'." |
| `provider: custom`/`keycloak` without `oidc { issuer }` | "provider 'custom' requires an `oidc { issuer: … }` block." |
| `enforcement: denyByDefault` + ungated reachable command | "reachable under `auth: required` with `denyByDefault` but declares no `requires` gate (use `requires anonymous` to allow)." |

## 6. Testing & CI

- Phase 0: parsing + negative validator + lowering preset-resolution + printer
  completeness (fast suite).
- Phase 1/2/5: per-backend emitter unit tests + the existing build workflows
  (`hono-build.yml`, `dotnet-build.yml`, `java-build.yml`, `python-build.yml`,
  `elixir-*-build.yml`) over a new `auth {}` example.
- Phase 3: compose-shape assertion; opt-in handshake e2e (`LOOM_*` gated).
- Phase 6: `generated-react-build.yml`.
- Phase 7: playground Playwright spec.
- Add an `examples/auth-oidc.ddd` (and a `web/src/examples/` entry) exercising
  presets + raw issuer; the react-build matrix picks it up.

## 7. Risks & open questions

- **`github` / non-OIDC providers**: GitHub OAuth has no `id_token`/JWKS.
  Recommend **defer**; keep the preset registry extensible. Confirm before
  advertising `github` in the preset list.
- **Confidential vs public clients / PKCE**: `sessions: cookie` implies a
  confidential client with a server-side code exchange; SPA-only deployments
  may want PKCE public flow. Slice 1 targets the backend-mediated cookie flow
  (the `deployable api` does the exchange); document PKCE as a follow-up.
- **Keycloak realm provisioning** depends on the seeding feature
  (`database-seeding.md` §5.4). If seeding isn't landed when Phase 3 starts,
  ship a static `realm-export.json` import instead of a seeded user.
- **Playground header injection** must be **dev-only** — the generated stub
  verifier that trusts `x-loom-dev-claims` must never be wired into a
  production deployable. Gate it behind a dev-stub mode that the OIDC verifier
  replaces whenever `auth {}` is present, and document loudly.
- **Pipeline layering**: the preset registry is shared vocabulary consumed by
  lowering (and possibly validation) — it belongs in `src/util/` or
  `src/language/`, never imported "upward" from a generator
  (`pipeline-layering.test.ts` enforces).

## 8. File-touch map (first three phases)

| Area | Files |
|---|---|
| Grammar | `src/language/ddd.langium` (+ regenerated `src/language/generated/**`) |
| Provider presets | `src/language/auth-providers.ts` (or `src/util/`) — new |
| IR | `src/ir/types/loom-ir.ts` (`AuthIR`, `OidcConfigIR`, `SystemIR.auth`, `DeployableIR.auth` widen) |
| Lowering | `src/ir/lower/lower-auth.ts` (new) + wire into `lower.ts`; preset resolution |
| Validation | `src/language/validators/auth.ts` (new); register in the validator module |
| Printer | `src/language/print/print-structural.ts` |
| Hono codegen | `src/platform/hono/v4/auth-emit.ts`, stack deps under `stacks/*` |
| .NET codegen | `src/generator/dotnet/auth-emit.ts` |
| Compose / Keycloak | `src/system/` compose builder |
| Playground | `web/src/layout/ctx.ts`, `web/src/layout/DevToolsDock.tsx`, `web/src/layout/MobileShell.tsx`, `web/src/layout/AuthConfigPanel.tsx` (new), `web/src/App.tsx` (`runDispatch`) |
| Examples | `examples/auth-oidc.ddd`, `web/src/examples/` entry |
| Docs | update `docs/auth.md` (verifier seam → OIDC completion), `docs/decisions.md` cross-ref |

## 9. Sequencing summary

```
Phase 0  Language (grammar+IR+lower+validate+print)   ── foundation, blocks all
Phase 1  Hono OIDC verifier + handshake               ── playground-relevant backend
Phase 2  .NET OIDC verifier + handshake               ── richest existing plumbing
Phase 3  Bundled dev Keycloak in compose              ── zero-config quick-start
Phase 4  Default-deny enforcement                     ── closes the auth.md hole
Phase 7  Playground auth stub tab (identity inject)   ── can land right after Phase 1
Phase 5  Phoenix / Python / Java parity               ── parallelisable
Phase 6  React auth: ui (guard + sign-in)             ── frontend completion
```

Phases 0→1→2 are the critical path to "OIDC works on a real stack"; Phase 7
unblocks playground exploration as soon as Phase 1's stub-verifier seam exists.
