# Auth-provider agent prompt (OIDC parity)

> **How to use:** spawn an agent with
> *"Read `docs/old/plans/auth-agent-prompt.md`. Your job is `<target>`"* where
> `<target>` is **one of** `python` | `java` | `phoenix` | `vue` | `svelte`.
> That one word is the only parameter — everything else is below.

You are extending Loom's OIDC turnkey-auth feature (decision **D-AUTH-OIDC**) to one
more platform: **your target** (the word in the invoking message). Read `CLAUDE.md`
first — the language→ir→generator→system pipeline is one-directional and
test-enforced; respect the layering.

`phoenix` means the **`elixir`** generator/surface — there is no `src/generator/phoenix/`.

## What already exists (your references — read these before writing anything)

The OIDC chain is **done and runtime-verified for Hono and .NET**. Mirror them.

- Decision + language surface: `docs/auth.md`; running status/plan doc
  `docs/old/plans/auth-providers-implementation.md` (**update it when you finish**).
- Providers/presets registry: `src/util/auth-providers.ts`
- Lowering (`auth {}` block → `AuthIR`): `src/ir/lower/lower-auth.ts`; IR types
  `AuthIR` / `OidcConfigIR` / `ClaimMappingIR` / `DeployableIR.auth` in
  `src/ir/types/loom-ir.ts`.
- **Backend** reference impls — verifier = JWKS validation + iss/exp + dotted-path
  claim mapping onto the typed `user {}` shape; handshake = `/auth/login|callback|
  logout|me`; middleware enforces `auth: required`:
  - Hono: `src/platform/hono/v4/auth-emit.ts`
  - .NET: `src/generator/dotnet/auth-emit.ts` + wiring in `src/generator/dotnet/emit/program.ts`
- **Frontend** reference impl — React `auth: ui` route guard + sign-in + session:
  `src/generator/_frontend/auth-ui.ts` (framework-neutral) + emit hook in
  `src/generator/react/index.ts`.
- Your platform's generator dir `src/generator/{python|java|elixir|vue|svelte}/`
  and its surface `src/platform/{python|java|elixir|vue|svelte}.ts`.
- Runtime e2e + CI to clone:
  `test/e2e/auth-oidc-dotnet-e2e.test.ts` (native-backend boot pattern),
  `test/e2e/fixtures/auth-oidc-e2e-dotnet.ddd`,
  `.github/workflows/dotnet-oidc-e2e.yml`.

## Your task

### If your target is `python`, `java`, or `phoenix` → BACKEND VERIFIER track

1. Emit the OIDC verifier + `/auth/*` handshake + auth middleware for this backend,
   reading the agg/`user` shape and `AuthIR` straight from the IR (**do not
   re-resolve**). Honour the claim mapping including dotted paths like
   `realm_access.roles`.
2. **CRITICAL GOTCHA (a real bug that bit .NET):** a dev/bundled Keycloak issuer is
   plain **HTTP**. If your platform's JWKS/discovery client defaults to *requiring
   HTTPS*, the dev path rejects every request with 401. Make HTTPS-enforcement track
   the issuer scheme — `https://` stays strict, `http://` (dev/loopback) opts out.
3. Wire it into the backend's Program/bootstrap and the dependency manifest (pull the
   auth libs in **only when** an `auth { oidc }` block is present).
4. Add a **native** runtime e2e mirroring `auth-oidc-dotnet-e2e.test.ts`: generate the
   system, run the backend natively against a dockerized **bundled Keycloak** +
   postgres, password-grant a token for the seeded `demo` user, and assert
   `401` no-token / `200` with token / `/auth/me` → `{id←sub, roles←realm_access.roles,
   email}` / `401` forged. Gate it `LOOM_AUTH_E2E_<TARGET>=1`; add the
   `test:auth-e2e-<target>` script **and exclude it from the fast suites** in
   `package.json` (copy how `auth-oidc-dotnet-e2e` is excluded); add a `push: main` +
   `workflow_dispatch` CI workflow sibling to `dotnet-oidc-e2e.yml`.

### If your target is `vue` or `svelte` → FRONTEND GUARD track

1. Emit the `auth: ui` route guard + sign-in redirect + session handling for this
   framework, mirroring the React impl in `src/generator/_frontend/auth-ui.ts` (reuse
   the framework-neutral pieces; only the framework-shaped seam is per-target).
2. Wire the emit into the framework's generator entrypoint
   (`src/generator/{vue|svelte}/index.ts`) behind the deployable's `auth.ui` flag.
3. Add coverage to the existing generated-build path (`generated-{vue|svelte}-build`)
   so the guarded output type-checks/builds, plus a unit test asserting the guard is
   emitted when `auth.ui` is set and absent otherwise.

## Ground rules

- **Branch from fresh main:**
  `git fetch origin main && git switch -c claude/auth-oidc-<target> origin/main`.
  These tasks are **independent** — do not stack on each other.
- Add the recipe-mandated tests (`CLAUDE.md` → "Extending"): one parse test if the
  grammar changes, one negative validator test if you add a rule, one generator test
  per change.
- **Verify locally before pushing:** `npm test` (fast suite) must stay green, plus your
  platform's build gate (`test:python` / `test:java` / `test:phoenix` /
  `test:vue-build` / `test:svelte-build`). The full container e2e can only be confirmed
  in CI — **say so explicitly** rather than claiming local verification you didn't do.
- The Stop hook runs Biome (`npm run lint`) — keep it clean.
- **Update** `docs/old/plans/auth-providers-implementation.md` with what you shipped.
- Open a PR against `main`, get CI green, and report status. **Don't merge unless told.**
- Keep scope to your target only. If you hit an ambiguous design fork (e.g. how this
  framework expresses route guards), **ask** rather than guessing.
