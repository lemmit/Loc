// ---------------------------------------------------------------------------
// Java backend — single-success union finds (`Order or NotFound` / `Order
// option`).  Per exception-less.md §4 the 200 body is the SUCCESS variant
// DIRECTLY (`<Agg>Response`) — never a tagged `oneOf` component (an error
// variant belongs at its status, not in a 200 schema) — so a union find is
// wire-identical to `<Agg>?` / `<Agg> option`.  The repository/service see the
// optional twin (single nullable row); the controller returns the
// `<Agg>Response` directly on 200 and translates absence → bare 404 (`none`)
// or an RFC-7807 ProblemDetail at the error's mapped status (with the
// `resource` extension when the error payload declares one).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/union-finds.ddd", "utf8");

const ROOT = "uf_api/src/main/java/com/loom/ufapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — union finds", () => {
  it("passes validation (java joined SUPPORTED_UNION_BACKENDS)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.union-unsupported");
    expect(errors).toEqual([]);
  });

  it("repository + service see the optional twin (single nullable row)", async () => {
    const files_ = await files();
    const port = files_.get(`${ROOT}/features/orders/OrderRepository.java`)!;
    expect(port).toContain("    Order byCode(String code);");
    expect(port).toContain("    Order maybeFirst(String code);");
    const svc = files_.get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("    public OrderResponse byCode(String code) {");
  });

  it("emits NO tagged wire union for a single-success find (success is <Agg>Response)", async () => {
    const files_ = await files();
    expect(files_.has(`${ROOT}/features/orders/OrderOrNotFoundResponse.java`)).toBe(false);
    expect(files_.has(`${ROOT}/features/orders/OrderOrNotFound.java`)).toBe(false);
  });

  it("error-payload absence → ProblemDetail at the mapped status with the resource extension", async () => {
    const c = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(c).toContain("public ResponseEntity<?> byCodeOrder(@RequestParam String code) {");
    expect(c).toContain("var problem = ProblemDetail.forStatus(404);");
    expect(c).toContain('problem.setProperty("resource", "Order");');
    // Found → the success variant directly (untagged), not a wrapped union.
    expect(c).toContain("return ResponseEntity.ok(r);");
  });

  it("`none` absence → the shared 404 producer, not a bare Spring 404", async () => {
    // INVERTED 2026-08-05.  This test used to assert the exact defect as
    // intent:
    //
    //     expect(c).toContain("            return ResponseEntity.notFound().build();");
    //
    // — Spring's own bare 404, which carries an EMPTY BODY because it never
    // reaches the `@RestControllerAdvice`.  That violates RS-22 (the five-member
    // envelope is required on ANY error response) and it made this ONE
    // controller answer two different wires for shapes `docs/payloads.md`
    // declares wire-identical: the `error`-variant find in the test above
    // builds a real ProblemDetail, this one built nothing.
    //
    // Invisible for as long as it shipped because no test called an `option`
    // find at runtime — the caller census (#2380) named `maybeFirstOrder` as a
    // zero-caller route, and the first caller read `golden {…} ≠ java ""` on
    // the behavioural java leg.  Same class as RS-27, same repair: throw, so
    // the shared producer answers.
    const c = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(c).toContain("public ResponseEntity<?> maybeFirstOrder(@RequestParam String code) {");
    expect(c).toContain('            throw new AggregateNotFoundException("not_found");');
    expect(c).not.toContain("ResponseEntity.notFound().build()");
  });
});
