// M-T3.4a — the vanilla (Ecto/Phoenix) backend routes its hardcoded structural
// 409 conflicts through the `httpStatus` error→status mapper, so they become
// user-overridable and the runtime arm + OpenAPI declaration can no longer
// drift.  Four structural conflicts default to 409:
//   * UniquenessConflict  — a `unique (...)` breach (PG 23505 / :unique)
//   * ConcurrencyConflict — a `versioned` stale write (Ecto.StaleEntryError)
//   * ReferencedInUse     — an FK-restrict destroy (PG 23503 / :foreign_key)
// With no override every value is 409 (byte-identical); a `httpStatus <Conflict>
// <Code>` clause retargets BOTH the runtime responder and the OpenAPI response.
//
// The ReferencedInUse arm is also an approved drift fix: an FK-restrict delete
// used to raise an unhandled `Ecto.ConstraintError` → 500 while the spec already
// declared 409.  The controller now rescues that ConstraintError and serves the
// resolved status.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function file(files: Map<string, string>, needle: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(needle) || k.includes(needle));
  if (!key) throw new Error(`no file matching ${needle}`);
  return files.get(key)!;
}

const src = (override: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Category {
        name: string
        destroy { }
      }
      aggregate Order with versioned {
        code: string
        category: Category id
        unique (code)
        operation update(code: string) { code := code }
      }
    }
  }
  api OrdersApi from Sales {${override}
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}`;

describe("vanilla structural-conflict status (M-T3.4a)", () => {
  it("DEFAULT — every structural conflict resolves to 409 (runtime + OpenAPI)", async () => {
    const files = await generateSystemFiles(src(""));
    const pd = file(files, "/problem_details.ex");
    // unique -> 409 Conflict
    expect(pd).toMatch(/problem_response\(\s*conn,\s*409,\s*"Conflict"/);
    // concurrency (versioned stale write) -> 409 Conflict
    expect(pd).toContain("send_resp(409, body)");

    // FK-restrict destroy — the controller rescues Ecto.ConstraintError and
    // serves the resolved 409 (previously unhandled → 500).
    const catCtrl = file(files, "/category_controller.ex");
    expect(catCtrl).toContain("fk_error in Ecto.ConstraintError");
    expect(catCtrl).toContain("if fk_error.type == :foreign_key do");
    expect(catCtrl).toMatch(
      /problem_response\(\s*conn,\s*409,\s*"Conflict",\s*"Category is still referenced/,
    );
    expect(catCtrl).toContain("reraise(fk_error, __STACKTRACE__)");

    // OpenAPI destroy declares 409 for the FK-restrict conflict.
    const spec = file(files, "_spec.ex");
    const destroy = spec.slice(spec.indexOf('"Destroy Category"'));
    expect(destroy.slice(0, 900)).toContain("409 =>");
  });

  it("OVERRIDE — httpStatus retargets both the runtime arm and the OpenAPI response", async () => {
    const files = await generateSystemFiles(
      src(
        "\n    httpStatus UniquenessConflict -> 422" +
          "\n    httpStatus ConcurrencyConflict -> 423" +
          "\n    httpStatus ReferencedInUse -> 412",
      ),
    );
    const pd = file(files, "/problem_details.ex");
    // unique -> 422 with the matching title
    expect(pd).toMatch(/problem_response\(\s*conn,\s*422,\s*"Unprocessable Entity"/);
    // concurrency -> 423 (title tracks the status too)
    expect(pd).toContain("send_resp(423, body)");
    expect(pd).toContain("status: 423,");

    // FK-restrict -> 412
    const catCtrl = file(files, "/category_controller.ex");
    expect(catCtrl).toMatch(/problem_response\(\s*conn,\s*412,/);

    // OpenAPI destroy now declares 412 (moves in lockstep with the runtime arm).
    const spec = file(files, "_spec.ex");
    const destroy = spec.slice(spec.indexOf('"Destroy Category"'));
    expect(destroy.slice(0, 1100)).toContain("412 =>");
    expect(destroy.slice(0, 1100)).not.toContain("409 =>");
  });
});
