// Cross-backend parity for SCALAR-return aggregate operations (BUG-003).
//
// An `operation describe(): string { return code }` has a non-void, non-`or`-
// union return type.  The value it returns must reach the client: every backend
// emits HTTP **200 with the value serialized to wire** and declares that scalar
// body in OpenAPI — NOT the 204-No-Content-discard that three of the five
// backends used to emit (the value was computed and thrown away).  Void ops
// (no return type) stay 204; union ops keep their 200/ProblemDetails path.
//
// This pins the convergence statically (no boot, no docker) across all five
// backends, the fast per-PR complement to the OpenAPI-diff parity e2e (whose
// `responseBodySchemas` normalizer now encodes the inline scalar as
// `scalar:<type>` so it, too, can tell a 200-scalar-body from a 204).
//
// Always-on `test` gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** A single aggregate with one scalar-return op (`describe(): string`) and one
 *  void op (`touch()`) for the 204 contrast, hosted on `<platform>`. */
const system = (platform: string): string => `
system Shop {
  subdomain Sales { context Shop {
    aggregate Order with crudish {
      code: string
      operation describe(): string { return code }
      operation touch() { code := code }
    }
  } }
  api OApi from Sales
  storage pg { type: postgres }
  resource st { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform} contexts: [Shop] dataSources: [st] serves: OApi port: 4000 }
}`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `expected a generated file ending in ${suffix}`).toBeDefined();
  return files.get(key!)!;
};

describe("scalar-return operations — 200-with-value across all five backends (BUG-003)", () => {
  it("Hono declares a 200 z.string() body and returns the value (not 204)", async () => {
    const files = await generateSystemFiles(system("node"));
    const routes = fileEndingWith(files, "http/order.routes.ts");
    // The describe route's 200 schema is the scalar's own zod, not `${Agg}Response`.
    expect(routes).toMatch(/schema: z\.string\(\) \} \} \},/);
    expect(routes).not.toContain("schema: OrderResponse } } },\n      200"); // never the mistyped fallback
    expect(routes).toContain("return c.json(result, 200);");
  });

  it(".NET declares [ProducesResponseType(typeof(string), 200)] and returns Ok(result)", async () => {
    const files = await generateSystemFiles(system("dotnet"));
    const ctrl = fileEndingWith(files, "OrdersController.cs");
    expect(ctrl).toContain("[ProducesResponseType(typeof(string), 200)]");
    expect(ctrl).toContain("return Ok(result);");
  });

  it("Python types the 200 as response_model=str and returns the value", async () => {
    const files = await generateSystemFiles(system("python"));
    const routes = fileEndingWith(files, "http/order_routes.py");
    expect(routes).toContain('response_model=str, operation_id="describeOrder"');
    // The describe handler returns the value, not `Response(status_code=204)`.
    expect(routes).toMatch(/async def describe_order[\s\S]*?\n {4}return result\n/);
  });

  it("Java returns a typed ResponseEntity body (not 204 No Content)", async () => {
    const files = await generateSystemFiles(system("java"));
    const ctrl = fileEndingWith(files, "OrdersController.java");
    // The describe endpoint carries a body type + ok(...) rather than a void
    // @ResponseStatus(NO_CONTENT) method.
    expect(ctrl).toMatch(/ResponseEntity<[^>]+>\s+describe/);
    expect(ctrl).toContain("ResponseEntity.ok(");
  });

  it("vanilla Phoenix OpenAPI declares 200 (a string schema), not 204, for the scalar op", async () => {
    const files = await generateSystemFiles(system("elixir"));
    const spec = fileEndingWith(files, "o_api_spec.ex");
    // Slice the describe operation's PathItem so the assertions bind to IT, not
    // to some unrelated 200 elsewhere in the single spec module.
    const start = spec.indexOf('"/orders/{id}/describe"');
    expect(start, "expected the describe path in the OpenAPI spec").toBeGreaterThanOrEqual(0);
    const rest = spec.slice(start);
    const end = rest.indexOf('"/orders/{id}', 1);
    const block = end > 0 ? rest.slice(0, end) : rest;
    // 200 with an inline :string schema — the scalar body — and no 204 discard.
    expect(block).toMatch(/200 => %OpenApiSpex\.Response\{/);
    expect(block).toContain("%OpenApiSpex.Schema{type: :string}");
    expect(block).not.toContain("204 =>");
  });
});
