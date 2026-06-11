import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — extern operations (plan S16, docs/extern.md).  An
// `operation X() extern` keeps only its precondition gate in generated
// code (`check_<op>`); the user-registered handler owns the mutation.
// The aggregate opens a controlled mutation surface (field setters,
// raise_event, public assert_invariants), the handlers module carries
// the typed registry + boot verify + no-op dev-stubs, and the route
// runs load → check → dispatch → assert_invariants → save, wrapping
// non-domain handler errors into ExternHandlerError (500).  Verified
// live (handler mutation persisted, 400 precondition, 500 wrap).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/extern.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python extern operations", () => {
  it("aggregate emits check_<op> instead of the operation method + mutation surface", async () => {
    const files = await build();
    const domain = files.get("api/app/domain/order.py")!;
    expect(domain).toContain("def check_confirm(self) -> None:");
    expect(domain).toContain("def check_flag(self, score: int) -> None:");
    expect(domain).not.toContain("def confirm(self)");
    // Controlled mutation surface for the user handler.
    expect(domain).toContain("@status.setter");
    expect(domain).toContain("def raise_event(self, ev: DomainEvent) -> None:");
    expect(domain).toContain("def assert_invariants(self) -> None:");
    // Regular ops are untouched.
    expect(domain).toContain("def cancel(self) -> None:");
  });

  it("handlers module: typed registry + register fns + boot verify + dev-stubs", async () => {
    const files = await build();
    const handlers = files.get("api/app/domain/order_handlers.py")!;
    expect(handlers).toContain("class ConfirmOrderRequest(TypedDict):");
    expect(handlers).toContain("class FlagOrderRequest(TypedDict):");
    expect(handlers).toContain("    score: int");
    expect(handlers).toContain(
      "ConfirmOrderHandler = Callable[[Order, ConfirmOrderRequest], Awaitable[None]]",
    );
    expect(handlers).toContain("def register_confirm_order_handler(fn: ConfirmOrderHandler)");
    expect(handlers).toContain("def verify_order_extern_handlers_registered() -> None:");
    expect(handlers).toContain("Missing extern handler for 'confirm' on aggregate 'Order'.");
    expect(handlers).toContain("register_confirm_order_handler(_confirm_dev_stub)");
  });

  it("route dispatches through the registry with the framework-owned lifecycle", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("from app.domain import order_handlers");
    expect(routes).toContain("found.check_confirm()");
    expect(routes).toContain("handler = order_handlers.confirm");
    expect(routes).toContain("await handler(found, {})");
    expect(routes).toContain('await handler(found, {"score": body.score})');
    expect(routes).toContain("except (AggregateNotFoundError, DomainError, ForbiddenError):");
    expect(routes).toContain('raise ExternHandlerError("confirm", "Order", err) from err');
    expect(routes).toContain("found.assert_invariants()");
    // The route never calls a (nonexistent) operation method.
    expect(routes).not.toContain("found.confirm(");
  });

  it("lifespan verifies handler registration at boot; 500 problem mapping exists", async () => {
    const files = await build();
    const main = files.get("api/app/main.py")!;
    expect(main).toContain(
      "from app.domain.order_handlers import verify_order_extern_handlers_registered",
    );
    expect(main).toContain("    verify_order_extern_handlers_registered()");
    const problem = files.get("api/app/http/problem.py")!;
    expect(problem).toContain("@app.exception_handler(ExternHandlerError)");
    const errors = files.get("api/app/domain/errors.py")!;
    expect(errors).toContain("class ExternHandlerError(Exception):");
  });

  it("extern-less aggregates emit no handlers module and no setters", async () => {
    const source = FIXTURE.replace(
      /operation (confirm\(\)|flag\(score: int\)) extern \{[\s\S]*?\n {8}\}\n/g,
      "",
    );
    expect(source).not.toMatch(/operation \w+\([^)]*\) extern/);
    const { model, errors } = await parseString(source);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.get("api/app/domain/order_handlers.py")).toBeUndefined();
    const domain = files.get("api/app/domain/order.py")!;
    expect(domain).not.toContain(".setter");
    expect(domain).not.toContain("def raise_event");
    expect(files.get("api/app/main.py")!).not.toContain("extern_handlers_registered");
  });
});
