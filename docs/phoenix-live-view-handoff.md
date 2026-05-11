# Phoenix LiveView backend — session handoff

**Status as of last commit:** Phoenix backend is functionally substantial but **`mix compile --warnings-as-errors` still fails on the CI Phoenix-build gate.**  Three PRs are open or in-flight; one is merged.  Pick up here.

---

## Open PRs (stacked)

### #121 — form-of input emission + `@form` mount (✅ merged)
Branch: `claude/fix-phoenix-scaffold-form-placeholder`
Fixed two combined bugs: every `new <Aggregate>` page emitted `<.input field={@form[:_placeholder]}>` instead of resolving aggregate fields, and `mount/3` never assigned `@form`.

### #122 — Ash 3.x compile errors: `:update` + `get_by:` + `:all` cleanup (🔄 CI failing)
Branch: `claude/fix-phoenix-update-action`
Three fixes for compile-time errors I diagnosed from inspecting generated source:
1. `defaults [:read, :destroy]` → `defaults [:read, :update, :destroy]` (domain-emit.ts)
2. `args: [:id]` → `get_by: [:id]` on update/destroy defines (index.ts)
3. Skip the auto-enriched `:all` find in the Phoenix emitter (repository-emit.ts + index.ts)

**`build-generated-phoenix` CI job STILL FAILED** after these fixes.  I could not fetch the failure log from this sandbox (rate-limited anonymous API, no GH token in env, `Resource not accessible by integration` on `pull_request_read::get_status`).  **First task in the desktop session: open https://github.com/lemmit/Loc/actions/runs/25679365980/job/75386282051 and paste the actual `mix compile --warnings-as-errors` output** so the next fix is targeted not guessed.

### #123 — aggregate CRUD controllers + routes + `@derive Jason.Encoder` (🔄 CI in progress)
Branch: `claude/fix-phoenix-api-controllers`
Closes the OpenAPI<->router gap: emits `AggregatesController` with 5 actions per aggregate (list/get/create/update/destroy), router entries under `/api/aggregates/<plural>`, and `@derive {Jason.Encoder, only: [...]}` on each aggregate resource so `json(conn, record)` works.  Stacks on #122 (the controller actions call domain code-interface entries whose argument shape was fixed there).

---

## Reproducing locally

The desktop session should have docker.  Fixture .ddd is at `/tmp/acme-lv.ddd` — recreate from this content:

```loom
system AcmeLV {
  module Sales {
    context Sales {
      aggregate Customer {
        name: string display
        email: string
        invariant email.length > 0
      }
      repository Customers for Customer { }
      aggregate Order {
        customerId: Id<Customer>
        total: decimal
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin { scaffold modules: Sales }
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
```

Then:
```bash
node bin/cli.js generate system /tmp/acme-lv.ddd -o /tmp/acme-out
cd /tmp/acme-out/phoenix_app
docker run --rm -v $(pwd):/app -w /app -e MIX_ENV=prod \
  hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim \
  bash -c 'mix local.hex --force && mix local.rebar --force && \
           mix deps.get --only prod && mix compile --warnings-as-errors'
```

The opt-in equivalent in the test suite: `LOOM_PHOENIX_BUILD=1 npx vitest run test/generated-phoenix-build.test.ts` (test added in Batch F1 / PR #116).  CI runs the same check on every PR touching the Phoenix generator via `.github/workflows/phoenix-build.yml`.

---

## Known-good state (post-#121)

The generator now produces a structurally complete Phoenix project (54 files for the fixture above), all of which parse cleanly via `Code.string_to_quoted!`.  The full vitest suite is **821 / 851 passing** on `claude/fix-phoenix-api-controllers` (matches main + the 17 new tests #123 adds).

What's emitted:
- `mix.exs` with `ash ~> 3.0`, `ash_postgres`, `ash_phoenix`, `phoenix`, `phoenix_live_view`, `open_api_spex`
- `lib/<app>/<ctx>/` — Ash 3.x domain modules with `define :create_X / :list_Xs / :get_X / :update_X / :destroy_X` (post-#122)
- `lib/<app>/<ctx>/<agg>.ex` — Ash resources with `@derive Jason.Encoder` (post-#123), correct `defaults [:read, :update, :destroy]` (post-#122), invariants as Ash validations
- `lib/<app>_web/controllers/aggregates_controller.ex` — 5 actions per aggregate (post-#123)
- `lib/<app>_web/controllers/openapi_controller.ex` — serves `/api/openapi.json`
- `lib/<app>_web/api/<api>_spec.ex` — OpenApiSpex module with full path map
- `lib/<app>_web/auth.ex` + `live_auth.ex` — JWT plug + on_mount hook (gated on `auth: required`)
- `lib/<app>_web/live/<page>_live.ex` — one LiveView module per scaffolded page; mount/3 assigns `@form` for forms (post-#121), `@form[:name]`-shaped inputs per aggregate field (post-#121)
- `lib/<app>_web/router.ex` — `/api/aggregates/...` routes (post-#123), `/api/openapi.json`, `/api/workflows/...`, `/api/views/...`, `/health`, `/ready`
- `priv/repo/migrations/*` — Ecto migrations
- `Dockerfile` with proxy-CA bake (`SSL_CERT_FILE` / `HEX_CACERTS_PATH` env, `COPY certs/`)
- `e2e/` Playwright specs + per-page page objects + api e2e tests

---

## What's NOT yet covered

In rough order of impact:

1. **The CI compile failure on #122** — unknown root cause until logs are fetched.  Likely candidates from training knowledge:
   - `Ash.transaction([Domain], fn -> end)` — list form vs bare form (E3 fix, possibly wrong direction)
   - `Ash.Resource` validations module names (`string_length` should be `Ash.Resource.Validation.StringLength` or just `string_length` — both work in 3.x, but the alias path may differ in some warnings-as-errors flags)
   - `OpenApiSpex` 3.x API surface drift (E1 used 3.0 deps)
   - Missing `extensions:` on resources that have validations (some Ash 3.x versions warn if no AshPostgres extension is named)
   - `auth.ex`'s `Auth` module may have a `verify_token/1` TODO that fails compilation
   - Workflow files may reference `Ash.transaction` clauses with wrong arity
2. **Aggregate operations** — `operation foo(args) { ... }` blocks on aggregates currently have no controller action.  Wider scope, separate PR.
3. **Workflow forms (`Form(runs: <wf>)`)** — `mount/3` assigns `%{} |> to_form()` placeholder; needs AshPhoenix workflow-form mounting (#121 left this TODO).
4. **`Id<T>` selects** — render as text inputs.  Real select-with-options needs `mount/3` to load the referenced aggregate's list.
5. **Multi-form pages** — first form wins for `@form`.
6. **Update/destroy forms** — only `for_create` is wired in `mount/3`.
7. **Runtime smoke** — no human has ever booted a generated project + posted a request through it.  Even after #122/#123 land and `mix compile` passes, the API surface is unverified end-to-end.

---

## Recommended next steps for the desktop session

1. **Open https://github.com/lemmit/Loc/actions/runs/25679365980/job/75386282051** (the failing #122 build-generated-phoenix job).  Paste the actual error so it's not guesswork.
2. **Fix the compile errors** on `claude/fix-phoenix-update-action` (#122 branch), push, watch CI.
3. **Merge #122 then rebase #123** onto the new main.
4. **Watch #123 CI** — its controller emission has its own surface area; the `update_customer!(id, attrs)` call signature is the most likely failure point if `get_by:` from #122 doesn't have the right semantics.
5. **Smoke** — once both PRs are green, generate the fixture, boot it via `mix phx.server`, and `curl -X POST` against `/api/aggregates/customers`.  This is the actual proof of life.
6. **Pick up the rest** of the "NOT yet covered" list above by impact.

---

## Files this handoff touches

- This file (`docs/phoenix-live-view-handoff.md`) — new
- `/root/.claude/plans/phoenix-liveview-parity-followups.md` — earlier session's parity plan; still useful as background but **superseded** by this doc for what's actually shipped vs pending.
