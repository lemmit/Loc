import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Router ⟺ OpenAPI create-surface parity (vanilla Phoenix).
//
// Regression gate for a divergence where the vanilla backend GENERATED and
// DOCUMENTED a create endpoint but never ROUTED it: the router gated
// `POST /<plural>` on the aggregate's explicit `creates`, while the OpenAPI
// spec emitted the `post` operation UNCONDITIONALLY and the controller emitted
// the `create` action by constructibility.  A bare `aggregate Order { ... }`
// (constructible, but with no explicit `create` operation) therefore had a
// documented + implemented create that `POST /api/orders` 404'd on — invisible
// to the conformance-parity gate, which diffs SPECS across backends, not a
// backend's spec against its own routes.
//
// The fix routes BOTH the route and the `post` operation off ONE shared
// predicate (`emitsRestCreate`).  These tests pin that they can never drift:
// every aggregate the router create-routes is create-documented, and vice
// versa.
// ---------------------------------------------------------------------------

/** Aggregates the router wires a `POST /<plural>` create route for. */
function routerCreateAggregates(router: string): Set<string> {
  const out = new Set<string>();
  for (const m of router.matchAll(/post\s+"\/\w+",\s+(\w+)Controller,\s+:create/g)) {
    out.add(m[1]!);
  }
  return out;
}

/** Aggregates the OpenAPI spec documents a `post` create operation for. */
function specCreateAggregates(spec: string): Set<string> {
  const out = new Set<string>();
  for (const m of spec.matchAll(/summary:\s+"Create (\w+)"/g)) {
    out.add(m[1]!);
  }
  return out;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

// A bare, constructible aggregate — no `with crudish`, no operations.  This is
// the exact shape the bug dropped: constructible (no blocking invariant), so
// every other backend exposes `POST /orders`, but the vanilla router used to
// gate on `creates` and leave it unrouted.
const BARE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order ids guid {
        code: string
        region: string
      }
      repository Orders for Order {}
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla create-route ⟺ OpenAPI parity", () => {
  it("routes POST /<plural> for a bare constructible aggregate (the regressed case)", async () => {
    const files = await generateSystemFiles(BARE);
    const router = file(files, "/router.ex");
    expect(router).toContain('post "/orders", OrderController, :create');
  });

  it("the plain list index returns a BARE array, not an {items} envelope", async () => {
    // A non-paged `findAll` list must serialise as a bare array — the
    // cross-backend contract (node/python/java/dotnet + the OpenAPI
    // `type: array` spec all use bare arrays; only `paged<T>` finds carry the
    // `{items, page, …}` envelope).  The index action used to wrap in
    // `%{items: …}`, which breaks every generated frontend's API client and the
    // shared isolation harness's `list.map`.
    const files = await generateSystemFiles(BARE);
    const ctrl = file(files, "/order_controller.ex");
    expect(ctrl).toContain("json(conn, Enum.map(records, &serialize/1))");
    expect(ctrl).not.toContain("json(conn, %{items: Enum.map(records");
  });

  it("documents the create in the OpenAPI spec for the same bare aggregate", async () => {
    const files = await generateSystemFiles(BARE);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    expect(spec).toContain('summary: "Create Order"');
  });

  it("router create-routes and OpenAPI create-docs are the same set (bare aggregate)", async () => {
    const files = await generateSystemFiles(BARE);
    const router = file(files, "/router.ex");
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    expect([...routerCreateAggregates(router)].sort()).toEqual(
      [...specCreateAggregates(spec)].sort(),
    );
    expect(routerCreateAggregates(router)).toContain("Order");
  });

  it("a tenantOwned stamped field is excluded from cast/validate_required, but still stamped on insert", async () => {
    // The `tenantOwned` capability adds a server-stamped `tenantId` column.  It
    // must NOT ride the changeset's cast/validate_required (that runs BEFORE the
    // repository's `put_change` stamp and would 422 the create with
    // "tenant_id can't be blank"), yet the repository must still stamp it from
    // the claim.  Regression gate for the runtime defect the isolation boot
    // surfaced once the create route was wired.
    const src = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
      "__PLATFORM__",
      "elixir",
    );
    const files = await generateSystemFiles(src);
    const changeset = file(files, "/billing/invoice_changeset.ex");
    // tenant_id is neither cast nor required (server-owned, stamped).
    expect(changeset).toMatch(/@all_fields \[[^\]]*\]/);
    expect(changeset).not.toMatch(/@all_fields \[[^\]]*:tenant_id/);
    expect(changeset).not.toMatch(/@required_fields \[[^\]]*:tenant_id/);
    // …but the repository still stamps it from the principal claim on insert.
    const repo = file(files, "/billing/invoice_repository.ex");
    expect(repo).toContain(
      "|> Ecto.Changeset.put_change(:tenant_id, current_user && current_user.tenant_id)",
    );
  });

  it("parity holds across a multi-aggregate tenancy system (crudish + registry)", async () => {
    const src = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
      "__PLATFORM__",
      "elixir",
    );
    const files = await generateSystemFiles(src);
    const router = file(files, "/router.ex");
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    const spec = files.get(specKey!)!;
    const routed = routerCreateAggregates(router);
    const documented = specCreateAggregates(spec);
    expect([...routed].sort()).toEqual([...documented].sort());
    // Both the tenant-owned aggregate and the registry are constructible.
    expect(routed).toContain("Invoice");
    expect(routed).toContain("Organization");
  });
});
