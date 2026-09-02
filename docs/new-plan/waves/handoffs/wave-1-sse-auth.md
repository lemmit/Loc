# 1g SSE auth (M-T4.12) — hand-off

*Wave 1, packet 1g. Branch `claude/wave-1-sse-auth` (NOT `claude/wave-1/sse-auth`: git refuses a ref nested under the existing `claude/wave-1` branch — `cannot lock ref 'refs/heads/claude/wave-1/sse-auth'`. Every sibling packet hit the same wall and uses the dash form.)*

### 1g SSE auth (M-T4.12) — claude/wave-1-sse-auth @ 94b09da

**Contract decided:** *the realtime stream authenticates exactly like an ordinary API call — the HttpOnly `session` cookie, via `withCredentials: true`, under the same gate that puts `credentials: "include"` on the api client.* Written into `src/ir/util/realtime-rooms.ts` as two stated rules plus one exported derivation:

- **RULE 1** — a realtime stream inherits its deployable's auth mode. The SSE route is an ordinary authenticated route: on no backend's bypass list, 401 without credentials.
- **RULE 2** — it carries the SAME credential as an ordinary API call from the same frontend, and no other. `realtimeStreamCredential(deployable, target, user)` is that gate (`auth: ui` × `auth: required` × declared `user { }` — byte-for-byte the api client's own predicate); `auth: none` emits the v1 bare constructor unchanged.

**Why the cookie, not a query-param token.** `EventSource` cannot set an `Authorization` header by construction, so the two honest candidates were the cookie and a short-lived token in the query string. The token loses on three counts: the SPA never sees the raw token (auth.md "Session depth" — all access/refresh tokens ride HttpOnly cookies), so a NEW mint endpoint and a NEW token type would have to be emitted on all five backends; a URL-borne credential lands in access, proxy and `Referer` logs; and four of five backends already accept the `session` cookie alongside `Authorization: Bearer`, while every backend already emits `Access-Control-Allow-Credentials: true` for its frontend origin. Cost of the cookie: one constructor argument on the client, one cookie read on one server.

**Verify-first evidence (probe generated on this base, `auth: required` node backend + `auth: ui` react SPA + a `delivery: broadcast` channel):**

- emitted `web/src/api/client.ts` → `credentials: "include"` (twice: the call and the silent-refresh retry);
- emitted `web/src/api/realtime.ts` → `new EventSource(\`${API_BASE_URL}/realtime/events\`)` — bare;
- emitted `docker-compose.yml` → `VITE_API_BASE_URL: "http://localhost:8080/api"` with `CORS_ORIGIN: "http://localhost:3001"`, i.e. the shipped default is **cross-origin**, so the browser omits the cookie on that bare stream;
- emitted `api/http/index.ts` mounts `app.route("/api/realtime", realtimeRoutes())` — not on `BYPASS_PREFIXES`, so `authMiddleware` challenges it;
- emitted `api/auth/oidc.ts` extracted the token from the `Authorization` header **only** — no cookie arm, unlike .NET (`auth-emit.ts:289`), Java (`emit/auth.ts:790`), Python (`auth-emit.ts:636`) and Phoenix (`auth-emit.ts:405`). So on node the stream 401s even *with* `withCredentials`.

| target | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| react | fixed | `test/generator/_frontend/realtime-stream-auth.test.ts` → `react: an auth: ui SPA opens the stream with withCredentials` | shared `renderRealtimeClient`; one-line call-site change |
| vue | fixed | same file → `vue: an auth: ui SPA opens the stream with withCredentials` | same shared emitter |
| svelte | fixed | same file → `svelte: an auth: ui SPA opens the stream with withCredentials` | same shared emitter |
| angular | fixed | same file → `angular: an auth: ui SPA opens the stream with withCredentials` | same shared emitter |
| feliz | fixed (was contract-conformant, now explicit) | same file → `feliz: an auth: ui app opens the stream with withCredentials` | its `[<Emit>]` shim + relative `/api/...` routes were already same-origin, where the cookie flows either way; it now *states* the credential so the contract does not silently depend on the base staying same-origin |
| flutter | **handed off** | — | blocked upstream: flutter has NO credential path to inherit (below) |
| node (Hono v4+v5) SSE plug | fixed | same file → `node's OIDC verifier accepts the session cookie the stream presents` | added the `session` cookie arm to the emitted `bearer()`, identical in shape to the other four |
| .NET / Java / Python / Phoenix SSE plugs | already-ok | (no change) | all four already read the `session` cookie; elixir's `:sse` pipeline carries the Auth plug since #2667 §A4 |
| `auth: none` deployables | already-ok, pinned | same file → `<framework>: an auth: none SPA keeps the bare v1 constructor` (× 4 + feliz) | byte-identical; the pre-existing `*-realtime.test.ts` suites (27 assertions) still pass unchanged |

**Mutation proofs** (file copied aside to a flattened-path backup, mutated, restored **by copy** — never `git checkout --`, per §84):

1. `src/generator/_frontend/realtime.ts` — credential arm collapsed to the bare URL → the four `<framework>: an auth: ui SPA opens the stream with withCredentials` assertions fail with `expected … to contain 'new EventSource(\`${API_BASE_URL}/realtime/events\`, { withCredentials: true })'`. 4 failed / 10 passed.
2. `src/platform/hono/v4/auth-emit.ts` — cookie fallback removed → `node's OIDC verifier accepts the session cookie the stream presents` fails on `expected … to contain 'const cookies = req.headers.get("cookie");'`. 1 failed / 13 passed.
3. `src/generator/feliz/realtime.ts` — credential arm collapsed to the bare `[<Emit>]` → `feliz: an auth: ui app opens the stream with withCredentials` fails. 1 failed / 15 passed.

**Files outside the fence (flag for the coordinator):**

- `src/platform/hono/v4/auth-emit.ts` — inside packet **1c**'s `src/platform/hono/**` fence, not in 1g's `**/*realtime*|*sse*` glob. Touched deliberately: node's "SSE plug" *is* the shared `authMiddleware`/verifier, and without this the client-side fix is inert on the default backend. The diff is one function (`bearer()`); 1c's rows are all adapter/expression/paging work, so a textual conflict is unlikely, but this is the one file to check when folding.
- `src/generator/{react,vue,svelte,angular}/index.ts` — inside packet **1f**'s fence. One `out.set(".../realtime.ts", …)` call site each plus one import line; no error-boundary / aria / chrome lines touched (1f's rows).
- `src/generator/feliz/index.ts` + `feliz/realtime.ts` — not in any other packet's fence; named in 1g's brief ("check feliz … and treat them the same way").
- `test/e2e/fixtures/auth-oidc-e2e.ddd` is shared with `test/e2e/auth-oidc-e2e.test.ts` (native leg) and the two OIDC workflows; the addition is one `event` + one `channel`, which emits the realtime route and changes no existing assertion.

**Local gates run + results:**

- `npx tsc -b` — clean at every step.
- `npx vitest run test/generator/_frontend/realtime-stream-auth.test.ts` — **16 passed** (new file).
- `npx vitest run test/generator/{feliz/feliz-realtime,svelte/svelte-realtime,vue/vue-realtime,angular/angular-realtime,typescript/realtime-emission}.test.ts` — **27 passed**, unchanged (the `auth: none` byte-identical guarantee).
- `npx biome ci` over every changed file — clean.
- `node bin/cli.js parse test/e2e/fixtures/auth-oidc-e2e.ddd` — 0 errors (2 pre-existing `find`-shape warnings).
- Probe generation (`generate system`) before **and** after, diffing the emitted client / verifier / compose.

**Runtime verification:** the two OIDC runtime legs were **extended, not merely pinned** — `test/e2e/auth-oidc-e2e.test.ts` (`LOOM_AUTH_E2E=1`, backend native + dockerized Keycloak/postgres) and `test/e2e/auth-oidc-compose-e2e.test.ts` (`LOOM_AUTH_E2E_COMPOSE=1`, the turnkey `docker compose up`) now, with a **real Keycloak access token**:

- `GET /api/realtime/events` with no credential → **401** (RULE 1: the stream inherits the deployable's auth mode);
- `GET /api/auth/me` with `Cookie: session=<token>` and no `Authorization` header → **200**, roles projected (the node cookie arm, at runtime);
- `GET /api/realtime/events` with the same cookie → **200** + `content-type: text/event-stream` (RULE 2), aborted as soon as the headers land.

This is the first runtime coverage realtime has had on any backend (`M-T1.10-realtime-no-runtime-e2e` recorded that it had none — which is exactly why the auth hole shipped green). Both legs are opt-in and post-merge-only; the `run-auth` / OIDC feature labels force them onto a PR.

**Open questions for the coordinator:**

1. **Flutter is a genuine hand-off, not a skip.** Its stream (`loomEventSource(apiUri('/realtime/events'), …)`) carries no credential — but neither does any flutter API call: they are bare top-level `http.get/post`, with no `BrowserClient..withCredentials` and no cookie jar anywhere in `src/generator/flutter/**`. There is no "same credential path" to inherit, so fixing only the stream would be theatre. The exact change, for whoever picks it up: (i) give flutter an authenticated http client — `BrowserClient()..withCredentials = true` on web, a cookie jar or bearer store on native; (ii) thread the credential into `renderFlutterRealtime` and emit `web.EventSource(uri.toString(), web.EventSourceInit(withCredentials: true))` in `REALTIME_SOURCE_WEB_DART`; (iii) **decide the native story** — an HttpOnly cookie cannot exist on a mobile client, so native needs a bearer the IO transport sets on the request, which is a *different* credential and therefore a plan amendment (a third rule), not a port. That decision is above this packet's pay grade.
2. **The node cookie gap was wider than the SSE stream.** With a cross-origin base — which the generated compose ships — an `auth: ui` React SPA on node could not authenticate *any* call, because the api client sends the cookie and the verifier read only the header. That is fixed here as a side effect. It suggests `auth-gate-ui-e2e` / the behavioural harness never drive a node SPA cross-origin against `auth: required`; worth a follow-up mission if the coordinator agrees it is a separate hole.
3. **Half (a)'s conformance test is only half-built.** RULE 1 is asserted at runtime on node only. A cross-backend emitter test — every SSE route sits behind the auth plug and appears on no bypass list, on all five — is still unwritten and would be cheap. The §A9 durable-tee rule (the other clause (a) asks the plan to state) is untouched and stays with M-T4.3.
4. **No browser-level leg.** Nothing drives a real `EventSource` from an authenticated SPA and reads a frame. The runtime legs prove the *server* accepts the cookie the client now sends; that `withCredentials: true` actually attaches it is `EventSource` spec behaviour, pinned only by the generator assertion. Closing that needs a Playwright leg against a booted auth-required stack, which did not fit this packet's box.
