// Cross-backend REQUEST-side hardening parity — schemathesis F2 / F3 / F4
// (docs/audits/schemathesis-findings-2026-08.md).
//
// Three findings, one shape: the published contract said less than the
// database demanded, so a request that OBEYED the spec reached Postgres and
// came back a 500.
//
//   F2  an `X id` reference in a request BODY was a bare `z.string()` / `str`
//   F3  the same reference as a find QUERY parameter (`?owner=`)
//   F4  `page × pageSize` with `minimum: 1` and no maximum → OFFSET overflow
//
// Because the emitted OpenAPI is diffed cross-backend by `conformance-parity`,
// the fix only makes sense landed on all five backends together — so this test
// pins all five in one place rather than five per-backend spot checks.  A
// backend that quietly drops the uuid refinement or the declared bounds fails
// HERE, not in a nightly fuzz run.

import { describe, expect, it } from "vitest";
import { PAGED_MAX_PAGE, PAGED_MAX_PAGE_SIZE } from "../../src/ir/stdlib/generics.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One context, five deployables.  `Shipment.orderRef` is the reference field
 *  under test (F2, in the create/update body) and `find byOrder(order: Order
 *  id)` is the same reference as a query parameter (F3); the auto-`findAll` on
 *  each aggregate is paged, which carries the `page`/`pageSize` controls (F4). */
const SRC = `
system Fulfil {
  subdomain F {
    context F {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
      }
      repository Shipments for Shipment {
        find byOrder(order: Order id): Shipment? where this.orderRef == order
      }
    }
  }
  api FApi from F
  storage pg { type: postgres }
  resource st { for: F, kind: state, use: pg }
  deployable nodeApi   { platform: node,   contexts: [F], dataSources: [st], serves: FApi, port: 3000 }
  deployable pyApi     { platform: python, contexts: [F], dataSources: [st], serves: FApi, port: 3001 }
  deployable netApi    { platform: dotnet, contexts: [F], dataSources: [st], serves: FApi, port: 3002 }
  deployable javaApi   { platform: java,   contexts: [F], dataSources: [st], serves: FApi, port: 3003 }
  deployable exApi     { platform: elixir, contexts: [F], dataSources: [st], serves: FApi, port: 3004 }
}
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

async function fileMatching(re: RegExp): Promise<string> {
  const all = await files();
  const key = [...all.keys()].find((k) => re.test(k));
  expect(key, `no emitted file matched ${re}`).toBeDefined();
  return all.get(key!)!;
}

describe("request hardening — reference fields are uuid-validated (F2/F3)", () => {
  it("node: the request body's reference field is z.string().uuid()", async () => {
    const routes = await fileMatching(/shipment\.routes\.ts$/);
    expect(routes).toMatch(
      /const CreateShipmentRequest = z\.object\(\{\s*orderRef: z\.string\(\)\.uuid\(\)/,
    );
    // Regression guard for the exact defect: a bare z.string() on the REQUEST
    // side.  (The RESPONSE DTO keeps `orderRef: z.string()` — the constraint is
    // an input gate, and the server only ever serves stored uuids.)
    const requestBlocks = [...routes.matchAll(/const \w+Request = z\.object\(\{[\s\S]*?\}\)/g)]
      .map((m) => m[0])
      .join("\n");
    expect(requestBlocks).not.toMatch(/orderRef: z\.string\(\),/);
  });

  it("node: the find's reference QUERY parameter is uuid-validated too (F3)", async () => {
    const routes = await fileMatching(/shipment\.routes\.ts$/);
    expect(routes).toMatch(/const ByOrderQuery = z\.object\(\{\s*order: z\.string\(\)\.uuid\(\)/);
  });

  it("python: reference fields annotate the shared UuidStr, which publishes format: uuid", async () => {
    const wire = await fileMatching(/wire_models\.py$/);
    expect(wire).toContain("UuidStr = Annotated[");
    expect(wire).toContain('WithJsonSchema({"type": "string", "format": "uuid"})');
    expect(wire).toMatch(/StringConstraints\(pattern=r"\^\[0-9a-fA-F\]\{8\}-/);

    const routes = await fileMatching(/shipment_routes\.py$/);
    expect(routes).toContain("from app.http.wire_models import UuidStr");
    // Body field (F2) and find query parameter (F3) both take the constraint.
    expect(routes).toMatch(/^\s+orderRef: UuidStr$/m);
    expect(routes).toMatch(/by_order_shipments\(order: UuidStr/);
  });

  it(".NET binds the reference as Guid (type-level validation + Swashbuckle format: uuid)", async () => {
    const requests = await fileMatching(/Shipments\/Requests\/ShipmentRequests\.cs$/);
    expect(requests).toMatch(/record CreateShipmentRequest\(.*Guid OrderRef/);
    const ctrl = await fileMatching(/ShipmentsController\.cs$/);
    expect(ctrl).toMatch(/ByOrderShipment\(\[FromQuery\].*Guid order\)/);
  });

  it("java binds the reference as UUID (type-level validation + springdoc format: uuid)", async () => {
    const req = await fileMatching(/CreateShipmentRequest\.java$/);
    expect(req).toContain("UUID orderRef");
    const ctrl = await fileMatching(/ShipmentsController\.java$/);
    expect(ctrl).toContain("byOrderShipment(@RequestParam UUID order)");
  });

  it("elixir publishes format: :uuid for the reference field and casts it as :binary_id", async () => {
    const schemas = await fileMatching(/api\/schemas\/create_shipment_request\.ex$/);
    expect(schemas).toContain("%OpenApiSpex.Schema{type: :string, format: :uuid}");
    const schema = await fileMatching(/\/f\/shipment\.ex$/);
    expect(schema).toContain(":binary_id");
  });
});

describe("request hardening — the paged controls carry declared upper bounds (F4)", () => {
  it("the shared constants keep the derived offset inside a 32-bit int", () => {
    // .NET and Java compute `(page - 1) * pageSize` in `int`; an overflow there
    // wraps negative and the read 500s just as surely as a bigint OFFSET blowup.
    expect((PAGED_MAX_PAGE - 1) * PAGED_MAX_PAGE_SIZE).toBeLessThan(2 ** 31 - 1);
  });

  it("node declares .max() on both controls", async () => {
    const routes = await fileMatching(/shipment\.routes\.ts$/);
    expect(routes).toContain(
      `page: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE}).default(1),`,
    );
    expect(routes).toContain(
      `pageSize: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE_SIZE}).default(20),`,
    );
  });

  it("python declares Query(ge=…, le=…) on both controls", async () => {
    const routes = await fileMatching(/shipment_routes\.py$/);
    expect(routes).toContain(`page: Annotated[int, Query(ge=1, le=${PAGED_MAX_PAGE})] = 1`);
    expect(routes).toContain(
      `pageSize: Annotated[int, Query(ge=1, le=${PAGED_MAX_PAGE_SIZE})] = 20`,
    );
  });

  it(".NET declares [Range] on both controls", async () => {
    const ctrl = await fileMatching(/ShipmentsController\.cs$/);
    expect(ctrl).toContain(
      `[FromQuery] [System.ComponentModel.DataAnnotations.Range(1, ${PAGED_MAX_PAGE})] int page = 1`,
    );
    expect(ctrl).toContain(
      `[FromQuery] [System.ComponentModel.DataAnnotations.Range(1, ${PAGED_MAX_PAGE_SIZE})] int pageSize = 20`,
    );
  });

  it("java declares @Min/@Max on both controls", async () => {
    const ctrl = await fileMatching(/ShipmentsController\.java$/);
    expect(ctrl).toContain(
      `@jakarta.validation.constraints.Min(1) @jakarta.validation.constraints.Max(${PAGED_MAX_PAGE}) int page`,
    );
    expect(ctrl).toContain(
      `@jakarta.validation.constraints.Min(1) @jakarta.validation.constraints.Max(${PAGED_MAX_PAGE_SIZE}) int pageSize`,
    );
  });

  it("elixir publishes minimum/maximum and clamps in page_param/4", async () => {
    const spec = await fileMatching(/api\/f_api_spec\.ex$/);
    expect(spec).toContain(
      `%OpenApiSpex.Schema{type: :integer, minimum: 1, maximum: ${PAGED_MAX_PAGE}}`,
    );
    expect(spec).toContain(
      `%OpenApiSpex.Schema{type: :integer, minimum: 1, maximum: ${PAGED_MAX_PAGE_SIZE}}`,
    );
    const ctrl = await fileMatching(/shipment_controller\.ex$/);
    expect(ctrl).toContain("defp page_param(params, key, default, limit) do");
    expect(ctrl).toContain("{n, _} when n >= 1 -> min(n, limit)");
    expect(ctrl).toContain(`page_param(params, "page", 1, ${PAGED_MAX_PAGE})`);
    expect(ctrl).toContain(`page_param(params, "pageSize", 20, ${PAGED_MAX_PAGE_SIZE})`);
  });
});
