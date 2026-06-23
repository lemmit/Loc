import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// S5 of the domain-seam log-parity drain (docs/audits/domain-seam-log-parity.md):
// the repository "mechanism" debug trio —
//   aggregate_loaded {aggregate, id, found}  at getById
//   repository_save   {aggregate, id}        at the save path
//   find_executed     {aggregate, find, rows} at each declared find
// — must be emitted by the Python (FastAPI/SQLAlchemy) and Java (Spring/JPA)
// repositories.  Hono/.NET already emit all three (their byte-for-byte
// placement is the reference, not re-asserted here).  All three are `debug`;
// the catalog-coupling guard (catalog-parity.test.ts) pins the name+level.
// ---------------------------------------------------------------------------

// A `find` is declared so the find_executed seam is exercised on both backends.
const sysFor = (platform: "python" | "java", port: number): string => `
system S {
  subdomain M {
    context C {
      aggregate Order {
        customerId: string
        status: string
      }
      repository Orders for Order {
        find byCustomer(customerId: string): Order[] where this.customerId == customerId
      }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: ${port}
  }
}
`;

function sourceFor(files: Map<string, string>, ext: string): string {
  return [...files.entries()]
    .filter(([k]) => k.endsWith(ext))
    .map(([, v]) => v)
    .join("\n");
}

describe("S5 — repository mechanism debug events", () => {
  describe("Python (app.obs.log facade)", () => {
    it("emits aggregate_loaded / repository_save / find_executed at debug", async () => {
      const py = sourceFor(await generateSystemFiles(sysFor("python", 8000)), ".py");

      // get_by_id — found is a bool so a consumer can grep failed loads.
      expect(py).toContain(
        'log("debug", "aggregate_loaded", aggregate="Order", id=str(id), found=found is not None)',
      );
      // save path — (aggregate, id) prefix; children omitted.
      expect(py).toContain(
        'log("debug", "repository_save", aggregate="Order", id=str(aggregate.id))',
      );
      // declared find — rows is the integer cardinality.
      expect(py).toContain(
        'log("debug", "find_executed", aggregate="Order", find="byCustomer", rows=len(items))',
      );
      // the facade is imported.
      expect(py).toContain("from app.obs.log import");
    });
  });

  describe("Java (CatalogLog unified channel)", () => {
    it("emits aggregate_loaded / repository_save / find_executed at debug", async () => {
      const java = sourceFor(await generateSystemFiles(sysFor("java", 8080)), ".java");

      expect(java).toContain(
        'CatalogLog.event("aggregate_loaded", "debug", "aggregate", "Order", "id", String.valueOf(id.value()), "found", found.isPresent());',
      );
      expect(java).toContain(
        'CatalogLog.event("repository_save", "debug", "aggregate", "Order", "id", String.valueOf(saved.id().value()));',
      );
      expect(java).toContain(
        'CatalogLog.event("find_executed", "debug", "aggregate", "Order", "find", "byCustomer", "rows", result.size());',
      );
      // CatalogLog is imported into the repository impl file.
      expect(java).toMatch(/import [\w.]+\.config\.CatalogLog;/);
    });
  });
});
