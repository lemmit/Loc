import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example, install deps, run
// `tsc --noEmit` (type-check only — tsup handles emit), then run
// `npm run build` to exercise the tsup bundle.  Catches generator
// drift that breaks generated TS without running the full docker
// e2e.
//
// Slow (~60s with cached node_modules) — opt-in via LOOM_TS_BUILD=1
// so `npm test` stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TS_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated TS type-checks (tsc) AND bundles (tsup) under strict mode",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      // crudish lifecycle — the only example that emits a canonical
      // destroy, so this cell is what compiles the Hono DELETE route +
      // repo `delete()` paths.
      "examples/lifecycle.ddd",
      // Document-persistence path (`normalised(false)`): jsonb column +
      // JSON round-trip through `_create` (toDoc / fromDoc).
      "examples/document.ddd",
      // First-boot seeding (database-seeding.md): compiles db/seed.ts + the
      // index.ts runSeeds wiring + the db:seed package.json script.
      "examples/seeding.ddd",
      // Value-object array (`Money[]`): the id-less child table + the repo
      // load/save round-trip (bulk-load → `new Money(...)`, delete + re-insert
      // with ordinal).
      "examples/value-collections.ddd",
      // In-process event dispatch (channels.md): a channel-carried event with
      // an `on(e: Event)` reactor + an event-triggered `create(e: Event) by`
      // starter — type-checks the generated `createInProcessDispatcher`, the
      // reactor/starter handlers, and the `createApp` in-process default.
      "test/fixtures/dispatch-sample.ddd",
      // Exception-less operation returns (exception-less.md, spike): an
      // `operation foo(): X or NotFound` emits a tagged-union domain method
      // signature + a route that captures the result and translates an
      // `error`-variant to an RFC-7807 ProblemDetails (404), a success to 200.
      // Compiles the inline tagged-union return type + the route translation.
      "test/e2e/fixtures/ts-build/operation-return.ddd",
      // `ignoring <Cap>` / `ignoring *` filter-bypass (named-filter-bypass.md §11):
      // node honors a bypass by omitting the capability's predicate from the
      // Drizzle `and(...)` chain across repository finds + a view read. Pins that
      // the bypassed/`*`/normal read variants all type-check.
      "test/e2e/fixtures/ts-build/filter-bypass.ddd",
      // money-inside-VO: Decimal/moneySchema imports key on the VO-registry-
      // aware deep money check (S9 follow-through) — pins the previously
      // ungated latent tsc break + the emitted field-wise VO equals().
      "test/e2e/fixtures/ts-build/money-vo.ddd",
      // Part-in-part nesting (Order → Shipment[] → Label[]): a nested part's
      // Drizzle FK + `parentId` brand target its DIRECT parent
      // (labels.shipment_id / ShipmentId), and the repository recursively saves
      // + hydrates the nested level (nested-parts-alignment Phase 2 — node).
      // Pins the previously-latent forward-ref (z.array(LabelResponse)) + the
      // Shipment._create({...labels}) type-check.
      "test/e2e/fixtures/ts-build/nested-parts.ddd",
    ])("%s — `ddd generate ts` output type-checks + tsup-bundles", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-"));
      try {
        execSync(`node ${cli} generate ts ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
        // Type-check (tsup is build-only with `dts: false`).
        execSync(`npx tsc --noEmit`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Build the production bundle.
        execSync(`npm run build`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Bundle exists where the Dockerfile expects it.
        expect(fs.existsSync(path.join(outDir, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // D-REALIZATION-AXES Phase 5b: `directoryLayout: byFeature` is a SYSTEM-MODE
    // selection (it lives on a deployable), so `generate ts` above never sees it.
    // This case generates the SYSTEM and type-checks the node deployable's
    // project, proving the byFeature relocation + relative-import rewrite produce
    // a COMPILING project — the gap that let the first byFeature attempt ship
    // broken.
    it("system `directoryLayout: byFeature` (node) — relocated project type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-bf-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/byfeature.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        // The node deployable is named `api` → its project lands under `api/`.
        const proj = path.join(outDir, "api");
        // Sanity: the layout actually relocated files under features/.
        expect(fs.existsSync(path.join(proj, "features", "order", "order.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "domain", "order.ts"))).toBe(false);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // OIDC turnkey auth (D-AUTH-OIDC, Phase 1): a system with an
    // `auth { oidc { … } }` block emits the generated jose-backed verifier
    // (auth/oidc.ts) + the /auth/* handshake (auth/handshake.ts) + the
    // index.ts registerOidcVerifier wiring + the `jose` dep.  Generated via
    // `generate system` (auth files are system-mode only) and type-checked
    // against the real `jose` types — the gate that proves the emitted
    // verifier + handshake compile (content tests can't see a type error).
    // DEBT-02: a capability `filter` on NON-relational aggregates — `document`
    // (in-app over the rehydrated doc) + `embedded` (SQL where on the root
    // column).  System-mode only (the filter + shape live on a deployable), so it
    // type-checks the node project to prove both emitted read paths compile.
    it("system non-relational capability filter (document + embedded) — generated project type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-docfilter-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/document-filter.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // Lifecycle stamping (capabilities.md) — `with auditable` on an
    // `auth: required` node deployable.  node-persist-time-auditing relocated
    // stamping into the drizzle `save()` (db/audit-stamp.ts): the upsert wraps
    // its insert values in `stampInsert` and conflict `set` in `stampUpdate`,
    // reading the principal from the ambient request context — so the domain
    // entity is pure (no `_stampOn*`) and the handler never stamps.  System-mode
    // only (the user block + auth/middleware.ts are system-level), so this gate
    // compiles the emitted helper + the stamped repository end-to-end.
    it("system lifecycle stamps (auditable + auth) — generated project type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-stamps-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/auditable-stamps.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // Sanity: auth middleware was emitted (the principal source the persist
        // hook reads), the persist-time stamp helper was emitted, and the
        // domain entity is pure (no `_stampOn*` method).
        expect(fs.existsSync(path.join(proj, "auth", "middleware.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "db", "audit-stamp.ts"))).toBe(true);
        expect(fs.readFileSync(path.join(proj, "domain", "order.ts"), "utf8")).not.toContain(
          "_stampOnCreate",
        );
        // Default-on versioning (M-T3.4) turns the audited save into the guarded
        // write: the create branch stamps via `stampInsert({... version: 1})` and
        // the version-CAS update branch via `stampUpdate({... version: expected + 1})`.
        {
          const repoSrc = fs.readFileSync(
            path.join(proj, "db", "repositories", "order-repository.ts"),
            "utf8",
          );
          expect(repoSrc).toContain("stampInsert({");
          expect(repoSrc).toContain("stampUpdate({");
        }
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // File primitive (M-T1.2 / M-T4.6 §5.3) — a `File` field on a node
    // deployable bound to a `localDisk` object store.  System-mode only
    // (storage / objectStore dataSource / endpoints are system-level).  Gates:
    // the `File` field serialises as the fixed FileRef object in the aggregate
    // Request/Response zod, stores as a JSONB column, hydrates back through the
    // FileRef cast, and the app-level `POST /files` + `GET /files/:key` routes
    // plus the emitted `localDisk` resource adapter type-check + bundle.
    it("system File field (localDisk objectStore) — upload/download routes type-check + bundle", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-file-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/file-field.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // The localDisk resource adapter module was emitted with its bytes verbs.
        const adapterSrc = fs.readFileSync(path.join(proj, "resources", "localDisk.ts"), "utf8");
        expect(adapterSrc).toContain("docsFiles$putBytes");
        expect(adapterSrc).toContain("docsFiles$getBytes");
        // The global upload/download routes were mounted in createApp.
        const indexSrc = fs.readFileSync(path.join(proj, "http", "index.ts"), "utf8");
        expect(indexSrc).toContain('app.post("/files"');
        expect(indexSrc).toContain('app.get("/files/:key"');
        // The File field serialises as the fixed FileRef object in the aggregate
        // Response schema, and stores as a JSONB column.
        const routesSrc = fs.readFileSync(path.join(proj, "http", "attachment.routes.ts"), "utf8");
        expect(routesSrc).toContain(
          "z.object({ url: z.string(), key: z.string(), contentType: z.string(), size: z.number().int() })",
        );
        expect(fs.readFileSync(path.join(proj, "db", "schema.ts"), "utf8")).toContain(
          'jsonb("blob")',
        );
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // M-T5.10 handler-param rewrite — the SCAFFOLDED explicit handlers take a
    // single `command`/`query` record param (`cmd.<field>`/`query.<field>`) and
    // reads declare a `<Agg>Response` return.  A Money-typed operation param
    // stresses the value-object wire-schema closure on the request-record path,
    // and a find declares `<Agg>Response[]` (the array projection `r.map(x =>
    // repo.toWire(x))`).  No corpus `.ddd` compiled a scaffolded record-param
    // handler before, so this closes a real tsc blind spot.
    it("system scaffolded explicit handlers (command/query record params) — type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-handlers-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/scaffold-handlers.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const router = fs.readFileSync(path.join(proj, "http", "salesApi-routes.ts"), "utf8");
        // The create handler binds the command record's fields as the body and
        // reads them off `cmd.<field>`; the find projects the array to the wire.
        expect(router).toContain("const cmd = {");
        expect(router).toContain("const query = {");
        expect(router).toMatch(/\.map\(\(__e\) => \w+\.toWire\(__e\)\)/);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // The "tech showcase" system (`examples/showcase.ddd`) exercises the whole
    // language surface; its `hono_api` deployable is the reference backend.
    // Mirrors the dotnet gate's showcase cell — this is what catches a
    // lowering-/renderer-level break (e.g. the union-find variant-match) that
    // the narrower fixtures never exercise (S3 of
    // docs/audits/generated-code-ddd-review-2026-07.md).
    it("system showcase (hono) — multi-context backend type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-showcase-"));
      try {
        execSync(`node ${cli} generate system examples/showcase.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, "hono_api");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    it("system OIDC auth (verifier + /auth/* handshake) — generated project type-checks + bundles", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-oidc-"));
      try {
        // Generated from the shared corpus fixture (one canonical auth-oidc across all backends).
        const src = materializeCorpusFixture("auth-oidc", "node", outDir);
        execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, CORPUS_DEPLOYABLE);
        // Sanity: the OIDC files were actually emitted into this project.
        expect(fs.existsSync(path.join(proj, "auth", "oidc.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "auth", "handshake.ts"))).toBe(true);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // React `auth: ui` guard (D-AUTH-OIDC, Phase 6): a react deployable with
    // `auth: ui` (target backend `auth: required`) emits the pack-agnostic
    // session client (src/auth/session.ts) + route guard
    // (src/auth/AuthGate.tsx), wraps <App/> in <AuthGate>, and sends
    // credentials.  Generated via `generate system` and the emitted `web/`
    // React project is type-checked against the real React / Mantine types.
    // DEBT-01: a principal-referencing (tenancy) capability filter
    // (`filter this.tenantId == currentUser.tenantId`) AND-ed into every root
    // read via the ambient `requireCurrentUser()` accessor.  Generated via
    // `generate system` (the user block + auth/middleware.ts are system-level);
    // this gate compiles the emitted repository + the requireCurrentUser import.
    it("system tenancy filter (principal capability filter) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-tenancy-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/tenancy-filter.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(fs.existsSync(path.join(proj, "auth", "middleware.ts"))).toBe(true);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // DEBT-24: a PRINCIPAL-referencing `criterion` reified into the
    // find/retrieval query-face.  The reified `<name>Criterion` fn is
    // module-scoped, so `currentUser.<field>` must bind through the ambient
    // `requireCurrentUser()` accessor — otherwise the fn names an unbound
    // `currentUser` and the repository fails `tsc`.  This cell is the
    // regression guard for that bug.
    it("system principal `criterion` in a find/retrieval — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-tenancy-retrieval-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/tenancy-retrieval.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const repo = fs.readFileSync(
          path.join(proj, "db", "repositories", "account-repository.ts"),
          "utf8",
        );
        // The criterion fn binds the ambient principal — no unbound `currentUser`.
        expect(repo).toMatch(/requireCurrentUser\(\)\.tenantId/);
        expect(repo).not.toMatch(/eq\(schema\.accounts\.tenantId, currentUser\./);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // DEBT-02 Slice A: a PRINCIPAL-referencing capability filter on a
    // `shape: embedded` aggregate.  The embedded aggregate's root scalars are
    // real columns, so it reuses the relational-principal path — the embedded
    // repository weaves `requireCurrentUser().tenantId` into every embedded
    // root read and imports `requireCurrentUser` from `../../auth/middleware`.
    // Previously gated by `loom.context-filter-unsupported`.  Generated via
    // `generate system` (the user block + auth/middleware.ts are system-level);
    // this gate compiles the emitted embedded repository + the import.
    it("system embedded tenancy filter (principal filter on shape: embedded) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-embtenancy-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/embedded-tenancy.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(fs.existsSync(path.join(proj, "auth", "middleware.ts"))).toBe(true);
        const repo = fs.readFileSync(
          path.join(proj, "db", "repositories", "order-repository.ts"),
          "utf8",
        );
        // The principal weave is present in the embedded repository.
        expect(repo).toContain('import { requireCurrentUser } from "../../auth/middleware"');
        expect(repo).toContain("requireCurrentUser().tenantId");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // DEBT-02 Slice B: a PRINCIPAL-referencing capability filter on a
    // `shape: document` aggregate.  The whole aggregate is one jsonb column, so
    // the principal can't be a static SQL predicate — each in-app document read
    // binds `const currentUser = requireCurrentUser();` (fail-closed) and AND-s
    // the principal predicate over the rehydrated aggregate, importing
    // `requireCurrentUser` from `../../auth/middleware`.  Previously gated by
    // `loom.context-filter-unsupported`.  Generated via `generate system` (the
    // user block + auth/middleware.ts are system-level); this gate compiles the
    // emitted document repository + the import.
    it("system document tenancy filter (principal filter on shape: document) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-doctenancy-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/document-tenancy.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(fs.existsSync(path.join(proj, "auth", "middleware.ts"))).toBe(true);
        const repo = fs.readFileSync(
          path.join(proj, "db", "repositories", "order-repository.ts"),
          "utf8",
        );
        // The fail-closed principal weave is present in the document repository.
        expect(repo).toContain('import { requireCurrentUser } from "../../auth/middleware"');
        expect(repo).toContain("const currentUser = requireCurrentUser();");
        expect(repo).toContain("rec.tenantId === currentUser.tenantId");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    it("system react auth: ui guard — generated web project type-checks + builds", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-authui-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/auth-ui.ddd -o ${outDir}`,
          {
            stdio: "inherit",
            cwd: repoRoot,
          },
        );
        // The react deployable is named `web` → its project lands under `web/`.
        const proj = path.join(outDir, "web");
        expect(fs.existsSync(path.join(proj, "src", "auth", "AuthGate.tsx"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "src", "auth", "session.ts"))).toBe(true);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // Event sourcing (appliers A2): a `persistedAs: eventLog` aggregate emits
    // the `<agg>_events` stream table, the `_apply`/`_fromEvents` fold, the
    // record-and-fold `emit`, the shell-+emit-body `create` factory, and the
    // append/fold repository.  Generated via `generate system` (the ES storage
    // validator requires a Hono host).  The discriminated-union push/apply is
    // the type-sensitive part this gate compiles.
    it("system event sourcing (eventLog + appliers + create) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-es-"));
      try {
        execSync(`node ${cli} generate system examples/event-sourcing.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, "api");
        // Sanity: the per-context event-log table + the fold rehydrator made it
        // out (context `Accounts` → the shared `accounts_events` stream).
        expect(fs.readFileSync(path.join(proj, "db", "schema.ts"), "utf8")).toContain(
          "accounts_events",
        );
        expect(fs.readFileSync(path.join(proj, "domain", "account.ts"), "utf8")).toContain(
          "_fromEvents",
        );
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // Event-sourced WORKFLOW (workflow-and-applier.md A2-S5b): the saga folds
    // its own emitted events into state via apply(...) and persists as an
    // append-only `<wf>_events` stream — no mutable correlation-state row.
    // Compiles the fold helpers (state type / fold / apply / load / append) and
    // the fold-load / append-own-events dispatch handlers.  `generate system`
    // (channels + the ES-workflow storage validator require a Hono host).
    it("system event-sourced workflow (stream + fold + apply dispatch) — generated project type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-eswf-"));
      try {
        // Generated from the shared corpus fixture.
        const src = materializeCorpusFixture("eventsourced-workflow", "node", outDir);
        execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const proj = path.join(outDir, CORPUS_DEPLOYABLE);
        // Sanity: the workflow event stream + the fold made it out (not a state
        // table).  The ES workflow shares the per-context `<ctx>_events` log
        // (context `Fulfillment` → `fulfillment_events`), discriminated by
        // stream_type.
        const schema = fs.readFileSync(path.join(proj, "db", "schema.ts"), "utf8");
        expect(schema).toContain("fulfillment_events");
        const wf = fs.readFileSync(path.join(proj, "http", "workflows.ts"), "utf8");
        expect(wf).toContain("function foldOrderFulfillment");
        expect(wf).toContain("appendOrderFulfillmentEvents");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // Multi-context Acme ERP bundle (web/src/examples/erp): a single Hono
    // deployable (`core_api`) hosts five bounded contexts that share an ambient
    // kernel (root-level value objects + enums in sibling files), a TPH
    // aggregate hierarchy, `money` events, server-managed datetimes, a
    // declarative seed and per-aggregate domain `test` blocks.  This is the
    // real workspace whose generated project failed `tsc` with 76 errors; the
    // gate now type-checks AND bundles AND *runs* the generated domain tests so
    // a generator regression that breaks the emitted suite is caught here, not
    // only at hand-inspection time.
    it("system Acme ERP (multi-context Hono) — generated core_api type-checks, bundles, and its domain tests pass", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-erp-"));
      try {
        execSync(`node ${cli} generate system web/src/examples/erp/main.ddd -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        // The lone Hono deployable in the bundle is `core_api`.
        const proj = path.join(outDir, "core_api");
        expect(fs.existsSync(path.join(proj, "package.json")), "core_api project emitted").toBe(
          true,
        );
        // Sanity: it hosts the cross-file ambient Money VO + a generated test.
        expect(fs.existsSync(path.join(proj, "domain", "salesOrder.test.ts"))).toBe(true);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
        // Run the generated per-aggregate domain `test` blocks (pure domain
        // logic — no DB).  These exercise the create-factory + value-object +
        // branded-id construction the emitter coerces.
        execSync(`npx vitest run`, { cwd: proj, stdio: "inherit", timeout: 120_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 420_000);

    // D-REALIZATION-AXES Phase 5d: `persistence: mikroorm` is a SYSTEM-MODE
    // selection (the second node persistence backend alongside the default
    // drizzle).  Generate the SYSTEM and type-check + bundle the mikroorm
    // deployable's project — proving the generated MikroORM EntitySchema model /
    // repositories / config / connection wiring compile against @mikro-orm/*.
    it("system `persistence: mikroorm` (node) — entities + repositories type-check + bundle", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-mikro-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/mikroorm.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        // Sanity: mikroorm replaced the drizzle schema with the EntitySchema model.
        expect(fs.existsSync(path.join(proj, "db", "entities.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "mikro-orm.config.ts"))).toBe(true);
        expect(fs.existsSync(path.join(proj, "db", "schema.ts"))).toBe(false);
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        execSync(`npm run build`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
        expect(fs.existsSync(path.join(proj, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // MikroORM event sourcing (appliers, MikroORM edition): a `persistence:
    // mikroorm` deployable hosting a `persistedAs: eventLog` aggregate emits the
    // EntityManager event store (read stream → fold, append on save) + the
    // `<agg>_events` EntitySchema, reusing the persistence-agnostic domain fold
    // + CQRS create chain.  Type-checks under tsc.
    it("system `persistence: mikroorm` + event sourcing — mikroorm event store type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-mikro-es-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/mikroorm-es.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        expect(fs.readFileSync(path.join(proj, "db", "entities.ts"), "utf8")).toContain(
          "AccountsEventRow",
        );
        expect(
          fs.readFileSync(path.join(proj, "db", "repositories", "account-repository.ts"), "utf8"),
        ).toContain("_fromEvents");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // MikroORM ES + `Id[]` reference collections: an event-sourced aggregate
    // whose `apply(...)` bodies fold a reference collection in-memory from the
    // stream (no pivot table — ES has no state table).  Type-checks under tsc.
    it("system `persistence: mikroorm` + event sourcing + Id[] reference collection — folds in-memory, type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-mikro-es-assoc-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/mikroorm-es-assoc.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const entities = fs.readFileSync(path.join(proj, "db", "entities.ts"), "utf8");
        // No pivot Row entity for the folded reference collection.
        expect(entities).not.toContain("SquadRosterRow");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);

    // MikroORM ES + nested contained parts: an event-sourced aggregate whose
    // `apply(...)` bodies rebuild a nested containment tree in-memory from the
    // stream (no child tables — ES has no state table).  Type-checks under tsc.
    it("system `persistence: mikroorm` + event sourcing + nested parts — folds in-memory, type-checks", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-mikro-es-parts-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/ts-build/mikroorm-es-parts.ddd -o ${outDir}`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        const entities = fs.readFileSync(path.join(proj, "db", "entities.ts"), "utf8");
        // No relational child tables for the folded containment tree.
        expect(entities).not.toContain("BoxRow");
        expect(entities).not.toContain("ItemRow");
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: proj,
          stdio: "inherit",
          timeout: 180_000,
        });
        execSync(`npx tsc --noEmit`, { cwd: proj, stdio: "inherit", timeout: 60_000 });
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);
  },
);
