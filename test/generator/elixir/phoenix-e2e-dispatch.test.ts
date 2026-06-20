import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

// ---------------------------------------------------------------------------
// verify that the e2e renderer dispatches to `phoenixLiveView`
// deployables and emits `/api/…` prefixed URL paths (Phoenix routes all
// its HTTP API inside `scope "/api"`).
//
// The fixture is a minimal system with one Phoenix backend that serves a
// single aggregate module and has a couple of `test e2e` blocks against it.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const FIXTURE_SOURCE = `system PhoenixShop {

  subdomain Store {
    context Store {
      aggregate Item {
        name: string
        derived display: string = name
        price: decimal
        invariant price > 0
        operation archive() {
          price := 0
        }
      }
      repository Items for Item {
        find byName(name: string): Item? where this.name == name
      }
    }
  }

  api StoreApi from Store

  deployable shopBackend {
    platform: elixir,
    contexts: [Store],
    serves: StoreApi,
    port: 4000
  }

  test e2e "create an item, look it up" against shopBackend {
    let it = api.items.create({ name: "Gadget", price: 19.99 })
    let read = api.items.getById(it)
    expect(read.name).toBe("Gadget")
  }

  test e2e "archive an item via operation" against shopBackend {
    let it = api.items.create({ name: "Old", price: 5.00 })
    api.items.archive(it)
  }

  test e2e "find items by name" against shopBackend {
    let result = api.items.byName({ name: "Gadget" })
  }
}
`;

async function buildFixture(): Promise<Model> {
  // Write to a temp dir so the Langium document URI is stable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-phx-e2e-"));
  const file = path.join(dir, "phoenix-shop.ddd");
  fs.writeFileSync(file, FIXTURE_SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `Validation errors in fixture:\n` + errors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return doc.parseResult.value as Model;
}

describe("e2e dispatch to phoenixLiveView", () => {
  it("emits e2e/<system>.e2e.test.ts for a phoenix deployable", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    // The e2e spec must be generated.
    expect(files.has("e2e/PhoenixShop.e2e.test.ts")).toBe(true);
  });

  it("includes the phoenix deployable in the ENDPOINTS table", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/PhoenixShop.e2e.test.ts")!;
    // ENDPOINTS entry uses the service slug derived from the deployable name.
    expect(e2e).toMatch(/shop_backend: process\.env\.E2E_SHOP_BACKEND_BASE/);
    expect(e2e).toMatch(/http:\/\/localhost:4000/);
  });

  it("prefixes aggregate CRUD calls with /api for phoenix", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/PhoenixShop.e2e.test.ts")!;
    // POST /api/items  — create
    expect(e2e).toMatch(/__post\(`\$\{base\}\/api\/items`/);
    // GET  /api/items/{id}  — getById (auto-.id on let-bound result)
    expect(e2e).toMatch(/__get\(`\$\{base\}\/api\/items\/\$\{it\.id\}`\)/);
  });

  it("prefixes aggregate operation calls with /api for phoenix", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/PhoenixShop.e2e.test.ts")!;
    // POST /api/items/{id}/archive
    expect(e2e).toMatch(/__post\(`\$\{base\}\/api\/items\/\$\{it\.id\}\/archive`/);
  });

  it("prefixes find (repository query) calls with /api for phoenix", async () => {
    const model = await buildFixture();
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/PhoenixShop.e2e.test.ts")!;
    // GET /api/items/by_name?name=...
    expect(e2e).toMatch(/__getQuery\(`\$\{base\}\/api\/items\/by_name`/);
  });

  it("adds the /api prefix to hono/dotnet deployables too", async () => {
    // The existing acme.ddd system has dotnet and hono deployables.
    // Every backend now mounts its domain routes under the shared /api base.
    const services = createDddServices(NodeFileSystem);
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(repoRoot, "examples/acme.ddd")),
    );
    await services.shared.workspace.DocumentBuilder.build([doc], {
      validation: true,
    });
    const model = doc.parseResult.value as Model;
    const { files } = generateSystems(model);
    const e2e = files.get("e2e/Acme.e2e.test.ts")!;
    // These must hit /api/products (every backend mounts under /api now).
    expect(e2e).toMatch(/__post\(`\$\{base\}\/api\/products`/);
    expect(e2e).toMatch(/__get\(`\$\{base\}\/api\/products\/\$\{p\.id\}`\)/);
  });
});
