import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HexMirror, startHexMirror } from "./support/hex-mirror";

// ---------------------------------------------------------------------------
// Slice 6 of docs/plans/vanilla-foundation-tdd-plan.md — CI gate for
// the vanilla emit subtree.  Parallel to test/e2e/generated-elixir-ash-
// build.test.ts but exercises `foundation: vanilla` deployables and
// expects no Ash deps in the generated mix.exs.
//
// For every fixture under `test/e2e/fixtures/elixir-vanilla-build/`,
// generate the project then `mix deps.get && mix compile
// --warnings-as-errors` inside the hexpm/elixir Docker image.  Catches
// every Elixir surface error the unit-test layer (string assertions)
// can't see — the actual acceptance gate for the vanilla emitters.
//
// Gated behind LOOM_PHOENIX_VANILLA_BUILD=1 so it stays out of the
// always-on `test` matrix; runs in CI via .github/workflows/elixir-
// vanilla-build.yml and locally via `npm run test:phoenix-vanilla`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "elixir-vanilla-build");
const ENABLED = process.env.LOOM_PHOENIX_VANILLA_BUILD === "1";
const IMAGE = "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";

// `mix deps.get && mix compile --warnings-as-errors` inside the elixir image.
// When `mirror` is set (LOOM_HEX_MIRROR=1) hex.pm traffic is routed through the
// loopback mirror — mirrors the Ash gate, so this gate also runs behind a
// TLS-fingerprinting egress proxy.  See test/e2e/support/hex-mirror.ts.
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

// `mix test` (MIX_ENV=test) for a fixture whose aggregates declare domain
// `test "..."` blocks — the emitted ExUnit suite runs the pure domain core
// (vanilla/domain-core-emit.ts) with NO database, so this gate just compiles +
// runs the tests.  Catches an emitter regression that produces invalid Elixir
// or a behaviourally wrong assertion (the `mix compile --warnings-as-errors`
// gate above is MIX_ENV=prod and never compiles `test/`).
function runMixTest(projDir: string, mirror: HexMirror | undefined): void {
  const dockerArgs = mirror ? `${mirror.dockerArgs.join(" ")} ` : "";
  const shellPrefix = mirror?.shellPrefix ?? "";
  execSync(
    `docker run --rm ${dockerArgs}-v ${projDir}:/app -w /app ${IMAGE} ` +
      `bash -c '${shellPrefix}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get && mix test'`,
    { stdio: "inherit", timeout: 600_000 },
  );
}

// CI shards one fixture per matrix cell (see elixir-vanilla-build.yml) so a cold
// dep compile fits the per-cell timeout and reseeds its own cache.
// `LOOM_PHOENIX_VANILLA_BUILD_CASE=<fixture>.ddd` selects that single fixture;
// unset (local `npm run test:phoenix-vanilla`) builds them all.  Mirrors the Ash
// gate's LOOM_PHOENIX_BUILD_CASE (generated-elixir-ash-build.test.ts).
function pickCases<T extends { name: string }>(all: T[]): T[] {
  const only = process.env.LOOM_PHOENIX_VANILLA_BUILD_CASE;
  if (!only) return all;
  const selected = all.filter((c) => c.name === only);
  if (selected.length === 0) {
    throw new Error(
      `LOOM_PHOENIX_VANILLA_BUILD_CASE=${only} matched no elixir-vanilla-build fixture ` +
        `(have: ${all.map((c) => c.name).join(", ")})`,
    );
  }
  return selected;
}

describe.skipIf(!ENABLED)(
  "generated vanilla Phoenix project compiles against plain Ecto (LOOM_PHOENIX_VANILLA_BUILD=1)",
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
        { name: "vanilla-min.ddd", deployable: "api" },
        { name: "vanilla-channels.ddd", deployable: "api" },
        // Event sourcing (T2.b) + operation `or`-union returns (T2.c) — compile the
        // from-scratch ES + producer-translation Elixir, not just the structure tests.
        { name: "vanilla-eventlog.ddd", deployable: "api" },
        { name: "vanilla-returns.ddd", deployable: "api" },
        // Returning-op body statements (T2.c tail) — precondition/requires raise
        // guards, `assign` struct-update, `emit` PubSub broadcast, fall-through
        // success serialised to a wire map.
        { name: "vanilla-returns-body.ddd", deployable: "api" },
        // State-based named-operation BODY emission — a non-returning
        // `operation reprice(qty, price) { precondition …; total := … }` renders
        // its guards + `field := value` struct-updates and persists the assigned
        // columns via put_change (not a param cast).
        { name: "vanilla-op-body.ddd", deployable: "api" },
        // Provenance runtime (DEBT-06) — a `provenanced` field's co-located
        // `<field>_provenance` jsonb column, inline lineage capture at each
        // named-op write site, and the transactional `provenance_records` flush
        // (the `<App>.Provenance` SDK + the Json Ecto type + the migration).
        { name: "vanilla-provenance.ddd", deployable: "api" },
        // DEBT-32 — nested entity parts on a shape(embedded) vanilla aggregate:
        // `contains lines: Line[]` → `embeds_many` over a part `embedded_schema`
        // module; `lines += Line{…}` appends + `put_embed`s.  Compiles the
        // embedded-schema part + put_embed persist.
        { name: "vanilla-embed-parts.ddd", deployable: "api" },
        // shape(document) (DEBT-07) — the `(id, data, version)` jsonb table, a
        // schemaless-changeset validated fold, and the document CRUD repository
        // (the relational `Map.from_struct` serialize swapped for a data-merge).
        { name: "vanilla-document.ddd", deployable: "api" },
        // ES applier folds over value-object / enum fields (P4.3): an inline VO
        // constructor renders to a plain map on vanilla — compile that path.
        { name: "vanilla-vo-fold.ddd", deployable: "api" },
        // Per-field changeset validators (T2.i) — validate_number/length/format.
        { name: "vanilla-invariants.ddd", deployable: "api" },
        // Event-sourced append → Dispatcher fan-out (an ES event a workflow saga
        // consumes) — compile the `<Ctx>.Dispatcher.dispatch/1` call in append.
        { name: "vanilla-es-dispatch.ddd", deployable: "api" },
        // Event-sourced WORKFLOW (A2-S5b): `<Wf>State` fold struct + `<wf>_events`
        // schema + fold + stream IO + fold-on-load / append-own-events handlers.
        { name: "vanilla-eventsourced-workflow.ddd", deployable: "api" },
        // Custom-find HTTP surface — list / single / param-less GET actions.
        { name: "vanilla-finds.ddd", deployable: "api" },
        // Union-returning find — tagged success + problem_variant absence.
        { name: "vanilla-union-find.ddd", deployable: "api" },
        // Capability `filter` AND-ed into every Ecto read (list/find_by_id/find/
        // retrieval/view) — plain Ecto has no Ash base_filter, so the conjoined
        // `from(... where: ...)` reads must compile (and not silently drop the filter).
        { name: "vanilla-capability-filter.ddd", deployable: "api" },
        // Principal (tenancy) `filter this.tenantId == currentUser.tenantId` — the
        // request actor is threaded from `conn.assigns.current_user` (Auth plug)
        // into every read and pinned (`^(current_user && current_user.tenant_id)`).
        // Compiles the threaded repository/context/controller/retrieval/view + the
        // auth plug spliced into the router.
        { name: "vanilla-tenancy.ddd", deployable: "api" },
        // Plain (non-event-sourced) workflow saga: the `<Wf>` GenServer-free
        // Ecto-state instance + correlation row + create/continuation handlers
        // compiled on the vanilla foundation.
        { name: "vanilla-workflows.ddd", deployable: "api" },
        // Nested control flow in workflow bodies: `for-each` / `if-let` /
        // `repo-run` nested inside a `for-each` body or an `if-let` branch
        // (the for-each validator only inspects op-calls, so the nesting is
        // valid input).  Before the recursion fix these dropped a `# TODO`
        // (uncompilable); now each lowers as a `<-` with-clause.
        { name: "vanilla-nested-flow.ddd", deployable: "api" },
        // Lifecycle stamps (`with auditable`) — the audit columns are applied via
        // `Ecto.Changeset.put_change` on the changeset before `Repo.insert`/
        // `Repo.update`; `currentUser` resolves to the principal id off the
        // threaded `current_user` map.  Compiles the stamped insert/update seam +
        // the threaded context delegate + controller.
        { name: "vanilla-auditable.ddd", deployable: "api" },
        // Domain `test "..."` blocks → ExUnit over the pure domain core: this
        // fixture emits `test/` files, so the harness also runs `mix test`
        // (DB-free) on top of the prod compile.  Pins the test-emission parity
        // and the F6 field-default fix.
        { name: "vanilla-domain-tests.ddd", deployable: "api" },
      ]),
    )("$name → mix compile --warnings-as-errors", ({ name, deployable }) => {
      const fixturePath = path.join(fixturesDir, name);
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, name.replace(/\.ddd$/, ""))
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-vanilla-"));
      fs.mkdirSync(outDir, { recursive: true });

      try {
        // The vanilla orchestrator emits to `<deployable>/`, not
        // `phoenix_app/`.  Read the deployable slug per fixture.
        const projDir = path.join(outDir, "out", deployable);
        if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
          execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // Vanilla mix.exs must have zero Ash deps — re-asserting at
        // the e2e level on top of the unit assertion.
        const mix = fs.readFileSync(path.join(projDir, "mix.exs"), "utf8");
        expect(mix).not.toContain(":ash,");
        expect(mix).not.toContain(":ash_postgres,");
        expect(mix).not.toContain(":ash_phoenix,");

        // mix deps.get + compile inside the elixir image (cold-cache fits the
        // 600s exec budget; the headroom absorbs transient hex slowness).
        // Routed through the loopback hex mirror when LOOM_HEX_MIRROR=1.
        runMixCompile(projDir, mirror);

        // If the fixture's aggregates declared domain `test "..."` blocks, the
        // emitter wrote an ExUnit suite (+ test_helper.exs) — run it (DB-free).
        if (fs.existsSync(path.join(projDir, "test", "test_helper.exs"))) {
          runMixTest(projDir, mirror);
        }
      } finally {
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
      }
    }, 700_000);
    // Cold mix deps.get + mix compile inside docker can take several
    // minutes on a fresh cache; mirror the Ash test's 700_000 ms
    // per-test timeout so vitest doesn't kill the docker exec at the
    // default 30s.
  },
);
