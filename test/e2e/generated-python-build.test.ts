import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Generator regression gate: emit each fixture via `ddd generate system`,
// then run the generated Python project's full static toolchain —
// `uv sync` (resolve + install the pinned dep set), `ruff check`,
// `ruff format --check` (the emitted source must be ruff-format-clean,
// the Python analogue of the Biome gate on emitted TS), and
// `mypy --strict app` (the same bar `/warnaserror` sets for .NET).
//
// Mirrors `generated-dotnet-build.test.ts`.  Opt-in via
// LOOM_PYTHON_BUILD=1 so the default `npm test` stays fast.  CI's
// `.github/workflows/python-build.yml` runs the same check.
//
// Requires `uv` on PATH (it provisions Python 3.13 itself).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_PYTHON_BUILD === "1";

/** Fixture → the deployable folder (serviceSlug) to gate, plus optional
 *  extra `generate system` flags (e.g. `--trace`). */
const CASES: Array<[fixture: string, project: string, flags?: string]> = [
  ["test/e2e/fixtures/python-build/shell.ddd", "api"],
  // Entity parts + containment + collection ops + money domain logic.
  ["test/e2e/fixtures/python-build/domain.ddd", "api"],
  // Part-in-part nesting (Order → Shipment[] → Label[]): a part's FK targets
  // its DIRECT parent (labels.shipment_id), recursive save + hydrate of the
  // nested level (nested-parts-alignment.md Phase 2).
  ["test/e2e/fixtures/python-build/nested-parts.ddd", "api"],
  // TPH (shared kind-discriminated table) + TPC (per-concrete tables)
  // hierarchies with polymorphic base readers.
  ["test/e2e/fixtures/python-build/inheritance.ddd", "api"],
  // persistedAs: eventLog: append-only stream + appliers fold.
  ["test/e2e/fixtures/python-build/eventlog.ddd", "api"],
  // Multi-context event log: ES streams in the SECOND context, so the merged
  // context name differs from the owner — the `<Ctx>EventRow` model, its repo
  // import, and the Alembic migration must all resolve to the OWNING context
  // (`beta_events`), else the generated project fails to import.
  ["test/e2e/fixtures/python-build/multi-context-eventlog.ddd", "api"],
  // Channels + event-triggered saga (in-process dispatcher, persisted
  // correlation state).
  ["test/e2e/fixtures/python-build/saga.ddd", "api"],
  // Event-sourced workflow: append-only `<wf>_events` stream + fold-on-load
  // + emit→append-own-event dispatch (the saga analogue of eventLog.ddd).
  // Generated from the shared corpus fixture.
  ["corpus:eventsourced-workflow", CORPUS_DEPLOYABLE],
  // Durable channel (`retention: log`): transactional outbox + relay +
  // last_event_id idempotent-consumer dedup.
  ["test/e2e/fixtures/python-build/outbox.ddd", "api"],
  // `auth: required` — User dataclass + verifier registry + middleware,
  // requires-guarded op/workflow, currentUser-scoped find.
  ["test/e2e/fixtures/python-build/auth.ddd", "api"],
  // `with auditable` — lifecycle stamps applied before persist: created_at /
  // updated_at via now(), created_by / updated_by via the request principal id.
  ["test/e2e/fixtures/python-build/auditable.ddd", "api"],
  // Per-operation `audited` (audit-and-logging.md): an audited op stages a
  // who/what/when + before/after wire snapshot into `audit_records` in the same
  // request session as the aggregate save (the record_audit repo helper).
  ["test/e2e/fixtures/python-build/audited-operation.ddd", "api"],
  // `auth { oidc }` — the PyJWT + JWKS verifier (app/auth/oidc.py), the
  // /auth/login|callback|logout handshake + /auth/me probe, and the
  // pyjwt[crypto] dep, under ruff + mypy --strict.  (Shared with the python
  // runtime OIDC e2e — auth-oidc-python-e2e.test.ts — so kept single-sourced
  // here rather than migrated to the corpus.)
  ["test/e2e/fixtures/python-build/auth-oidc.ddd", "api"],
  // `seed { ... }` — domain-create + raw datasets, __loom_seed marker.
  ["test/e2e/fixtures/python-build/seeds.ddd", "api"],
  // `operation X() extern` (extern (b) Phase 2) — the op is a real method
  // (preconditions → user-owned hook → invariants); the scaffold-once hook
  // module `app/domain/extern/<agg>_extern.py` raises until filled in.
  ["test/e2e/fixtures/python-build/extern.ddd", "api"],
  // Fullstack `ui:` embed — routers under /api/*, SPA fallback, ClientApp/.
  ["test/e2e/fixtures/python-build/fullstack.ddd", "app"],
  // Resource verb clients: objectStore (boto3) + queue (aio-pika) + api (httpx).
  ["test/e2e/fixtures/python-build/resources.ddd", "api"],
  // shape: document: one jsonb (id, data, version) blob + in-memory finds.
  ["test/e2e/fixtures/python-build/document.ddd", "api"],
  // shape: document + capability filter (DEBT-02 tail complete): non-principal
  // AND principal (`require_current_user()`) predicates evaluated IN-APP over the
  // rehydrated docs (list-comprehension filter), ruff + mypy --strict clean.
  ["test/e2e/fixtures/python-build/document-tenancy.ddd", "api"],
  // shape: embedded: queryable root row + one jsonb column per containment
  // / ref-collection; SQL finds over root columns.
  ["test/e2e/fixtures/python-build/embedded.ddd", "api"],
  // shape: embedded + capability filter (DEBT-02 tail): non-principal AND
  // principal (`require_current_user()`) predicates AND-ed into the embedded
  // root reads, ruff + mypy --strict clean.
  ["test/e2e/fixtures/python-build/embedded-filter.ddd", "api"],
  // `when` state gate: DisallowedError (409) before the body + the
  // side-effect-free GET /{id}/can_<op> companion.
  ["test/e2e/fixtures/python-build/when.ddd", "api"],
  // `ignoring <Cap>` / `ignoring *` filter-bypass: a find/view OMITS the named
  // capability conjunct; a bare `filter` always applies.  The resulting
  // repository must stay ruff- + mypy --strict-clean.
  ["test/e2e/fixtures/python-build/filter-bypass.ddd", "api"],
  // Principal (tenancy) capability filter (DEBT-02): `filter this.tenantId ==
  // currentUser.tenantId` AND-s `require_current_user().tenant_id` (the ambient
  // ContextVar accessor) into every root read; the generated SQLAlchemy must
  // stay ruff- + mypy --strict-clean.
  ["test/e2e/fixtures/python-build/tenancy-filter.ddd", "api"],
  // Multi-tenancy P2.2 hierarchy `currentUser.orgPath`: the registry opts into
  // `tenantRegistry` (a `data_key` column), so the auth middleware resolves
  // `org_path` per request from the registry table (`_resolve_org_path` +
  // `session_factory` lookup, fail-safe to the claim) and stores it on the
  // frozen User via `object.__setattr__`; the generated middleware + stored
  // `org_path` attribute must stay ruff- + mypy --strict-clean.
  ["test/e2e/fixtures/python-build/tenancy-hierarchy.ddd", "api"],
  // M-T5.10 handler-param rewrite — SCAFFOLDED explicit handlers: `with
  // scaffoldHandlers` synthesises a command/query handler per create / operation
  // / find / get-by-id / destroy, each taking a single `command`/`query` record
  // param.  The Python handler flattens the record into flat domain-typed `def`
  // params + `<Handler>Body` fields (`cmd.<field>` → the flat local), and a read
  // projects `<Agg>Response` via `repo.to_wire(...)` (collection reads
  // comprehend each element).  Must stay ruff- + mypy --strict-clean.
  ["test/e2e/fixtures/python-build/scaffold-handlers.ddd", "api"],
  // `--trace` domain instrumentation: precondition_evaluated /
  // value_computed / invariant_evaluated trace lines must stay
  // ruff-/mypy-clean (the domain fixture exercises all three).
  ["test/e2e/fixtures/python-build/domain.ddd", "api", "--trace"],
];

describe.skipIf(!ENABLED)(
  "generated Python project passes uv sync + ruff + mypy --strict (LOOM_PYTHON_BUILD=1)",
  () => {
    it.each(CASES)(
      "%s %s — generated project is statically clean",
      (fixture, project, flags = "") => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-python-"));
        try {
          // `corpus:<feature>` resolves to the shared corpus fixture, materialised
          // for python; a plain path is used as-is.
          const src = fixture.startsWith("corpus:")
            ? materializeCorpusFixture(fixture.slice("corpus:".length), "python", outDir)
            : fixture;
          execSync(`node ${cli} generate system ${src} -o ${outDir}${flags ? ` ${flags}` : ""}`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
          const proj = path.join(outDir, project);
          expect(fs.existsSync(path.join(proj, "pyproject.toml"))).toBe(true);
          const run = (cmd: string) =>
            execSync(cmd, { cwd: proj, stdio: "inherit", timeout: 300_000 });
          // No `ruff format --check`: arbitrary domain expressions (long
          // derived chains) can't guarantee format-identical output —
          // same reason dotnet/phoenix keep their format checks as
          // separate opt-in suites rather than the build gate.
          run("uv sync");
          run("uv run ruff check .");
          const hasTests = fs.existsSync(path.join(proj, "tests"));
          run(`uv run mypy --strict app${hasTests ? " tests" : ""}`);
          if (hasTests) {
            run("uv run pytest -q");
          }
        } finally {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      },
      600_000,
    );
  },
);
