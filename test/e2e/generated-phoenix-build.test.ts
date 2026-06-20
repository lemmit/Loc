import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HexMirror, startHexMirror } from "./support/hex-mirror";

// ---------------------------------------------------------------------------
// generated Phoenix project compiles against real Ash 3.x.
//
// Mirrors `test/generated-build.test.ts` (the TS-build regression):
// emit a phoenix deployable from a fixture, then run
// `mix deps.get && mix compile --warnings-as-errors` inside the
// hexpm/elixir Docker image.  Catches Ash 3.x API drift and any
// other semantic emission bug that the per-file syntax check
// (`Code.string_to_quoted!`) doesn't see.
//
// Slow (~3-5 min cold; ~30s warm with deps cache) — opt-in via
// LOOM_PHOENIX_BUILD=1 so the default `npm test` stays fast.  CI's
// `.github/workflows/elixir-ash-build.yml` runs the same check on every
// PR that touches the Phoenix generator (one fixture per matrix cell,
// selected via LOOM_PHOENIX_BUILD_CASE — see pickCases below).
//
// Fixtures live under `test/e2e/fixtures/phoenix-build/` — the
// workflow reads them too (single source of truth, so the workflow
// stays in sync without manual heredoc edits per language change).
//
// CI knob:  `LOOM_PHOENIX_OUT_DIR=<path>` — when set, the test uses
// `<path>/<fixture-stem>` as the project outDir instead of a per-run
// tmpdir.  Skips regeneration when `mix.exs` already exists at that
// path (lets the workflow pre-generate to seed the cache key), and
// skips the rm-rf cleanup so `deps/` + `_build/` survive for the
// post-job `actions/cache` save.
//
// Network requirement: `mix deps.get` reaches repo.hex.pm.  GitHub-hosted
// runners have direct access, so this test shells out to `docker run`
// unchanged.  Behind a TLS-fingerprinting egress proxy (some sandboxes)
// Erlang's :ssl is rejected with HTTP 503 even though the CA is trusted;
// set `LOOM_HEX_MIRROR=1` to route hex.pm through the loopback mirror
// (`scripts/hex-mirror.py`, see test/e2e/support/hex-mirror.ts and
// docs/tools.md).  Either way the test needs a host with passwordless
// `docker run`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "phoenix-build");

const ENABLED = process.env.LOOM_PHOENIX_BUILD === "1";

// CI shards one fixture per matrix cell (see .github/workflows/elixir-ash-build.yml)
// so a cold dep compile fits the per-cell timeout and reseeds its own cache.
// `LOOM_PHOENIX_BUILD_CASE=<fixture>.ddd` selects that single fixture; unset
// (local `npm run test:phoenix`) builds them all.  Mirrors LOOM_REACT_BUILD_CASE.
function pickCases<T extends { name: string }>(all: T[]): T[] {
  const only = process.env.LOOM_PHOENIX_BUILD_CASE;
  if (!only) return all;
  const selected = all.filter((c) => c.name === only);
  if (selected.length === 0) {
    throw new Error(
      `LOOM_PHOENIX_BUILD_CASE=${only} matched no phoenix-build fixture ` +
        `(have: ${all.map((c) => c.name).join(", ")})`,
    );
  }
  return selected;
}

const IMAGE = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";

// `mix local.hex && mix local.rebar && mix deps.get && mix compile` inside the
// elixir image.  --warnings-as-errors catches Ash 3.x API drift (deprecated
// define_for, wrong Ash.transaction signature, etc.).  When `mirror` is set
// (LOOM_HEX_MIRROR=1) the hex.pm traffic is routed through the loopback mirror
// — see test/e2e/support/hex-mirror.ts.
function runMixCompile(projDir: string, mirror: HexMirror | undefined): void {
  const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
  const shellPrefix = mirror?.shellPrefix ?? "";
  execSync(
    `docker run --rm ${dockerArgs}-v ${projDir}:/app -w /app -e MIX_ENV=prod ${IMAGE} ` +
      `bash -c '${shellPrefix}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get --only prod && mix compile --warnings-as-errors'`,
    { stdio: "inherit", timeout: 600_000 },
  );
}

describe.skipIf(!ENABLED)(
  "generated Phoenix project compiles against real Ash 3.x (LOOM_PHOENIX_BUILD=1)",
  () => {
    // Behind a TLS-fingerprinting proxy (LOOM_HEX_MIRROR=1) start one loopback
    // hex mirror for the whole suite; a no-op (undefined) with direct access.
    let mirror: HexMirror | undefined;
    beforeAll(async () => {
      mirror = await startHexMirror();
    });
    afterAll(() => {
      mirror?.stop();
    });
    it.each(
      pickCases([
        { name: "acme-lv.ddd" },
        // OIDC turnkey auth (D-AUTH-OIDC): compiles the generated ApiWeb.Auth
        // OIDC verifier (JOSE + JWKS discovery via :httpc), the /auth/me probe
        // controller, and the {:jose, ...} + :inets/:ssl mix.exs additions under
        // `mix compile --warnings-as-errors`.
        { name: "auth-oidc.ddd" },
        // Value-object array (`Money[]`) — Ash stores it inline as an
        // `{:array, Money}` embedded attribute → `{:array, :map}` column (no
        // child table); compiles the embedded-array path.
        { name: "value-collections.ddd" },
        // Reference-collection (`Id<T>[]`) fixture — exercises the m2m join
        // entity + many_to_many relationship + `manage_relationship` mutations
        // + `exists(...)` filter that Phoenix join-table emission produces.
        { name: "roster.ddd" },
        // First-boot seeding (database-seeding.md): compiles priv/repo/seeds.exs
        // (the Ash create-action seed path) + the ecto.setup alias change.
        { name: "seeding.ddd" },
        // D-PHOENIX-SURFACE: a phoenix backend that EMBEDS a React SPA
        // (hosts: a `ui { framework: react }`).  Compiles the
        // embedded-react Elixir side — the endpoint `/app` Plug.Static,
        // the router `/app` SpaController fallback, and the SpaController
        // itself — against real Ash 3.x.  No LiveView pages are emitted;
        // the React `assets/` half is covered by the react-build matrix.
        { name: "phoenix-embed-react.ddd" },
        // DestroyForm on a LiveView detail page (parity finding #5): compiles
        // the delete `<.button>`, the hoisted `destroy_widget` handle_event
        // clause, and the `~p"/widgets"` post-delete navigation.  `with crudish`
        // supplies the `destroy_widget!/1` code interface the form calls.
        { name: "destroy-form.ddd" },
        // Carrier-bounded generics (payload-transport-layer.md, P3b): compiles
        // the Ash offset-pagination read actions + the controller page/pageSize
        // actions that map %Ash.Page.Offset{} to the cross-backend envelope.
        { name: "paged.ddd" },
        // Discriminated unions (payload-transport-layer.md, P4d): compiles the
        // controller `tag_<union>/1` serializer (struct-pattern clauses → the
        // `%{type: tag, …}` wire) for an `Order or Cancel` find.
        { name: "union.ddd" },
        // Union-find with an `error` variant (exception-less.md A4): the
        // controller action maps `%Ctx.NotFound{}` to a 404 ProblemDetails (the
        // cross-backend absent-variant wire) and tags only the success variant
        // at 200, while `tag_<union>/1` still declares every variant.  Compiles
        // the runtime-dead error clause + the new `case` arm clean.
        { name: "union-absence.ddd" },
        // TPH (sharedTable) inheritance (aggregate-inheritance.md I2): the two
        // concrete Ash resources (Customer, Vendor) share one `parties` table,
        // each `base_filter`'d on a `kind` discriminator, plus the polymorphic
        // `list_parties` base reader.  The decisive check that Ash 3.x compiles
        // multiple resources mapping to one table (Ash has no native STI).
        { name: "tph.ddd" },
        // In-process event dispatch (channels.md): compiles the emitted
        // per-context Dispatcher, the reactor / event-create handler modules
        // (`StartOrderPlaced` / `OnShipmentRequested`), and the persisted
        // saga-state `Ecto.Schema` (load-or-allocate / route-or-drop+log)
        // against real Ash 3.x — the decisive check that the event-triggered
        // saga path compiles under `--warnings-as-errors`.
        { name: "dispatch.ddd" },
        // Reified criterion-ref capability filters (reified-criteria.md): a
        // `filter <Criterion>` reifies to an Ash boolean calculation that
        // `base_filter` references (`expr(active)` / `expr(in_region(region:
        // "EU"))`) instead of inlining the predicate.  The decisive check that
        // Ash 3.x accepts a calculation reference — including an argument-bearing
        // one — inside `base_filter`, alongside a plain inline filter.
        { name: "criterion-filter.ddd" },
        // DEBT-02 — a non-principal capability filter on a `shape(embedded)`
        // aggregate: the embedded Ash resource's root attributes are real
        // columns, so the predicate rides the same `base_filter expr(not
        // is_deleted)` the relational path emits, on a resource that also
        // carries an `{:array, Line}` embedded attribute.  The decisive check
        // that Ash 3.x compiles base_filter + embedded-array side by side.
        { name: "embedded-filter.ddd" },
        // `when` canCommand state gate (criterion.md, use site 2): the operation
        // loads the record, evaluates the predicate (enum → Ash atom), 409s
        // Disallowed before mutating, and auto-exposes the side-effect-free
        // `GET /orders/:id/can_cancel` companion + its OpenAPI path/CanResponse.
        { name: "when.ddd" },
        // Operation `or`-union returns on foundation: ash (exception-less.md A3,
        // DEBT-03): a return-dominant `operation foo(): Agg or NotFound` lowers to
        // an Ash generic action whose run fn loads the record and returns a tagged
        // term; the controller translates it (success → 200, error variant →
        // ProblemDetails).  The decisive check that Ash 3.x accepts the generic
        // action + its `:id`-first code interface.
        { name: "operation-returns.ddd" },
        // DEBT-03 — a MUTATING + GUARDED returning-op body on ash: the generic
        // action's run fn struct-updates the loaded record in place
        // (`%{record | quantity: …}`) and `precondition`/`requires` raise.  The
        // decisive check that the in-place mutation + raise guards compile against
        // real Ash 3.x.
        { name: "operation-returns-body.ddd" },
        // Principal-referencing (tenancy) capability filter on Ash (DEBT-01):
        // `filter this.tenantId == currentUser.tenantId` → `base_filter
        // expr(tenant_id == ^actor(:tenant_id))`, with `actor: current_user`
        // threaded onto every read (CRUD list/get/update/destroy + the context
        // view's `Ash.read!`).  The decisive check that Ash 3.x accepts an
        // `^actor(:field)` reference inside base_filter and that the actor-threaded
        // reads compile under --warnings-as-errors.
        { name: "tenancy-filter.ddd" },
        // DEBT-01 follow-up: actor threading through the two read paths the first
        // Ash slice deferred — a context retrieval invoked from a workflow
        // (`run_<ret>_<agg>!(..., actor: current_user)`) and an `or`-union
        // returning op (`Ash.get(__MODULE__, id, actor: context.actor)` + the
        // controller call passing the actor).  Both read the tenancy aggregate
        // under its `^actor(:field)` base_filter; the gate compiles both.
        { name: "tenancy-ops.ddd" },
      ]),
    )("$name → mix compile --warnings-as-errors", ({ name }) => {
      const fixturePath = path.join(fixturesDir, name);
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, name.replace(/\.ddd$/, ""))
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-"));
      fs.mkdirSync(outDir, { recursive: true });
      try {
        const projDir = path.join(outDir, "out", "phoenix_app");
        // Skip regeneration when the project already exists at the
        // expected path — i.e. the CI workflow pre-generated it to
        // compute the dep-cache key.  Local runs (no env var) always
        // start from a fresh tmpdir so this branch is the cold path.
        if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
          // 1. Generate the project.
          execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // 2. mix deps.get + mix compile inside the elixir image.
        runMixCompile(projDir, mirror);
      } finally {
        // CI-driven runs (LOOM_PHOENIX_OUT_DIR set) MUST leave deps/
        // and _build/ on disk so `actions/cache` can save them after
        // the job.  Only clean up the tmpdir variant.
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }, 700_000);

    // The showcase is the maximal multi-context, multi-deployable example —
    // it intentionally touches the whole language surface (derived nil-checks,
    // unreferenced domain `function`s, function-form preconditions, views).
    // Its phoenixApi deployable is the one that surfaced the four
    // `--warnings-as-errors` regressions this gate now pins:
    //   1. unused `alias` in view modules,
    //   2. `x != nil` instead of `is_nil/1`,
    //   3. unreferenced helper `function` as a private `defp`,
    //   4. missing `require_atomic? false` on a function-form-validate action.
    // It lives in examples/ (not the fixtures dir) because it's the shared
    // cross-backend showcase, so it gets its own standalone case.
    //
    // Gated behind LOOM_PHOENIX_SHOWCASE (in addition to the block-level
    // LOOM_PHOENIX_BUILD) so it runs in its OWN parallel CI job
    // (`build-generated-phoenix-showcase`) rather than stacking onto the
    // fixtures job's sequential docker legs — generating the full
    // multi-deployable system + compiling this large Ash app is markedly
    // heavier than any single fixture.  Local `npm run test:phoenix` runs
    // (no LOOM_PHOENIX_SHOWCASE) skip it; set the var to run it directly.
    it.skipIf(!process.env.LOOM_PHOENIX_SHOWCASE)(
      "system showcase (phoenix) — multi-context backend compiles under --warnings-as-errors",
      () => {
        const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
        const outDir = baseOutDir
          ? path.join(baseOutDir, "showcase")
          : fs.mkdtempSync(path.join(os.tmpdir(), "loom-phoenix-showcase-"));
        fs.mkdirSync(outDir, { recursive: true });
        try {
          const projDir = path.join(outDir, "out", "phoenix_api");
          if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
            execSync(`node ${cli} generate system examples/showcase.ddd -o ${outDir}/out`, {
              stdio: "inherit",
              cwd: repoRoot,
            });
          }
          expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

          runMixCompile(projDir, mirror);
        } finally {
          if (!baseOutDir) {
            try {
              fs.rmSync(outDir, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        }
      },
      700_000,
    );
  },
);
