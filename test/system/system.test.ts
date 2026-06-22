import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return doc.parseResult.value as Model;
}

describe("system / module / deployable", () => {
  it("parses examples/acme.ddd without errors", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(repoRoot, "examples/acme.ddd")),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("emits one project per deployable + docker-compose at the system root", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const keys = [...files.keys()];
    // Compose at the root.
    expect(keys).toContain("docker-compose.yml");
    // .NET deployable under api/, slug folder name, capitalised csproj.
    expect(keys).toContain("api/Api.csproj");
    expect(keys).toContain("api/Program.cs");
    expect(keys).toContain("api/Dockerfile");
    // Hono deployable under catalog_web/ (camelCase deployable name
    // slugged for docker / filesystem use).
    expect(keys).toContain("catalog_web/package.json");
    expect(keys).toContain("catalog_web/index.ts");
    expect(keys).toContain("catalog_web/Dockerfile");
  });

  it("scopes each deployable to its declared modules", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // catalog_web (Hono, modules: Catalog) sees Product but NOT Order.
    expect(files.has("catalog_web/domain/product.ts")).toBe(true);
    expect(files.has("catalog_web/domain/order.ts")).toBe(false);
    // api (.NET, contexts: [Catalog], Sales) sees both.
    const apiFiles = [...files.keys()].filter((k) => k.startsWith("api/"));
    expect(apiFiles.some((k) => /Domain\/Products\/Product\.cs$/.test(k))).toBe(true);
    expect(apiFiles.some((k) => /Domain\/Orders\/Order\.cs$/.test(k))).toBe(true);
  });

  it("docker-compose.yml wires postgres + a healthcheck per deployable", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const compose = files.get("docker-compose.yml")!;
    expect(compose).toMatch(/image: postgres:18-alpine/);
    expect(compose).toMatch(/api:\s*\n\s*build: \.\/api/);
    expect(compose).toMatch(/catalog_web:\s*\n\s*build: \.\/catalog_web/);
    expect(compose).toMatch(/8080:8080/);
    expect(compose).toMatch(/3000:3000/);
    // Backend deployables hit /ready (DB-aware) so the service is
    // only `healthy` once the schema bootstrap can reach the DB —
    // dependents + smoke tests don't race the bootstrap.
    expect(compose).toMatch(/wget -qO- http:\/\/localhost:8080\/ready/);
    expect(compose).toMatch(/wget -qO- http:\/\/localhost:3000\/ready/);
  });

  it("isolates each deployable to its own postgres database", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // Init script runs once on first boot of an empty pgdata volume.
    const init = files.get("db-init/00-create-databases.sql")!;
    expect(init).toMatch(/CREATE DATABASE api;/);
    expect(init).toMatch(/CREATE DATABASE catalog_api;/);
    expect(init).toMatch(/CREATE DATABASE catalog_web;/);
    const compose = files.get("docker-compose.yml")!;
    // Postgres mounts the init script.
    expect(compose).toMatch(/\.\/db-init:\/docker-entrypoint-initdb\.d:ro/);
    // Each deployable's connection string targets its own database.
    expect(compose).toMatch(/Database=api;/);
    expect(compose).toMatch(/Database=catalog_api;/);
    expect(compose).toMatch(/postgres:postgres@db:5432\/catalog_web/);
  });

  it("emits a /health endpoint on each deployable", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const honoIndex = files.get("catalog_web/http/index.ts")!;
    expect(honoIndex).toMatch(/app\.get\("\/health"/);
    const dotnetProgram = files.get("api/Program.cs")!;
    expect(dotnetProgram).toMatch(/app\.MapGet\("\/health"/);
  });

  describe("container basics (/ready, SIGTERM, fail-fast)", () => {
    it("Hono backend gets a /ready route that pings the DB", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const honoIndex = files.get("catalog_web/http/index.ts")!;
      expect(honoIndex).toMatch(/app\.get\("\/ready"/);
      // Drizzle DB ping using sql`select 1`.
      expect(honoIndex).toMatch(/db\.execute\(sql`select 1`\)/);
      // 503 on failure with a one-line cause.
      expect(honoIndex).toMatch(/status: "not_ready"/);
      expect(honoIndex).toMatch(/, 503\)/);
    });

    it(".NET backend gets a /ready route that pings the DB", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const program = files.get("api/Program.cs")!;
      expect(program).toMatch(/app\.MapGet\("\/ready"/);
      expect(program).toMatch(/db\.Database\.CanConnectAsync/);
      expect(program).toMatch(/statusCode: 503/);
    });

    it("Hono root index.ts captures the server handle and listens for SIGTERM/SIGINT", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const idx = files.get("catalog_web/index.ts")!;
      // Captured `const server = serve(...)` so shutdown can close it.
      expect(idx).toMatch(/const server = serve\(/);
      // Both signals registered.
      expect(idx).toMatch(/process\.on\("SIGTERM"/);
      expect(idx).toMatch(/process\.on\("SIGINT"/);
      // Shutdown closes server + ends the pg pool.
      expect(idx).toMatch(/server\.close/);
      expect(idx).toMatch(/pool\.end\(\)/);
    });

    it("Hono root index.ts fails fast on missing DATABASE_URL", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const idx = files.get("catalog_web/index.ts")!;
      expect(idx).toMatch(/if \(!process\.env\.DATABASE_URL\)/);
      expect(idx).toMatch(/DATABASE_URL is required/);
    });

    it(".NET Program.cs fails fast on missing connection string", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const program = files.get("api/Program.cs")!;
      expect(program).toMatch(/Missing connection string 'Default'/);
      expect(program).toMatch(/ConnectionStrings__Default/);
    });

    it(".NET Program.cs emits the catalog server-shutdown event on SIGTERM", async () => {
      // The bare "Shutting down" breadcrumb was superseded by catalog
      // identity (see Bite 5a) — server_shutdown / server_drained now
      // land on the structured stream with the cross-backend event
      // names Hono and Phoenix also use.
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const program = files.get("api/Program.cs")!;
      expect(program).toMatch(/ApplicationStopping\.Register/);
      expect(program).toMatch(/"server_shutdown", "SIGTERM"/);
    });
  });

  describe("boot migration lifecycle events (observability.md)", () => {
    it("Hono root index.ts brackets the drizzle boot migrate with catalog events", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const idx = files.get("catalog_web/index.ts")!;
      // drizzle's migrate() runs the whole batch in one opaque call, so
      // starting/complete bracket it and failed sits in the catch — no
      // per-migration migration_applied seam (Python/.NET emit that).
      expect(idx).toMatch(/baseLogger\.info\(\{ event: "migrations_starting" \}\)/);
      expect(idx).toMatch(/await migrate\(db, \{ migrationsFolder: "\.\/db\/migrations" \}\)/);
      expect(idx).toMatch(/baseLogger\.info\(\{ event: "migrations_complete" \}\)/);
      expect(idx).toMatch(
        /baseLogger\.error\(\{ event: "migration_failed", error: err instanceof Error \? err\.message : String\(err\) \}\)/,
      );
    });

    it(".NET Program.cs brackets the EF boot migrate with catalog events (per-id applied)", async () => {
      const model = await buildModel("examples/acme.ddd");
      const { files } = generateSystems(model);
      const program = files.get("api/Program.cs")!;
      // EF exposes the pending ids before applying, so migration_applied
      // fires per id (no cheap per-migration duration → duration_ms omitted).
      expect(program).toMatch(
        /var pendingMigrations = db\.Database\.GetPendingMigrations\(\)\.ToList\(\)/,
      );
      expect(program).toMatch(
        /migrationLog\.LogInformation\("\{Event\} count=\{Count\}", "migrations_starting", pendingMigrations\.Count\)/,
      );
      expect(program).toMatch(
        /migrationLog\.LogInformation\("\{Event\} id=\{Id\} name=\{Name\}", "migration_applied", migrationId, migrationId\)/,
      );
      expect(program).toMatch(
        /migrationLog\.LogInformation\("\{Event\} applied=\{Applied\}", "migrations_complete", pendingMigrations\.Count\)/,
      );
      // Failure carries the exception so the stack trace rides the record.
      expect(program).toMatch(
        /migrationLog\.LogError\(migrationError, "\{Event\} error=\{Error\}", "migration_failed", migrationError\.Message\)/,
      );
    });

    it("Python boot migrate runner emits the catalog migration-lifecycle events", async () => {
      const model = await buildModel("test/e2e/fixtures/python-build/shell.ddd");
      const { files } = generateSystems(model);
      const migrate = files.get("api/app/db/migrate.py")!;
      expect(migrate).toContain("from app.obs.log import log");
      expect(migrate).toContain('log("info", "migrations_starting", count=len(pending))');
      // per-file applied (id/name/duration_ms) inside the loop
      expect(migrate).toContain('"migration_applied",');
      expect(migrate).toContain("duration_ms=round((time.monotonic() - started) * 1000, 3),");
      expect(migrate).toContain(
        'log("error", "migration_failed", id=tag, name=tag, error=str(exc))',
      );
      expect(migrate).toContain('log("info", "migrations_complete", applied=count)');
    });
  });

  it("rejects `generate system` on a file with no system blocks", async () => {
    // Legacy bare-context files don't have a system; generateSystems
    // returns an empty file map.
    const model = await buildModel("examples/sales.ddd");
    const { files } = generateSystems(model);
    expect(files.size).toBe(0);
  });

  it("lowers `test e2e` blocks to a vitest file with typed fetch calls", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/Acme.e2e.test.ts")!;
    expect(e2e).toMatch(/import \{ describe, it, expect \} from "vitest"/);
    // Endpoint table per deployable.
    expect(e2e).toMatch(/api: process\.env\.E2E_API_BASE/);
    expect(e2e).toMatch(/catalog_web: process\.env\.E2E_CATALOG_WEB_BASE/);
    // POST /products with a JSON body for `api.products.create({...})`.
    expect(e2e).toMatch(/__post\(`\$\{base\}\/api\/products`, \(\{ sku: "WIDGET-1"/);
    // GET /api/products/{id} for `api.products.getById(p)` (auto-`.id`).
    expect(e2e).toMatch(/__get\(`\$\{base\}\/api\/products\/\$\{p\.id\}`\)/);
    // POST /api/orders/{id}/add_line for the operation call with body.
    expect(e2e).toMatch(/__post\(`\$\{base\}\/api\/orders\/\$\{ord\.id\}\/add_line`,/);
    // GET /api/orders/by_customer with the find query name in snake_case.
    expect(e2e).toMatch(/__getQuery\(`\$\{base\}\/api\/orders\/by_customer`,/);
  });

  it("lowers `test e2e ... against <react>` to a Playwright spec via page objects", async () => {
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    // UI specs land inside the targeted react deployable's e2e/
    // folder, next to the auto-generated page objects.
    const ui = files.get("web_app/e2e/Acme.ui.spec.ts")!;
    // Specs import test/expect from the generated `./fixtures` (which
    // re-exports Playwright's, adding auto console-capture on failure).
    expect(ui).toMatch(/from "\.\/fixtures"/);
    expect(files.has("web_app/e2e/fixtures.ts")).toBe(true);
    expect(ui).toMatch(/from "\.\/pages\/product"/);
    expect(ui).toMatch(/from "\.\/pages\/order"/);
    // `ui.products.create({...})` lowers via ProductListPage.
    expect(ui).toMatch(/new ProductListPage\(page\)\.goto\(\)/);
    // `ui.orders.addLine(ord, {...})` opens the detail page and
    // calls the typed addLine method.
    expect(ui).toMatch(/new OrderDetailPage\(page, ord\.id\)\.goto\(\).+addLine/);
    // `ui.orders.confirm(ord)` (no body) calls confirm().
    expect(ui).toMatch(/new OrderDetailPage\(page, ord\.id\)\.goto\(\).+confirm/);
    // getById binds the detail handle; explicit, typed matchers
    // (`expect(read.status).toHaveText(...)`, resolved in the IR as
    // intrinsic matchers) lower to Playwright's web-first matchers
    // (auto-retrying against the DOM) — driven by the author's matcher
    // choice, not inferred from the expression's shape.
    expect(ui).toMatch(/await expect\(read\.field\("status"\)\)\.toHaveText\("Confirmed"\)/);
    expect(ui).toMatch(/await expect\(read\.linesRows\(\)\)\.toHaveCount\(1\)/);

    // The vitest api file does NOT include the UI test (it routes
    // through ui-e2e-render instead).
    const api = files.get("e2e/Acme.e2e.test.ts")!;
    expect(api).not.toMatch(/create then confirm an order via UI/);
  });

  it("UI tests live in the targeted react deployable's e2e folder", async () => {
    // Negative: react deployables that aren't targeted by any UI
    // test shouldn't get a spec file.
    const model = await buildModel("examples/acme.ddd");
    const { files } = generateSystems(model);
    expect(files.has("web_app/e2e/Acme.ui.spec.ts")).toBe(true);
    // Backends never get UI specs.
    expect(files.has("api/e2e/Acme.ui.spec.ts")).toBe(false);
    expect(files.has("catalog_api/e2e/Acme.ui.spec.ts")).toBe(false);
  });
});
