// ---------------------------------------------------------------------------
// Java backend — discriminated unions in find positions (P4c producer
// side; java joined SUPPORTED_UNION_BACKENDS).  A union find
// (`Order or NotFound` / `Order option`) reaches the repository and
// service as its OPTIONAL TWIN (single nullable row — the Domain layer
// never names the Response union); the controller owns the
// translation: found → 200 with the tagged wire record (the pinned
// flat `type` discriminator), absent → bare 404 (`none`) or an
// RFC-7807 ProblemDetail at the error's mapped status with the
// `resource` extension when the error payload declares one.
// Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/union-finds.ddd — byte-matching the
// Hono wire ({"type":"Order",...} / problem with resource / bare 404).
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

  it("emits the Jackson-polymorphic wire union (no domain union — finds never name it)", async () => {
    const files_ = await files();
    const wire = files_.get(`${ROOT}/features/orders/OrderOrNotFoundResponse.java`)!;
    expect(wire).toContain(
      '@JsonSubTypes.Type(value = OrderOrNotFoundResponse_Order.class, name = "Order")',
    );
    expect(files_.has(`${ROOT}/features/orders/OrderOrNotFound.java`)).toBe(false);
  });

  it("error-payload absence → ProblemDetail at the mapped status with the resource extension", async () => {
    const c = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(c).toContain("public ResponseEntity<?> byCodeOrder(@RequestParam String code) {");
    expect(c).toContain("var problem = ProblemDetail.forStatus(404);");
    expect(c).toContain('problem.setProperty("resource", "Order");');
    expect(c).toContain(
      "return ResponseEntity.ok((OrderOrNotFoundResponse) new OrderOrNotFoundResponse_Order(r.id(), r.code()));",
    );
  });

  it("`none` absence → the bare optional-find 404", async () => {
    const c = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(c).toContain("public ResponseEntity<?> maybeFirstOrder(@RequestParam String code) {");
    expect(c).toContain("            return ResponseEntity.notFound().build();");
  });
});
