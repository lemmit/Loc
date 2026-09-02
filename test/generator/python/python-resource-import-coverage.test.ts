// Python resource-verb IMPORT coverage — the import collector must reach every
// place a `<resource>.<verb>(...)` call can legally sit.
//
// `resourceImportLines` emits `from app.resources.<sourceType> import
// <resource>_<verb>` for each resource op the workflow body calls.  A statement
// shape the collector never walks is not a missing nicety: the CALL is still
// emitted (the statement renderer walks the body properly), so the module ends
// up awaiting a name it never imported — ruff F821, and a `NameError` on the
// first request that takes that branch.
//
// The gap this pins: `if let … { salesFiles.put(…) } else { salesJobs.enqueue(…) }`.
// The collector walked `for-each` bodies but not an `if-let`'s `thenBody` /
// `elseBody`, so BOTH branches' verbs went unimported.  Verified end-to-end:
// `ruff check` on the generated project reports two F821s without the fix.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

/** One system, one workflow, two resource kinds — only the nesting shape the
 *  `salesFiles.put` / `salesJobs.enqueue` calls sit inside varies. */
const system = (body: string): string => `system ResNestSys {
  subdomain Sales {
    context Sales {
      aggregate Order {
        ref: string
        status: string
      }
      criterion ByRef(needle: string) of Order = this.ref == needle
      repository Orders for Order { }

      workflow Archive {
        create(name: string) {
${body}
        }
      }
    }
  }
  api SalesApi from Sales
  storage pg    { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  storage bus   { type: rabbitmq }
  resource salesState { for: Sales, kind: state,       use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue,       use: bus }
  deployable api {
    platform: python
    contexts: [Sales]
    dataSources: [salesState, salesFiles, salesJobs]
    serves: SalesApi
    port: 8000
  }
}`;

const IF_LET_SRC = system(`          if let o = Orders.find(ByRef(name)) {
            salesFiles.put("orders/" + name, name)
          } else {
            salesJobs.enqueue(name)
          }`);

const FOR_EACH_SRC =
  system(`          let hits = Orders.findAll(ByRef(name), page: { offset: 0, limit: 50 })
          for o in hits {
            salesFiles.put("orders/" + name, name)
            salesJobs.enqueue(name)
          }`);

describe("python resource-verb imports reach every statement shape", () => {
  it("imports the verbs called inside an `if let` then/else branch", async () => {
    const wf = fileEndingWith(
      await generateSystemFiles(IF_LET_SRC),
      "app/http/workflows_routes.py",
    );
    // The calls are emitted…
    expect(wf).toContain('await sales_files_put("orders/" + name, name)');
    expect(wf).toContain("await sales_jobs_enqueue(name)");
    // …so their helpers must be imported, or the module is F821/NameError.
    expect(wf).toContain("from app.resources.s3 import sales_files_put");
    expect(wf).toContain("from app.resources.rabbitmq import sales_jobs_enqueue");
  });

  it("still imports the verbs called inside a `for each` body (no regression)", async () => {
    const wf = fileEndingWith(
      await generateSystemFiles(FOR_EACH_SRC),
      "app/http/workflows_routes.py",
    );
    expect(wf).toContain("from app.resources.s3 import sales_files_put");
    expect(wf).toContain("from app.resources.rabbitmq import sales_jobs_enqueue");
  });
});
