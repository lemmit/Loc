import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Ash workflow body: an unused `let` bind is dropped from the `with`-chain.
//
// A workflow `let prev = <resource>.get(...)` whose result is never read used
// to emit `prev = <call>` as a with-clause — an unused variable that trips
// `mix compile --warnings-as-errors`.  The fix drops the dead bind and keeps
// the (side-effecting) RHS as a bare with-clause, matching the bare form the
// resource-call branch already emits.  The LAST bound name is the chain's
// return value, so a used trailing bind is always preserved.
//
// Non-transactional workflow: resource-call is rejected inside `transactional`
// (loom.workflow-tx-effect) since external effects don't roll back.
// ---------------------------------------------------------------------------

const SOURCE = `
system Archive {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { sku: string }
      repository Orders for Order { }

      workflow archive {
        create(name: string) {
          let prev = salesFiles.get("orders/" + name)
          salesFiles.put("orders/" + name, name)
          let info = crm.get("/customers")
        }
      }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  storage crmApi { type: restApi, config: { baseUrl: "http://crm:9000" } }
  resource salesState { for: Orders, kind: state, use: pg }
  resource salesFiles { for: Orders, kind: objectStore, use: files }
  resource crm { for: Orders, kind: api, use: crmApi }
  deployable d {
    platform: elixir { foundation: ash }
    contexts: [Orders]
    dataSources: [salesState, salesFiles, crm]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("phoenix/Ash workflow — unused `let` bind dropped", () => {
  it("drops the unread `prev =` bind but keeps the side-effecting RHS as a bare clause", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get([...files.keys()].find((k) => k.endsWith("/workflows/archive.ex"))!)!;
    // The dead bind is gone — no `prev =` …
    expect(wf).not.toMatch(/\bprev\b/);
    // … but the get call it wrapped is still a bare with-clause (side effect kept).
    expect(wf).toMatch(/\.Resources\.S3\.sales_files_get\(/);
  });

  it("preserves the trailing used bind as the chain's return value", async () => {
    const files = await generateSystemFiles(SOURCE);
    const wf = files.get([...files.keys()].find((k) => k.endsWith("/workflows/archive.ex"))!)!;
    // `info` is the last bind → it stays named and is returned.
    expect(wf).toMatch(/info = .+\.Resources\.RestApi\.crm_get\(/);
    expect(wf).toMatch(/\{:ok, info\}/);
  });
});
