// ---------------------------------------------------------------------------
// Java backend — exception-less operation returns (exception-less.md).
// An `operation foo(): X or NotFound` emits a sealed domain union
// (entity package, domain-typed) the aggregate method returns, a
// Jackson-polymorphic wire DTO (`type` discriminator, the pinned
// cross-backend tag), a service that threads the union through
// (capture → save → return), and a controller switch translating
// error variants to RFC-7807 ProblemDetail at their mapped status and
// success variants to 200 with the wire record.  Boot-verified
// end-to-end against Postgres via
// test/e2e/fixtures/java-build/operation-returns.ddd.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/operation-returns.ddd", "utf8");

const ROOT = "ru_api/src/main/java/com/loom/ruapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — exception-less operation returns", () => {
  it("passes validation (java joined SUPPORTED_RETURN_BACKENDS)", async () => {
    const loom = await buildLoomModel(SRC);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.operation-return-unsupported",
    );
    expect(errors).toEqual([]);
  });

  it("emits the sealed domain union + variant records in the entity package", async () => {
    const files_ = await files();
    const iface = files_.get(`${ROOT}/features/orders/NotFoundOrstring.java`)!;
    expect(iface).toContain(
      "public sealed interface NotFoundOrstring permits NotFoundOrstring_string, NotFoundOrstring_NotFound {",
    );
    const err = files_.get(`${ROOT}/features/orders/NotFoundOrstring_NotFound.java`)!;
    expect(err).toContain(
      "public record NotFoundOrstring_NotFound(String resource) implements NotFoundOrstring {",
    );
    const ok = files_.get(`${ROOT}/features/orders/NotFoundOrstring_string.java`)!;
    expect(ok).toContain(
      "public record NotFoundOrstring_string(String value) implements NotFoundOrstring {",
    );
  });

  it("renders the domain method returning tagged variant records", async () => {
    const entity = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(entity).toContain("public NotFoundOrstring reject() {");
    expect(entity).toContain("return new NotFoundOrstring_NotFound(this.code);");
    expect(entity).toContain("return new NotFoundOrstring_string(this.code);");
  });

  it("emits the Jackson-polymorphic wire union with the pinned `type` tag", async () => {
    const wire = (await files()).get(`${ROOT}/features/orders/NotFoundOrstringResponse.java`)!;
    expect(wire).toContain(
      '@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")',
    );
    expect(wire).toContain(
      '@JsonSubTypes.Type(value = NotFoundOrstringResponse_string.class, name = "string")',
    );
    expect(wire).toContain(
      '@JsonSubTypes.Type(value = NotFoundOrstringResponse_NotFound.class, name = "NotFound")',
    );
  });

  it("service threads the union through: capture, save, publish, return", async () => {
    const svc = (await files()).get(`${ROOT}/features/orders/OrderService.java`)!;
    expect(svc).toContain("    public NotFoundOrstring accept(OrderId id) {");
    expect(svc).toContain("        var result = aggregate.accept();");
    expect(svc).toContain("        repository.save(aggregate);");
    expect(svc).toContain("        return result;");
  });

  it("controller switches the union: error → ProblemDetail at status, success → 200 wire DTO", async () => {
    const c = (await files()).get(`${ROOT}/features/orders/OrdersController.java`)!;
    expect(c).toContain("public ResponseEntity<?> rejectOrder(@PathVariable UUID id) {");
    expect(c).toContain("return switch (result) {");
    expect(c).toContain(
      "ResponseEntity.ok((NotFoundOrstringResponse) new NotFoundOrstringResponse_string(v.value()));",
    );
    expect(c).toContain("var problem = ProblemDetail.forStatus(404);");
    expect(c).toContain('problem.setTitle("Not Found");');
    expect(c).toContain('problem.setType(URI.create("/errors/not-found"));');
    expect(c).toContain(
      "yield ResponseEntity.status(404).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(problem);",
    );
  });
});
