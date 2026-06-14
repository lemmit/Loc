import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — `when` state gate (F4, criterion.md use site 2).  A
// `when`-gated operation evaluates its predicate against the loaded
// aggregate before the body runs (false → DisallowedError → 409) and
// auto-exposes a side-effect-free `GET /{id}/can_<op>` returning
// `{ allowed }`.  Verified live (Draft → can_submit true → submit 204 →
// can_submit false → re-submit 409 problem+json) and statically by the
// `when.ddd` corpus case (uv + ruff + mypy --strict).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/when.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python when gate + can-query", () => {
  it("injects the DisallowedError state gate before the operation body", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("from app.domain.errors import DisallowedError");
    expect(routes).toContain('if not (found.status == "Draft"):');
    expect(routes).toContain(
      "raise DisallowedError(\"operation 'submit' is not allowed in the current state of Order.\")",
    );
    // The gate runs after the load and before the domain mutation.
    const submit = routes.slice(routes.indexOf("async def submit_order"));
    expect(submit.indexOf("DisallowedError")).toBeLessThan(submit.indexOf("found.submit()"));
  });

  it("emits the side-effect-free can_<op> companion returning { allowed }", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain("class CanResponse(BaseModel):");
    expect(routes).toContain("    allowed: bool");
    expect(routes).toContain(
      '@router.get("/{id}/can_submit", response_model=CanResponse, operation_id="can_submitOrder"',
    );
    expect(routes).toContain("async def can_submit_order(");
    expect(routes).toContain('return {"allowed": found.status == "Draft"}');
    // A predicate that calls an aggregate function renders the method.
    expect(routes).toContain('return {"allowed": found._can_cancel()}');
    // The can-query loads but does not mutate / save.
    const canBlock = routes.slice(routes.indexOf("async def can_submit_order"));
    expect(canBlock.slice(0, canBlock.indexOf("@router")).includes("repo.save")).toBe(false);
  });

  it("maps DisallowedError to a 409 Conflict problem response in the app", async () => {
    const files = await build();
    const problem = files.get("api/app/http/problem.py")!;
    expect(problem).toContain("DisallowedError");
    expect(problem).toContain("@app.exception_handler(DisallowedError)");
    expect(problem).toContain('return problem(request, 409, "Conflict", str(err))');
    const errors = files.get("api/app/domain/errors.py")!;
    expect(errors).toContain("class DisallowedError(Exception):");
  });
});
