// `with versioned` → every backend DECLARES the 409 Conflict response on the
// `update` operation in the OpenAPI it serves (stale `If-Match` → optimistic-
// concurrency conflict).  This is the contract-declaration sibling of the
// runtime 409 arm asserted by the per-backend `*-concurrency-conflict.test.ts`:
// the guarded write throwing 409 at runtime is only half the story — the served
// OpenAPI must advertise it too, or the cross-backend conformance-parity gate
// (test/e2e error-response dimension) diverges (node declared 409, the four
// matrix-driven backends did not — the gap this test pins shut).
//
// A NON-versioned aggregate's `update` carries no 409 (no `when` gate, no
// version token), so the declaration is gated on `aggregateIsVersioned`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (platform: string, cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
    }
  }
`;

const ELIXIR = "elixir { foundation: vanilla }";

const fileMatching = (files: Map<string, string>, pred: (p: string) => boolean): string =>
  [...files.entries()]
    .filter(([p]) => pred(p))
    .map(([, c]) => c)
    .join("\n");

// The stretch of OpenAPI/route source describing the `update` operation — a
// window from the update path/action to the next ~40 lines, so the 409 match
// can't leak in from a sibling route (e.g. the destroy 409).
const updateWindow = (src: string, anchor: RegExp): string => {
  const idx = src.search(anchor);
  return idx < 0 ? "" : src.slice(idx, idx + 1600);
};

describe("versioned → 409 declared on the update op (cross-backend OpenAPI parity)", () => {
  it("Hono declares 409 on the update route", async () => {
    const files = await generateSystemFiles(system("node", "with versioned"));
    const routes = fileMatching(files, (p) => p.endsWith("customer.routes.ts"));
    const win = updateWindow(routes, /path: "\/\{id\}\/update"/);
    expect(win).toContain('409: { description: "Conflict"');
  });

  it("Hono declares no 409 on the update route when not versioned", async () => {
    const files = await generateSystemFiles(system("node", ""));
    const routes = fileMatching(files, (p) => p.endsWith("customer.routes.ts"));
    const win = updateWindow(routes, /path: "\/\{id\}\/update"/);
    expect(win).not.toContain("409");
  });

  it(".NET declares 409 on the UpdateCustomer action", async () => {
    const files = await generateSystemFiles(system("dotnet", "with versioned"));
    const ctrl = fileMatching(files, (p) => p.endsWith("CustomersController.cs"));
    const win = updateWindow(
      ctrl,
      /ProducesResponseType[^\n]*\n[^\n]*UpdateCustomer|UpdateCustomer/,
    );
    // The 409 ProducesResponseType decorates the UpdateCustomer action.
    const around = ctrl.slice(
      Math.max(0, ctrl.indexOf("UpdateCustomer") - 400),
      ctrl.indexOf("UpdateCustomer"),
    );
    expect(around).toContain("ProducesResponseType(typeof(ProblemDetails), 409)");
    expect(win).toBeTruthy();
  });

  it(".NET declares no 409 on UpdateCustomer when not versioned", async () => {
    const files = await generateSystemFiles(system("dotnet", ""));
    const ctrl = fileMatching(files, (p) => p.endsWith("CustomersController.cs"));
    const around = ctrl.slice(
      Math.max(0, ctrl.indexOf("UpdateCustomer") - 400),
      ctrl.indexOf("UpdateCustomer"),
    );
    expect(around).not.toContain("409");
  });

  it("Java declares 409 in the update route's status set", async () => {
    const files = await generateSystemFiles(system("java", "with versioned"));
    const cust = fileMatching(files, (p) => p.endsWith("OpenApiContractCustomizer.java"));
    expect(cust).toMatch(/"\/api\/customers\/\{id\}\/update"[^\n]*\{400, 404, 409, 422\}/);
  });

  it("Java declares no 409 in the update route when not versioned", async () => {
    const files = await generateSystemFiles(system("java", ""));
    const cust = fileMatching(files, (p) => p.endsWith("OpenApiContractCustomizer.java"));
    expect(cust).toMatch(/"\/api\/customers\/\{id\}\/update"[^\n]*\{400, 404, 422\}/);
  });

  it("Python declares 409 on the updateCustomer route", async () => {
    const files = await generateSystemFiles(system("python", "with versioned"));
    const routes = fileMatching(files, (p) => p.endsWith("customer_routes.py"));
    const win = updateWindow(routes, /operation_id="updateCustomer"/);
    expect(win).toContain('409: {"model": ProblemDetails');
  });

  it("Python declares no 409 on updateCustomer when not versioned", async () => {
    const files = await generateSystemFiles(system("python", ""));
    const routes = fileMatching(files, (p) => p.endsWith("customer_routes.py"));
    const win = updateWindow(routes, /operation_id="updateCustomer"/);
    expect(win).not.toContain("409");
  });

  it("Phoenix declares 409 on the /customers/{id}/update spec path", async () => {
    const files = await generateSystemFiles(system(ELIXIR, "with versioned"));
    const spec = fileMatching(files, (p) => p.endsWith("_api_spec.ex"));
    const win = updateWindow(spec, /"\/customers\/\{id\}\/update"/);
    expect(win).toContain("409 => %OpenApiSpex.Response{");
  });

  it("Phoenix declares no 409 on the update spec path when not versioned", async () => {
    const files = await generateSystemFiles(system(ELIXIR, ""));
    const spec = fileMatching(files, (p) => p.endsWith("_api_spec.ex"));
    const win = updateWindow(spec, /"\/customers\/\{id\}\/update"/);
    expect(win).not.toContain("409");
  });
});
