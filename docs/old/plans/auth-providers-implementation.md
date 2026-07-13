# Auth providers (OIDC) + playground stub — implementation plan

> Tracks: [`../proposals/quickstart-and-day-one-batteries.md`](../proposals/quickstart-and-day-one-batteries.md) §4
> and decision [`D-AUTH-OIDC`](../../decisions.md) (PINNED).
> Builds on the shipped auth surface in [`../auth.md`](../../auth.md).
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
> **Phase 1 shipped (Hono OIDC verifier + handshake).** Under an
> `auth { oidc }` block, the Hono backend now emits `auth/oidc.ts` (a
> `jose` + JWKS token verifier that maps the configured `claims:` onto
> the typed `User`) and `auth/handshake.ts` (the `/auth/login|callback
> |logout` redirect flow); `createApp` mounts `/auth` (middleware
> bypasses it), `index.ts` auto-registers the OIDC verifier instead of
> the dev stub, and `jose` is added to `package.json` only when OIDC is
> present. Non-OIDC projects stay byte-identical. 6 codegen tests
> (`test/generator/typescript/auth-oidc-codegen.test.ts`); emitted code
> verified Biome-clean; full fast suite green (5057 passed). **tsc-gated:**
> an `auth-oidc` fixture (`test/e2e/fixtures/ts-build/auth-oidc.ddd`) now
> runs in the `LOOM_TS_BUILD` shard (`generate system` → `npm install` →
> `tsc --noEmit` → `tsup`), so the emitted verifier + handshake compile
> against the real `jose` / `hono` types — verified passing locally.
>
> **Phase 7 shipped (playground identity-injection auth tab).** Two
> parts: (a) the generated Hono **dev-stub** verifier now honours an
> injected `x-loom-dev-claims` header (base64 JSON, merged over its
> built-in identity) — dev-only, tsc-verified; (b) a new **Auth** tab in
> the playground dock (+ mobile) where you toggle injection and edit the
> claims JSON, wired into both dispatch paths (Backend tester +
> Preview app) via a stable `authedRuntime` wrapper so an
> `auth: required` system is explorable as different users (flip `role`,
> watch a `requires` gate go 200 ↔ 403) with no IdP. A system with a
> real `auth { oidc }` block runs the OIDC verifier instead and ignores
> the header. Web typecheck green; base64/UTF-8 round-trip verified
> against the dev-stub decoder. (Playwright spec for the tab: follow-up.)
>
> **Phase 6 shipped (React `auth: ui` guard — full-stack frontend auth).**
> A new backend route `GET /auth/me` (always present when a backend is
> `auth: required`; the redirect handshake's bypass narrowed to
> `/auth/login|callback|logout` so `/me` stays middleware-protected) gives
> the frontend a session probe that works for both the OIDC verifier and
> the dev stub. When a react deployable opts in via `auth: ui` (target
> backend `auth: required`), the generator emits pack-agnostic
> `src/auth/session.ts` + `src/auth/AuthGate.tsx` (probe `/auth/me`; gate
> the app; "Sign in" redirects to the IdP — no login form), wraps `<App/>`
> in `<AuthGate>` (mantine v7+v9), and sends `credentials: "include"`.
> Validation: `auth: ui` requires a frontend whose target is
> `auth: required`. **Playground support is automatic** — `/auth/me` is a
> normal intercepted endpoint, so the guard resolves through the dev stub
> with the Phase 7 Auth-tab identity (the app renders as that user, no IdP
> needed). tsc-gated (the emitted `web/` project type-checks against real
> React/Mantine types); content + validation tests; full fast suite green.
>
> **Phase 6d shipped (Svelte `auth: ui` guard — frontend parity).** The
> Svelte generator now mirrors the React guard. The session client
> (`src/lib/auth/session.ts`) is reused **verbatim** from
> `src/generator/_frontend/auth-ui.ts` (`AUTH_SESSION_TS`) — framework-neutral
> TS whose relative imports resolve identically; the framework-shaped seam
> is a new runes-based `AUTH_GATE_SVELTE` → `src/lib/auth/AuthGate.svelte`
> (probe `/auth/me` on mount, gate the app, "Sign in" → IdP, sign-out
> button, reactive session context via `useSession`). When a svelte
> deployable opts in via `auth: ui` (target backend `auth: required`),
> `src/generator/svelte/index.ts` emits the two files, the shared
> `sveltekit/root-layout.hbs` wraps the app in `<AuthGate>`, and
> `sveltekit/api-client.hbs` sends `credentials: "include"`. The framework
> gate (`loom.auth-ui-unsupported-framework`) now admits `svelte` alongside
> `react` and `vue`. Non-auth svelte output stays byte-identical. Verified:
> unit emission test (`test/generator/svelte/auth-ui-emit.test.ts`),
> framework-gate test updated, full fast suite green, and the emitted `web/`
> project **svelte-check + vite-build green locally** on both svelte packs
> (shadcnSvelte@v1, flowbite@v1) via a new build-matrix fixture
> (`test/e2e/fixtures/svelte-build/auth-ui.ddd`, gated in
> `generated-svelte-build`). **Phoenix LiveView is the only remaining open
> frontend-target guard** (a separate generator needing its own component).
>
> **Phase 6b shipped (all React packs + framework gate).** The `<App/>`
> wrap now lands in every React pack's `main.hbs` (mantine v7/v9, shadcn
> v3/v4, mui v5/v7, chakra v2/v3) — verified per-pack (content test ×4)
> and tsc'd on shadcn + mantine. A new IR check
> (`loom.auth-ui-unsupported-framework`) rejects `auth: ui` on a frontend
> whose resolved UI framework isn't a supported one so the limitation
> fails loudly instead of emitting no guard.
>
> **Phase 6c shipped (Vue `auth: ui` guard).** The Vue generator now emits
> the same guard for a `platform: vue` deployable that opts in: the shared
> `src/auth/session.ts` probe (reused verbatim — it only touches the api
> client + config), a Vue-shaped `src/auth/AuthGate.vue` (provide/inject
> session, full-screen "Sign in" redirect, sign-out) + a `useSession`
> composable, the shared `credentials: "include"` client, and the `<App/>`
> wrap in both Vue packs' `main.hbs` (vuetify@v3, shadcnVue@v1) via a tiny
> render-function root. The framework gate now admits `react` **and**
> `vue` (Svelte joined in Phase 6d).
>
> **Phase 4 shipped (default-deny enforcement — full command surface).**
> Opt-in via `auth { enforcement: denyByDefault }` (default `opt` is inert). An
> IR check (`loom.default-deny-ungated`) rejects any **client-reachable command**
> on an `auth: required` deployable that declares no `requires` gate;
> `requires true` is the explicit "intentionally public" escape. Covers public
> aggregate **operations + creates + destroys** (OperationIR bodies) **and
> workflows** — every command-triggered `create … {}` starter and named
> `handle …(){}` continuation (event-triggered creates / `on(...)` reactors are
> not client-reachable, so excluded; the validate-layer analogue of the
> generator's `emitsCommandRoute`). **Reads (repository `find`s + `view`s) stay
> out of scope by design:** the grammar gives them no `requires` surface (only a
> `where` filter), so flagging them would leave the author no escape hatch —
> gating reads needs a `requires`-on-query language addition first (separate
> follow-up, the one remaining default-deny gap). 9 tests
> (`test/ir/default-deny.test.ts`); full fast suite green.
>
> **Phase 2a shipped (.NET `/auth/me` parity).** The .NET backend now maps
> `GET /auth/me` (the session probe the React `auth: ui` guard reads) when
> `auth: required`, so a React frontend can target a .NET backend (dev-stub
> identity today). Verified with the local .NET 8 SDK: `dotnet build
> -warnaserror` (the `AnalysisLevel: latest-recommended` CA gate) → 0
> warnings.
>
> **Phase 2b shipped (.NET OIDC token verifier).** Under an `auth { oidc }`
> block the .NET backend emits `Auth/OidcUserVerifier.cs` — an
> `IUserVerifier` that validates the bearer token against the issuer's JWKS
> (`ConfigurationManager<OpenIdConnectConfiguration>` + `JsonWebTokenHandler`),
> checks iss/aud/exp, and projects the configured claims onto `User`
> (string / string[], dotted paths like `realm_access.roles` supported;
> other field types fall back to `default!`). Auto-registered in
> `Program.cs` (last-wins over the dev stub); the
> `Microsoft.IdentityModel.*` NuGet refs ship only under OIDC.
> **tsc-and-CA-gated:** an `auth-oidc` fixture in the `LOOM_DOTNET_BUILD`
> shard generates + `dotnet build -warnaserror`s the project (the
> `AnalysisLevel: latest-recommended` CA gate) — verified locally, 0
> warnings.
>
> **Phase 2c shipped (.NET `/auth/*` handshake — .NET OIDC complete).** The
> .NET backend now emits `Auth/AuthHandshake.cs` — `MapAuthHandshake()`
> mounting `/auth/login` (authorization-code redirect + state cookie),
> `/auth/callback` (code→token exchange via `HttpClient` + issues the
> HttpOnly `session` cookie), and `/auth/logout`. The middleware bypasses
> those three paths; `OidcUserVerifier` now reads the token from the Bearer
> header **or** the `session` cookie, so the browser flow connects
> end-to-end (login → callback → cookie → `/auth/me` → guard). Compiles
> under `dotnet build -warnaserror` (CA gate) — verified locally via the
> existing `auth-oidc` `LOOM_DOTNET_BUILD` cell. **Runtime correctness vs a
> real IdP** is still unverified (no Keycloak in CI yet — Phase 3 would
> close that). The .NET OIDC story is now: verifier + `/auth/me` +
> handshake, matching Hono.
>
> **Phase 3 shipped (bundled dev Keycloak — the zero-config quick-start).**
> When a system declares a self-hosted OIDC `auth { … }` block (provider
> `keycloak` / `custom` / a raw `oidc { issuer }`), the generated
> `docker-compose.yml` now adds a **Keycloak** service (`--import-realm`) +
> a `keycloak/realm.json` (a public client with wildcard-localhost redirect
> URIs + a seeded `demo`/`demo` user with `user`/`agent` realm roles), and
> wires the `auth: required` backend's `OIDC_ISSUER` / `OIDC_CLIENT_ID` /
> `OIDC_REDIRECT_URI` + `depends_on` at it. Uses `host.docker.internal` so
> the browser (redirects) and backend (JWKS/token) resolve the **same**
> issuer URL — sidestepping the Docker localhost-vs-service-name mismatch.
> Hosted presets (google / auth0 / …) get no bundled service. Compose YAML
> validated; 3 content tests. **Runtime correctness (an actual
> `docker compose up` + login) is not yet CI-verified** — a docker-gated
> obs/e2e cell booting the stack + completing the flow is the natural
> follow-up (and would finally runtime-close the Hono + .NET OIDC paths).
>
> **OIDC runtime e2e shipped — the chain is now RUNTIME-verified.** A new
> docker-gated suite (`test/e2e/auth-oidc-e2e.test.ts`, `LOOM_AUTH_E2E=1`,
> CI workflow `hono-oidc-e2e.yml`) boots a **real Keycloak** (the Phase 3
> bundled realm import) + postgres in docker, runs the generated Hono
> backend natively, password-grants a real token for the seeded `demo`
> user, and asserts the **generated `OidcUserVerifier` validates it against
> Keycloak's live JWKS** and maps the claims onto `User` — including the
> dotted `realm_access.roles` path (`/auth/me` → `{id←sub, roles←
> realm_access.roles, email}`), rejecting no-token and forged-token with
> 401. **Verified passing locally** (booted Keycloak + the backend, ran the
> flow). This converts the "compile-verified, not runtime-verified" caveat
> on the OIDC verifier path into actually-verified. (The native-backend
> harness sidesteps in-container npm egress; the full-compose
> `host.docker.internal` wiring stays content-tested.)
>
> **.NET OIDC runtime e2e shipped too — and it caught a real bug.** The
> `.NET` sibling suite (`test/e2e/auth-oidc-dotnet-e2e.test.ts`,
> `LOOM_AUTH_E2E_DOTNET=1`, CI workflow `dotnet-oidc-e2e.yml`) runs the
> generated **.NET** backend natively (`dotnet run`) against the same real
> Keycloak + postgres and asserts the same flow (401 no-token, 200 with a
> real token, `/auth/me` → `{id←sub, roles←realm_access.roles, email}`, 401
> forged). It surfaced what the compile-only `/warnaserror` gate couldn't:
> the generated `OidcUserVerifier` wired `HttpDocumentRetriever` with its
> default `RequireHttps = true`, so discovery against a plain-**http** issuer
> (the bundled dev Keycloak / loopback) threw and rejected **every** request
> with 401. Fixed in `src/generator/dotnet/auth-emit.ts`: `RequireHttps`
> now tracks the issuer scheme (`https://` stays strict; `http://` dev /
> loopback opts out). **Verified passing locally** (booted Keycloak + the
> .NET backend, ran the flow); `/warnaserror` still clean.
>
> **Full-compose OIDC e2e shipped — the turnkey stack is now runtime-tested.**
> The earlier caveat ("the full-compose `host.docker.internal` wiring stays
> content-tested") is now closed by `test/e2e/auth-oidc-compose-e2e.test.ts`
> (`LOOM_AUTH_E2E_COMPOSE=1`, CI workflow `auth-oidc-compose-e2e.yml`), which
> boots the **generated `docker-compose.yml` as-is** — the containerized
> backend (`build: ./api`) + the bundled dev Keycloak — and asserts the same
> flow against the **cross-container** `host.docker.internal` / KC_HOSTNAME
> bridge the emitted compose ships (the native suites talk to Keycloak over
> plain localhost; this exercises the host-gateway path). It can't run in the
> dev sandbox (in-container package egress is blocked, so the inner image
> build would hang) — it's a CI-only gate. The novel host-side path (the
> runner password-grants from `localhost:8081` while KC_HOSTNAME pins the
> issuer to `host.docker.internal:8081`) was **de-risked locally**: booted
> just the Keycloak service from the generated compose and confirmed the
> grant returns a token whose `iss` is `host.docker.internal:8081` (matching
> the api container's `OIDC_ISSUER`) with `realm_access.roles=[agent,user]`.
>
> **Phase 5 — Python OIDC shipped (FastAPI verifier + handshake — backend
> matrix complete).** Under an `auth { oidc }` block the Python backend now
> emits `app/auth/oidc.py` — a verifier that validates the bearer token against
> the issuer's JWKS via **PyJWT** (`PyJWKClient`, discovered from
> `.well-known/openid-configuration`), checks iss / exp / aud, and projects the
> configured claims onto the typed `User` (dotted paths like
> `realm_access.roles`) — plus the `/auth/login|callback|logout` redirect
> handshake (state cookie → code exchange via `urllib` → HttpOnly `session`
> cookie, read by the verifier). It's auto-registered in `main.py` in place of
> the dev stub; `app/auth/routes.py` adds the `/auth/me` probe (always present
> under `auth: required` — Python previously had **no** `/auth/me`, so a
> frontend guard targeting Python is now wired); the middleware bypasses the
> three handshake paths; `pyjwt[crypto]` ships in `pyproject.toml` only under
> OIDC. Issuer read at runtime; PyJWKClient/urllib impose no https requirement,
> so the plain-http dev Keycloak works. Dev-stub path stays byte-identical.
> **Verified locally end-to-end** (`uv run ruff` + `mypy --strict` clean on both
> paths; a native-uvicorn runtime e2e against a real Keycloak: 401 no-token /
> 200 with token / `/auth/me` → `{id←sub, roles←realm_access.roles, email}` /
> 401 forged / `/auth/login` → 307-to-IdP). 5 codegen tests
> (`test/generator/python/python-auth-oidc.test.ts`); compile gate adds the
> `auth-oidc.ddd` python-build fixture (ruff + `mypy --strict`); runtime e2e
> `auth-oidc-python-e2e.test.ts` (`LOOM_AUTH_E2E_PYTHON=1`, workflow
> `python-oidc-e2e.yml`). **All five backends now ship the OIDC verifier +
> /auth/me + handshake.**
>
> **Phase 5 — Java OIDC shipped (Spring Boot verifier + handshake).** Under an
> `auth { oidc }` block the Java backend now emits `auth/OidcUserVerifier.java`
> — a `@Primary` `UserVerifier` bean that validates the bearer token against the
> issuer's JWKS (discovered via `.well-known/openid-configuration`, cached via
> Nimbus `JWKSourceBuilder`), checks iss / exp, and projects the configured
> claims onto the typed `User` (string / string[], dotted paths like
> `realm_access.roles`; other field types fall back to the dev-stub default).
> `@Primary` makes it win over the `@Component` `DevStubUserVerifier` the moment
> an `auth { oidc }` block is present (the Spring analogue of .NET's last-wins DI
> + Hono's auto-register). It also emits `auth/AuthController.java` — `@Hidden`
> (kept out of the springdoc OpenAPI contract, cross-backend parity) — with
> `/auth/me` (the session probe; protected, always present under `auth:
> required`) and, under OIDC, the `/auth/login|callback|logout` redirect
> handshake (state cookie → code exchange → HttpOnly `session` cookie, read by
> the verifier). `UserFilter` bypasses the three handshake paths; `/auth/me`
> stays gated. `nimbus-jose-jwt` (pinned version — the Spring Boot BOM does not
> manage it without spring-security-oauth2-jose) ships in
> `build.gradle.kts` only under OIDC; non-OIDC `auth: required` projects keep
> only the dev stub + `/auth/me` (byte-identical otherwise). **The .NET
> `RequireHttps` trap does not arise here** — Nimbus's default resource
> retriever fetches http and https alike, so the bundled dev Keycloak (plain
> http) works without a scheme opt-out (documented in the generated verifier).
> 8 codegen tests (`test/generator/java/generator-java-auth-oidc.test.ts`);
> full fast suite green. **Compile-gated:** an `auth-oidc` fixture in the
> `LOOM_JAVA_BUILD` shard (`test/e2e/fixtures/java-build/auth-oidc.ddd`)
> `gradle testClasses bootJar`s the generated project — covering the Nimbus API
> usage + the pinned dependency resolution. **Runtime e2e:**
> `test/e2e/auth-oidc-java-e2e.test.ts` (`LOOM_AUTH_E2E_JAVA=1`, CI workflow
> `java-oidc-e2e.yml`) boots a real Keycloak + postgres in docker, builds + runs
> the generated backend natively (`gradle bootJar` → `java -jar`), password-
> grants a token for the seeded `demo` user, and asserts 401 no-token / 200 with
> token / `/auth/me` → `{id←sub, roles←realm_access.roles, email}` / 401 forged.
> **The container e2e + `LOOM_JAVA_BUILD` gate can only be confirmed in CI**
> (the dev sandbox has no JDK/Gradle/docker) — the generated output was inspected
> by hand and the fast-suite codegen tests pin its shape.
>
> **Status: Phases 0–1, 2 (.NET), 3 (dev Keycloak), 4 (partial), 5 COMPLETE
> (all five backends — Hono/.NET/Phoenix/Java/Python — ship the OIDC verifier
> + /auth/me + /auth/login|callback|logout handshake, each runtime-e2e'd
> against a real Keycloak), 6 COMPLETE (React + Vue + Svelte `auth: ui`
> guards), 7 done. Phase 4 default-deny now covers the full **command** surface
> (operations + creates + destroys + workflows). Remaining: default-deny for
> **reads** (finds/views — needs a `requires`-on-query grammar addition) + a
> Phoenix-LiveView frontend guard.** Decisions locked
> with the maintainer (2026-06-15):
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
| Python | `src/generator/python/auth-emit.ts` | `app/auth/{user,verifier,middleware,routes}.py` + `oidc.py` (OIDC) | OIDC: PyJWT + JWKS; dev stub otherwise | `/auth/me` + `/auth/login\|callback\|logout` handshake |
| Phoenix | `src/generator/elixir/auth-emit.ts` | `auth.ex`, `live_auth.ex`, `auth_controller.ex` | OIDC: JOSE + JWKS (`verify_token/1`); dev stub otherwise | `/auth/me` + `/auth/login\|callback\|logout` handshake |
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

  deployable api { platform: node, contexts: [...], dataSources: [...], auth: required }
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

> **Phoenix OIDC verifier shipped (verifier slice).** `src/generator/elixir/
> auth-emit.ts` now emits a REAL OIDC verifier in `ApiWeb.Auth` when an
> `auth { oidc }` block is present (previously the dev stub only): JOSE
> `verify_strict` against the issuer's JWKS, discovered via `:httpc`
> (`/.well-known/openid-configuration` → `jwks_uri`) and cached in
> `:persistent_term` (no supervised process); `iss`/`exp` checked; claims
> projected onto the `user {}` shape via dotted paths (`id ← sub` default,
> explicit `claims:` win — e.g. `realm_access.roles`). The issuer is read at
> **runtime** (a module attribute would freeze the empty compile-time env into
> the release — the Phoenix analogue of the .NET `RequireHttps` gotcha; here a
> plain-http dev issuer "just works" since `:httpc` imposes no https). `mix.exs`
> pulls `{:jose, "~> 1.11"}` + `:inets`/`:ssl` only under OIDC; the dev-stub
> path stays byte-identical. Adds the `/auth/me` probe (`AuthController`, piped
> through `:api`) for the `auth: ui` guard. **Compilation is CI-verified** (the
> `auth-oidc.ddd` phoenix-build fixture in the `elixir-vanilla-build` gate) — there
> is no local Elixir toolchain in the dev sandbox. Generator wiring pinned by
> `test/generator/elixir/auth-oidc-emit.test.ts`.
>
> **Phoenix runtime e2e shipped — the verifier is now RUNTIME-proven.**
> `test/e2e/auth-oidc-phoenix-compose-e2e.test.ts` (`LOOM_AUTH_E2E_PHOENIX=1`,
> CI workflow `phoenix-oidc-e2e.yml`) boots the **generated `docker-compose.yml`
> as-is** — the containerized Phoenix release (its `bin/server` runs
> `Release.migrate()` then serves) + the bundled dev Keycloak + postgres —
> password-grants a real token for the seeded `demo` user, and asserts
> `ApiWeb.Auth` validates it against Keycloak's JWKS over `host.docker.internal`
> (401 no-token on `/api/tickets`, 200 with token, `/auth/me` →
> `{id←sub, roles←realm_access.roles, email}`, 401 forged). This is the runtime
> proof the compile + Dialyzer gates can't give — the `:httpc` JWKS fetch, the
> JOSE `verify_strict` alg set, the `:persistent_term` cache, and the `iss`
> check actually working against a real IdP (the Phoenix analogue of the bug
> the .NET runtime e2e caught). Uses the full compose (not native
> `mix phx.server`) so the generated release Dockerfile owns all prod
> boot/config/migration — no blind mix orchestration. CI-only (the inner image
> build needs hex egress); `push: main` + dispatch.
>
> **Phoenix redirect handshake shipped — Phoenix is now at full backend
> parity.** Under an `auth { oidc }` block the `AuthController` gains
> `/auth/login` (authorization-code redirect + `oidc_state` cookie),
> `/auth/callback` (code→token exchange via OTP `:httpc` + issues the HttpOnly
> `session` cookie), and `/auth/logout` — the same flow Hono / .NET ship. The
> Auth plug now reads the token from the Bearer header **or** the `session`
> cookie, and bypasses the three redirect endpoints (so they're reachable
> without a verified principal); `/auth/me` stays protected. This closes the
> browser-login path: a Phoenix LiveView app behind `auth: required`, or a
> frontend `auth: ui` guard pointed at Phoenix, can now actually sign in.
> Dev-stub path stays byte-identical. Compile-gated (the `auth-oidc.ddd`
> phoenix-build fixture now compiles the handshake under
> `--warnings-as-errors`); generator wiring in `auth-oidc-emit.test.ts`; the
> runtime e2e adds a `/auth/login` → 302-to-IdP + `oidc_state`-cookie smoke
> (the full code→token callback needs a browser, out of scope for the headless
> e2e). **Phoenix now matches Hono / .NET: verifier + /auth/me + full
> handshake, runtime-verified.**

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
