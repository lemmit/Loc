import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — extern operations (extern (b) Phase 2, docs/extern.md).
// The aggregate `operation X() extern` is CASE-1 pure domain logic: it is
// re-homed from an injected per-op handler registry to a DOMAIN EXTENSION
// POINT — the op body (preconditions → hook → invariants) delegates the
// mutation to a user-owned, scaffold-once hook FUNCTION that receives the
// aggregate and reaches its own private state directly.  So:
//   - the aggregate exposes a REAL `def <op>(self, …)` method (no `check_<op>`),
//   - it mints NO per-field setters (fields stay private behind getters),
//   - the deleted apparatus (typed registry, `register_*`, boot verify,
//     dev-stubs, `ExternHandlerError`) is gone, and
//   - `app/domain/extern/<agg>_extern.py` carries the `loom:scaffold-once`
//     marker + a loud `NotImplementedError` stub per op.
// This is DISTINCT from Phase 1 (#1850) `extern commandHandler`/`queryHandler`,
// which scaffolds `app/application/impl/<snake>_impl.py` and is untouched.
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
  it("aggregate exposes the extern op as a real method that delegates to the hook", async () => {
    const files = await build();
    const domain = files.get("api/app/domain/order.py")!;
    // A real `<op>` method (not a `check_<op>` precondition-only shim).
    expect(domain).toContain("def confirm(self) -> None:");
    expect(domain).toContain("def flag(self, score: int) -> None:");
    expect(domain).not.toContain("def check_confirm");
    expect(domain).not.toContain("def check_flag");
    // The op body: preconditions → hook call → invariants re-run.
    expect(domain).toContain("order_extern.confirm(self)");
    expect(domain).toContain("order_extern.flag(self, score)");
    expect(domain).toContain("from app.domain.extern import order_extern");
    // Invariants re-run after the hook mutates (§3c).
    const confirmBody = domain.slice(
      domain.indexOf("def confirm(self)"),
      domain.indexOf("def flag(self"),
    );
    expect(confirmBody).toContain("order_extern.confirm(self)");
    expect(confirmBody).toContain("self._assert_invariants()");
    expect(confirmBody.indexOf("order_extern.confirm(self)")).toBeLessThan(
      confirmBody.indexOf("self._assert_invariants()"),
    );
    // Regular ops are untouched.
    expect(domain).toContain("def cancel(self) -> None:");
  });

  it("aggregate mints NO per-field setters — fields stay private (encapsulation)", async () => {
    const files = await build();
    const domain = files.get("api/app/domain/order.py")!;
    expect(domain).not.toContain(".setter");
    expect(domain).not.toContain("@status.setter");
    // `raise_event` stays (the hook's event API); the public `assert_invariants`
    // seam is gone (the op method re-asserts internally).
    expect(domain).toContain("def raise_event(self, ev: DomainEvent) -> None:");
    expect(domain).not.toContain("def assert_invariants(self)");
  });

  it("scaffold-once hook module: marker + loud NotImplementedError stubs, no import cycle", async () => {
    const files = await build();
    const hook = files.get("api/app/domain/extern/order_extern.py")!;
    // Preserved-across-regen marker on line 1 (src/util/scaffold-once.ts).
    expect(hook.split("\n")[0]).toContain("loom:scaffold-once");
    // One raising stub per extern op — loud, mirroring the Elixir analog.
    expect(hook).toContain("def confirm(order: Order) -> None:");
    expect(hook).toContain("def flag(order: Order, score: int) -> None:");
    expect(hook).toContain("raise NotImplementedError(");
    expect(hook).toContain("extern operation `confirm` on Order is not implemented");
    // The aggregate imports the hook module, so the hook imports the aggregate
    // TYPE_CHECKING-only (no runtime cycle).
    expect(hook).toContain("from __future__ import annotations");
    expect(hook).toContain("if TYPE_CHECKING:");
    expect(hook).toContain("    from app.domain.order import Order");
    // The extern package is a real module.
    expect(files.get("api/app/domain/extern/__init__.py")).toBe("");
  });

  it("route drives the op like any other operation — no registry dispatch", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("found.confirm()");
    expect(routes).toContain("found.flag(");
    // None of the deleted injected-handler apparatus survives.
    expect(routes).not.toContain("order_handlers");
    expect(routes).not.toContain("check_confirm");
    expect(routes).not.toContain("ExternHandlerError");
    expect(routes).not.toContain("Missing extern handler");
  });

  it("deleted apparatus: no handlers module, no boot verify, no ExternHandlerError", async () => {
    const files = await build();
    // The old typed-registry module is gone.
    expect(files.get("api/app/domain/order_handlers.py")).toBeUndefined();
    // No boot-time registration verify in the lifespan.
    expect(files.get("api/app/main.py")!).not.toContain("extern_handlers_registered");
    // The 500-wrapping error type is deleted (not shared with Phase 1).
    expect(files.get("api/app/domain/errors.py")!).not.toContain("ExternHandlerError");
    expect(files.get("api/app/http/problem.py")!).not.toContain("ExternHandlerError");
  });

  it("extern-less aggregates emit no hook module and no setters", async () => {
    const source = FIXTURE.replace(
      /operation (confirm\(\)|flag\(score: int\)) extern \{[\s\S]*?\n {8}\}\n/g,
      "",
    );
    expect(source).not.toMatch(/operation \w+\([^)]*\) extern/);
    const { model, errors } = await parseString(source);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const files = generateSystems(model).files;
    expect(files.get("api/app/domain/extern/order_extern.py")).toBeUndefined();
    const domain = files.get("api/app/domain/order.py")!;
    expect(domain).not.toContain(".setter");
    expect(domain).not.toContain("def raise_event");
  });
});
