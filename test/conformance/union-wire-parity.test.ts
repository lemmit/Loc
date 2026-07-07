// Cross-backend wire parity for single-success union finds
// (exception-less.md §4: "success bodies carry the variant data directly with
// HTTP 200").
//
// A `find x(): Agg or Err` (the validator-pinned absence shape,
// `loom.union-find-shape-unsupported`) is NOT a tagged discriminated union on
// the wire — the success variant is returned DIRECTLY as `<Agg>Response` at
// 200, and the error/absent variant is a separate status response (RFC-7807
// ProblemDetails).  So a union find is wire-identical to `<Agg>?` / `<Agg>
// option`, and every backend must agree: same untagged success body, no
// tagged `oneOf`/JsonPolymorphic component, no `type` discriminator, absence at
// its status.  This pins that convergence (the fix for BUG-005 — before it, the
// five backends disagreed four ways).  Tagged discriminated unions survive only
// for exception-less OPERATION returns (a separate construct); this test is the
// find complement.
//
// Always-on `test` gate (no docker).

import { describe, expect, it } from "vitest";
import { generateDotnet, generateHono, generateSystemFiles } from "../_helpers/generate.js";
import { parseValid } from "../_helpers/parse.js";

const CONTEXT = `
  context Orders {
    aggregate Order ids guid { code: string  region: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  }
`;

/** The same union find hosted on a vanilla-elixir deployable (elixir needs a
 *  full system to emit its controller). */
const VANILLA_SYSTEM = `
system UN {
  subdomain Orders { context Orders {
    aggregate Order ids guid with crudish { code: string  region: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  } }
  api OApi from Orders
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Orders] dataSources: [st] serves: OApi port: 4000 }
}
`;

describe("union finds — cross-backend success-variant-directly wire (exception-less.md §4)", () => {
  it("Hono returns <Agg>Response directly at 200, with no tagged union DTO", async () => {
    const routes = generateHono(await parseValid(CONTEXT)).get("http/order.routes.ts")!;
    // No discriminated-union DTO, no `type`-tagged body for the find.
    expect(routes).not.toContain("OrderOrNotFound");
    expect(routes).not.toContain("z.discriminatedUnion");
    // 200 is OrderResponse; absence is a ProblemDetails status.
    expect(routes).toMatch(/content: \{ "application\/json": \{ schema: OrderResponse \} \} \},/);
    expect(routes).toContain(
      "return c.json(repo.toWire(result) as z.infer<typeof OrderResponse>, 200);",
    );
    expect(routes).toContain("application/problem+json");
  });

  it(".NET query + controller return OrderResponse, with no polymorphic union DTO", async () => {
    const files = generateDotnet(await parseValid(CONTEXT));
    expect([...files.keys()].some((k) => k.endsWith("Responses/OrderOrNotFound.cs"))).toBe(false);
    const ctrl = files.get([...files.keys()].find((k) => k.endsWith("OrdersController.cs"))!)!;
    expect(ctrl).toContain("Task<ActionResult<OrderResponse>>");
    expect(ctrl).not.toContain("OrderOrNotFound");
    expect(
      files.get([...files.keys()].find((k) => k.endsWith("Queries/RecentQuery.cs"))!)!,
    ).toContain("IQuery<OrderResponse?>");
  });

  it("Python types the 200 as OrderResponse and returns the wire directly", async () => {
    const files = await generateSystemFiles(VANILLA_SYSTEM.replace("elixir", "python"));
    const routes = files.get([...files.keys()].find((k) => k.endsWith("http/order_routes.py"))!)!;
    // No untyped `response_model=None`, no tagged union model — the find is
    // typed as the plain OrderResponse and returns the wire record directly.
    expect(routes).toContain('response_model=OrderResponse, operation_id="recentOrder"');
    expect(routes).not.toContain("response_model=None");
    expect(routes).not.toContain("OrderOrNotFound");
    expect(routes).toContain("return repo.to_wire(found)");
    // Absent variant rides a ProblemDetails status, not a 200 body.
    expect(routes).toContain('404: {"model": ProblemDetails');
  });

  it("Java controller returns the <Agg>Response, with no union wire DTO", async () => {
    const files = await generateSystemFiles(VANILLA_SYSTEM.replace("elixir", "java"));
    expect([...files.keys()].some((k) => /OrderOrNotFound.*\.java$/.test(k))).toBe(false);
    const ctrl = files.get([...files.keys()].find((k) => k.endsWith("OrdersController.java"))!)!;
    expect(ctrl).toContain("return ResponseEntity.ok(r);");
    expect(ctrl).not.toContain("OrderOrNotFound");
  });

  it("vanilla Phoenix serializes the success record untagged (no :type), absence → 404", async () => {
    const files = await generateSystemFiles(VANILLA_SYSTEM);
    const ctrl = files.get([...files.keys()].find((k) => k.endsWith("order_controller.ex"))!)!;
    // Success is the plain serialized record — no `:type` tag (matches the
    // untagged spec + every other backend).
    expect(ctrl).toContain("json(conn, serialize(record))");
    expect(ctrl).not.toContain("Map.put(serialize(record), :type");
    // Absent variant rides a ProblemDetails status, not a 200 body.
    expect(ctrl).toContain("problem_variant(conn, 404");
  });
});
