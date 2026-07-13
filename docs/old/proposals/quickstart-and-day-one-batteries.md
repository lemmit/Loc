# Proposal: Quick-Start On-Ramp and Day-One Batteries

> **[2026-06-20 status audit]** Partially shipped (no longer 'no code yet') — `ddd new` with `--platform`/`--template blank|crud`/`--design` (`src/cli/new-templates.ts`) and turnkey OIDC `auth { oidc { … } }` (`ddd.langium`) are live. NOT shipped: `ddd dev`/`ddd deploy`, `saas` template, the §5 day-one constructs (`job`/`email`/object storage).

**Status:** PROPOSED. No code yet; surface, lowering semantics, and
build order specified below.
**Scope:** Collapse the zero-to-running path into a single opinionated
command, give the running model a unified dev loop and a one-command
deploy, and add the handful of runtime capabilities (turnkey `auth` via
OIDC delegation, `job`, `email`, object `storage`, `seed`) that nearly
every real application needs on its first day — none of which the model
can express today.

> This proposal is a *family*, not a single feature. The items are
> grouped because they share one goal — make the first hour of a Loom
> project feel like the rest of it already does — and because several
> of them (auth UI, seed, jobs) only become turnkey once the
> bootstrap + dev-loop scaffolding exists to host them. Each section is
> independently shippable; the build order at the end sequences them.

---

## 1. Background and Motivation

Loom's modeling engine is deep: one `.ddd` source lowers to a
platform-neutral IR and emits four runtimes wired as a `docker compose`
stack, with migrations, traceability, verification, conformance parity,
and a visual builder. The payoff for that depth shows up *after* you
have a model and know the workflow.

The cost shows up *before*. Three frictions stand between a newcomer and
their first running screen, and a fourth stands between a running model
and a production one:

1. **There is no on-ramp.** Today the documented path is: clone the
   generator repo, `npm install`, `langium:generate`, `build`,
   hand-author a `.ddd`, `ddd generate system`, `cd out`, `docker
   compose build`, `docker compose up`. That is a *toolchain* workflow.
   There is no `ddd new` to produce a working model, no published npm
   package so `ddd` exists without building the generator, and no
   default that picks a stack so the author isn't forced to understand
   `deployable` / `dataSource` / design-pack / platform composition
   before anything runs.

2. **There is no single dev loop.** `generate --watch` rewrites files on
   every save but stops there — the author still rebuilds and restarts
   containers by hand. There is no one process that watches the source,
   regenerates, and keeps the stack live with frontend hot-reload.

3. **There is no deploy.** `tools.md` states plainly that Loom emits no
   k8s/CI/host targets. The author who runs `docker compose up` locally
   has no `ddd`-native way to get the same stack onto a cloud host.

4. **The model can't express the day-one runtime features.** Real apps
   need authentication with a login screen, scheduled/background work,
   transactional email, file upload, and seed data on first boot. Today:
   - **Auth** (`auth.md`) gives `user {}`, `currentUser`, `permissions`,
     `requires`, and JWT-*decode* middleware — but the author hand-writes
     the verifier, and there is **no out-of-the-box identity provider
     integration, no session issuance, no login redirect/UI, and no
     default-deny**. (Per D-AUTH-OIDC the fix is OIDC delegation — Loom
     fills the verifier hook + login handshake against an external IdP,
     not a built-in password store.)
   - **Jobs / schedules** — no construct exists.
   - **Email** — no construct exists.
   - **File upload / object storage** — the `storage` enum has no object
     store, and the page DSL has no upload primitive.
   - **Seed data** — deliberately excluded from the `.loomignore`
     contract (a different concern), so a fresh stack boots empty.

Each of these is, on its own, the kind of thing a developer expects to
*not* have to hand-write. Together they are the difference between "I
modeled a domain" and "I have an application."

This proposal closes all four. Critically, the modeling depth is not the
gap — the on-ramp and a small, universal runtime surface are. Every item
below is additive: it introduces no new obligation on existing models
and changes no emitted output for a model that doesn't opt in.

---

## 2. Conceptual Model

Three of the items are **CLI / project-shape** concerns (`ddd new`, `ddd
dev`, `ddd deploy`) — they wrap the existing generator and orchestrator,
adding no IR. Five are **language surface** concerns (`auth` (OIDC),
`job`, `email`, object `storage`, `seed`) — each adds a declaration that
lowers through the normal pipeline to per-backend emission.

The dividing principle, consistent with the rest of Loom:

- **The `.ddd` source stays the single source of truth.** `ddd new`
  writes source; it does not introduce a parallel config format.
- **Generated code stays owned and overwritable.** New emitters honour
  `.loomignore` exactly like existing ones; the verifier/handler seams
  follow the established "you register an implementation, we generate the
  wiring" pattern already used by `extern` and `IUserVerifier`.
- **Defaults are opinionated; the model is not.** The quick-start picks a
  stack so a newcomer doesn't have to; every choice it bakes in is a
  plain `.ddd` declaration the author can read and change.

---

## 3. The on-ramp (CLI / project shape)

### 3.1 `ddd new` — project bootstrap

```bash
ddd new acme                       # interactive: pick a template + stack
ddd new acme --template crud       # non-interactive
npx create-loom-app acme           # same, without a global install
```

`ddd new <name>` scaffolds a ready-to-run project directory:

```
acme/
  main.ddd                 # a working model from the chosen template
  .loomignore              # seeded with the customary pins (Program.cs, index.ts, …)
  README.md                # the three commands to run it
  .loom/                   # snapshot baselines (empty, ready for first regen)
```

Templates seed `main.ddd` at increasing richness:

| Template | Seeds |
|---|---|
| `blank` | One `system` with one `module`/`context`/`aggregate` and a single backend + react deployable. |
| `crud` (default) | Two aggregates with a repository find, a UI with scaffolded pages, one backend + react frontend. |
| `saas` | `crud` plus an `auth { oidc { … } }` block (delegating to a bundled dev Keycloak, D-AUTH-OIDC), a `seed {}` block, and a protected page — the canonical "real app skeleton" (consumes §6.1, §6.5). |

Selecting a template runs the model straight through `ddd generate
system` so the directory is provably valid before the author touches it.

### 3.2 npm publish

`loc-ddd-dsl` (binary `ddd`) is published to npm so `npx loom …`,
`npx create-loom-app`, and `npm i -g loc-ddd-dsl` work without cloning
and building the generator. This is a packaging/release task, not a code
change, but it is the precondition for every command above being usable.
The `prepare` lifecycle (`langium:generate && build`) already produces a
runnable artifact; publishing wires it to the registry.

### 3.3 `ddd dev` — the unified dev loop

```bash
ddd dev                            # watch main.ddd → regenerate → keep the stack live
```

One foreground process that:

1. Watches the source (and its `import` graph) with the existing
   debounced watcher.
2. On change, regenerates via the in-process system orchestrator (no
   shelling out), honouring `.loomignore`.
3. Keeps the stack running and reconciles it to the new output — for the
   default stack, backends restart in place and the Vite frontend hot-
   reloads (the React deployable is already a standard Vite project, so
   HMR is native; the loop just keeps the dev server attached).
4. Streams a single combined log with per-deployable prefixes and the
   health state of each service.

`ddd dev` is the moment-to-moment experience the current `--watch` flag
gestures at but stops short of: today it rewrites files; here the running
system follows the model without a manual rebuild/restart.

### 3.4 `ddd deploy` — one-command cloud deploy

```bash
ddd deploy fly                     # provision + push the whole stack
ddd deploy render
ddd deploy railway
```

Loom already emits per-deployable Dockerfiles, a `docker-compose.yml`,
per-deployable databases, and `/health` endpoints — everything a host
needs. `ddd deploy <target>` is a thin provider adapter that translates
the composed system into the target's deploy primitive (Fly machines /
Render services / Railway services), wires the managed Postgres per
deployable, injects the connection strings the generated code already
reads (`DATABASE_URL`, `ConnectionStrings__Default`), and pushes.

The target adapters live behind a small `DeployTarget` contract
(`provision`, `push`, `envFor(deployable)`) so adding a host is writing
one adapter, mirroring the `PlatformSurface` pattern. Deploy manifests
are generated artefacts under `.loom/deploy/<target>/` and are
`.loomignore`-pinnable for hand-tuning. This proposal does **not** add
k8s manifest generation — that remains an explicit non-goal per
`tools.md`; the deploy targets are PaaS-shaped.

---

## 4. Turnkey authentication — delegate to OIDC (D-AUTH-OIDC)

This is the largest runtime gap. Per **D-AUTH-OIDC**, turnkey auth
**delegates to an OIDC identity provider** rather than having Loom build
an auth runtime — **Keycloak** is the self-hostable default; Auth0 /
Cognito / Zitadel / Ory / Entra ID are the same `issuer` URL to Loom. It
keeps everything `auth.md` already ships (the typed `user {}`,
`currentUser`, `permissions`, `requires`, row-level finds) and
**completes the verifier hook**: Loom validates the IdP's tokens and maps
claims into the typed `user {}` shape; the IdP owns credential storage,
password reset, MFA, lockout, and the hosted login/signup pages. "Don't
roll your own auth" — and definitely not across three backends × four
design packs.

### 4.1 Surface

A system-level `auth { … }` block, sibling to `user { … }`:

```ddd
system Acme {
  user {
    id: string
    role: string
    email: string
  }

  auth {
    oidc {
      issuer:   env("OIDC_ISSUER")     // e.g. https://idp/realms/acme (Keycloak)
      clientId: env("OIDC_CLIENT_ID")  // clientSecret via env for confidential clients
    }
    sessions: cookie                   // cookie | jwt — how the app holds the post-login session
    claims:   { role: "realm_access.roles", email: "email" }   // IdP claim → user{} field
  }

  // existing per-deployable opt-in is unchanged
  deployable api  { platform: node, contexts: [...], dataSources: [...], auth: required }
  deployable web  { platform: react, targets: api, auth: ui }   // mounts the login redirect + guard
}
```

`auth {}` is admissible only alongside a `user {}` block. Declaring it:

- Generates a **real verifier** — the batteries-included fill-in for the
  already-shipped `IUserVerifier` / `registerUserVerifier` seam — that
  validates the OIDC token (JWKS signature, `iss` / `aud` / `exp`), maps
  the configured `claims:` into the typed `User` shape, and rejects
  otherwise. The hand-written seam stays as an override.
- Generates the **login handshake, not a login form**: `/auth/login`
  redirects to the IdP's authorization endpoint, `/auth/callback`
  exchanges the code and issues the local session (signed `HttpOnly`
  cookie or forwarded JWT per `sessions:`), `/auth/logout` clears it.
  There is **no signup / password / verify-email endpoint** — the IdP
  hosts those.
- On a `react` / LiveView deployable with `auth: ui`: a **route guard** +
  session-aware API client + a "Sign in" affordance that starts the
  redirect. **No login/signup pages are generated** — the IdP's hosted
  pages are used (themed in the IdP).

**No `AuthUser` aggregate, no password column, no OAuth client code.**
The identity lives in the IdP; Loom's `user {}` stays the *projection* of
its claims, exactly as today — just with a generated verifier instead of
a hand-written one.

### 4.2 Zero-config quick-start — a bundled dev IdP

The one cost of self-hosted OIDC — standing up an IdP — is closed by
**bundling a dev IdP**: the generated `docker-compose.yml` adds a
**Keycloak** service with a pre-provisioned realm (client, redirect URIs)
and a **seeded demo user**, so `docker compose up` logs in out of the
box; production repoints the same `issuer:` at a real Keycloak / hosted
IdP. The demo user is *seed data* (§5.4) — the quick-start auth story is
"bundled Keycloak realm + a seeded user," with Loom owning **zero** auth
logic.

### 4.3 Default-deny

`auth.md` lists default-deny as a known hole: an `auth: required`
deployable still serves operations that declare no `requires` gate. This
proposal closes it under the `auth {}` block (orthogonal to OIDC):

```ddd
auth { oidc { … }, enforcement: denyByDefault }
```

Under `denyByDefault`, every operation / find / view / workflow reachable
on an `auth: required` deployable must declare a `requires` gate (or an
explicit `requires anonymous`) — the IR validator rejects an ungated
reachable command. `enforcement: opt` preserves today's behaviour as the
default so existing models don't break.

### 4.4 Lowering & per-backend emission

There is **no domain aggregate to lower** — the work is per-backend OIDC
middleware + the `/auth/*` redirect handshake, emitted alongside the
existing auth files, each backend using its standard OIDC library:

| Backend | Adds |
|---|---|
| Hono | OIDC token verify (`jose` + JWKS), the `/auth/login\|callback\|logout` redirect handlers, session cookie / JWT issue; the generated verifier replaces the manual registry. |
| .NET | `AddOpenIdConnect` / `AddJwtBearer` (Microsoft.Identity.Web) + the same `/auth/*` handlers; the generated `IUserVerifier` is registered automatically. |
| Phoenix | An `oidcc` / `Ueberauth`-shaped OIDC strategy + the LiveView login redirect + session plug. |
| React | Route guard, session-aware client, "Sign in" redirect (no login form). |

A self-contained email/password mode, if ever wanted, is a **secondary,
library-backed** option (never hand-rolled across backends) — explicitly
not the headline.

---

## 5. Day-one runtime constructs

### 5.1 `job` — background and scheduled work

```ddd
context Billing {
  job nightlyClose {
    every: "0 2 * * *"          // cron; omit for an on-demand job
    runs:  closeBooks           // an existing workflow in this context
  }
  job onSignup {
    on:    UserRegistered       // event-triggered (drains the event bus)
    runs:  sendWelcome
  }
}
```

A `job` is context-level orchestration glue — like `workflow`, it
invokes domain operations/workflows, but it is *driven* by a schedule or
an event rather than an HTTP request. It introduces no new expression
surface: `runs:` points at a workflow, reusing all existing body and
transaction semantics.

| Backend | Driver |
|---|---|
| Hono | BullMQ (Redis) for queued/scheduled jobs; a cron scheduler for `every:`. |
| .NET | Hangfire or Quartz.NET. |
| Phoenix | Oban. |

`every:`/`on:` jobs need an infrastructure dependency (a Redis/queue
`storage`); the validator enforces that a job-bearing deployable binds
one, reusing the storage/dataSource compatibility machinery.

### 5.2 `email` — transactional email

```ddd
system Acme {
  email {
    provider: smtp              // smtp | sendgrid | ses | postmark
    from: "no-reply@acme.test"
  }
}
```

Generates a `sendEmail(to, template, data)` capability callable from
workflow and job bodies, plus typed `template` entries (subject + body,
i18n-ready). The provider is a runtime adapter behind a small contract;
credentials come from environment variables the generated code reads, in
the same style as `DATABASE_URL`. Email verification (§4) consumes this
when present.

### 5.3 Object storage + upload

Extend the existing `storage` type enum (`architecture.md`) with an
object store:

```ddd
storage assets { type: s3 }      // s3 | gcs | azureBlob | localDisk
```

and add a `File` field type + an `Upload` page-DSL primitive:

```ddd
aggregate Document {
  title: string
  file: File                     // stored object reference (url + key + contentType + size)
}
```

The backend emits presigned-upload endpoints and a `File` wire shape; the
walker's `Upload` primitive renders a design-pack file input that uploads
to the presign URL and binds the resulting reference. `localDisk` keeps
the quick-start dependency-free; cloud stores are the same surface with a
different adapter.

### 5.4 `seed` — first-boot data

```ddd
context Catalog {
  seed {
    Product.create({ sku: "DEMO-1", price: { amount: 9.99, currency: "USD" } })
    Product.create({ sku: "DEMO-2", price: { amount: 19.99, currency: "USD" } })
  }
}
```

A `seed {}` body is the same statement surface as a workflow, run once
against an empty database on first boot (guarded by a seed-marker row so
it is idempotent across restarts). This is distinct from the
`.loomignore` "no first-run magic" rule, which governs *generated files*;
`seed` governs *data* and is explicit in the model, not implicit in the
generator. It makes the quick-start app show content immediately instead
of an empty list.

---

## 6. Validation rules (new)

| Situation | Diagnostic |
|---|---|
| `auth {}` without a `user {}` block | "auth block requires a `user { … }` block to define the identity shape." |
| `auth { oidc { … } }` without an `issuer:` / `clientId:` | Error: "oidc requires `issuer` and `clientId` (env-bound)." |
| an `auth.claims:` entry maps a field not present on `user { … }` | Error: "claim mapping targets unknown user field 'X'." |
| `enforcement: denyByDefault` with an ungated reachable command | Error at the operation/find/view: "reachable under `auth: required` with `denyByDefault` but declares no `requires` gate (use `requires anonymous` to allow)." |
| `job` with both `every:` and `on:` | Error: "a job is either scheduled (`every:`) or event-triggered (`on:`), not both." |
| `job` on a deployable with no queue/cron-capable dataSource | Error: "job 'X' needs a queue storage; deployable 'D' binds none." |
| `email` template referenced by `sendEmail` not declared | Error: "no email template named 'X'." |
| `File` field on an aggregate hosted by a deployable binding no object `storage` | Error: "aggregate 'A' has a `File` field but deployable 'D' binds no object storage." |
| `seed {}` body referencing an aggregate outside its context | Error (same scoping as a workflow body). |

---

## 7. Build order

Strictly additive; each phase is independently shippable and gated by
tests in the existing suites.

1. **npm publish + `ddd new` (blank/crud) + quick-start default**
   (§3.1–3.2). Turns the toolchain into a product. No IR change.
2. **`ddd dev`** (§3.3). The moment-to-moment loop.
3. **Turnkey auth via OIDC** (§4, D-AUTH-OIDC) — the largest single
   runtime item, now scoped down to OIDC token-verify + login handshake
   + a bundled dev Keycloak (no password runtime); `saas` template
   (§3.1) lands with it.
4. **`ddd deploy fly`** (§3.4). Closes the loop to a live URL; other
   targets follow as adapters.
5. **`job` / `email` / object `storage` + `Upload` / `seed`** (§5),
   in that order of demand.

Phases 1–2 and 4 are CLI/release work over the existing orchestrator and
add no language surface. Phases 3 and 5 each follow the standard
extension recipe (grammar → validator → IR node → lower → per-backend
emit → tests), and each is opt-in: a model that declares none of these
emits byte-identically to today.

---

## 8. Open questions

1. **Session store for `sessions: cookie`.** Stateless signed cookie
   (simplest, no store) vs server-side session table (revocable). Lean
   stateless for v1 with a `sessions: serverCookie` opt-in later.
2. **Auth-user ownership across multiple backends.** When several
   deployables host auth-required contexts, which one owns the
   `AuthUser` store and verifies tokens? Likely the `migrationsOwner`-
   style single-owner rule, with peers verifying against the same secret.
3. **`ddd dev` against non-Docker local runs.** Should `dev` boot
   backends in-process (faster, no Docker) when the stack is
   all-TypeScript, and fall back to compose for polyglot stacks?
4. **Deploy secrets.** How `ddd deploy` sources provider/OAuth/email
   secrets — env passthrough vs a `.loom/deploy/secrets` contract the
   target adapter reads. Must never write secrets into generated source.
5. **`File` deletion semantics.** Whether removing a `File`-bearing
   aggregate row should delete the backing object (lifecycle coupling)
   or leave it for a sweep job.
6. **Relationship to `i18n`.** Email templates and auth UI strings are
   natural `i18n` consumers; sequencing email/auth before or after the
   i18n family (Phase 4 of the global plan) affects whether their strings
   are translatable on arrival.
