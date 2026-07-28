// Write-side field authorization IR gates (`write(<expr>)` / `readonly when
// <expr>`, authorization.md §5, M-T3.2 item 6 — the write-side twin of
// `mask unless`, foundation slice):
//   - both spellings normalise onto FieldIR.writeGate (write(X)→X;
//     readonly-when(X)→!(X)), an ALLOWED-WHEN predicate;
//   - the predicate may reference only currentUser
//     (loom.field-write-gate-not-current-user);
//   - it is compile-gated until per-backend enforcement lands
//     (loom.field-write-gate-unsupported) — no unenforced write gate ships.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildWireSpec } from "../../src/system/wire-spec.js";
import { parseString } from "../_helpers/parse.js";

const sys = (fieldClause: string, plat = "node") => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal ${fieldClause}
      }
    }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: ${plat}  contexts: [C]  dataSources: [st]  port: 8080  auth: required }
}`;

async function diags(fieldClause: string, plat = "node"): Promise<string[]> {
  const { model } = await parseString(sys(fieldClause, plat), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

describe("field write gate — IR gates", () => {
  it("lowers write(X) onto FieldIR.writeGate verbatim", async () => {
    const { model } = await parseString(
      sys("write(currentUser.permissions.contains(permissions.setSalary))"),
      { validate: false },
    );
    const ir = enrichLoomModel(lowerModel(model));
    const salary = ir.systems[0]!.subdomains[0]!.contexts[0]!.aggregates[0]!.fields.find(
      (f) => f.name === "salary",
    )!;
    expect(salary.writeGate).toBeDefined();
    expect(salary.writeGate!.kind).toBe("method-call");
  });

  it("normalises `readonly when X` to `!(X)` on FieldIR.writeGate", async () => {
    const { model } = await parseString(sys('readonly when currentUser.role == "viewer"'), {
      validate: false,
    });
    const ir = enrichLoomModel(lowerModel(model));
    const salary = ir.systems[0]!.subdomains[0]!.contexts[0]!.aggregates[0]!.fields.find(
      (f) => f.name === "salary",
    )!;
    expect(salary.writeGate).toBeDefined();
    // readonly-when is the INVERSE — the allowed-when gate is a unary NOT.
    expect(salary.writeGate!.kind).toBe("unary");
    expect((salary.writeGate as { op: string }).op).toBe("!");
  });

  it.each([
    "node",
    "dotnet",
    "python",
    "java",
  ])("%s enforces the write gate — no unsupported diagnostic", async (plat) => {
    // node (Hono), dotnet (.NET Mediator command handlers), python (FastAPI
    // route handlers), and java (Spring @Service methods) emit the fail-closed
    // 403 in their create/op handlers, so a write-gated field hosted on any of
    // them is no longer a compile error.
    const codes = await diags(
      "write(currentUser.permissions.contains(permissions.setSalary))",
      plat,
    );
    expect(codes).not.toContain("loom.field-write-gate-unsupported");
  });

  it.each([
    "elixir",
  ])("%s still compile-gates an unenforced write gate (stacked follow-on)", async (plat) => {
    // The remaining backend doesn't enforce yet, so a parsed write gate
    // stays a fail-closed compile error there until its backend slice lands.
    const codes = await diags(
      "write(currentUser.permissions.contains(permissions.setSalary))",
      plat,
    );
    expect(codes).toContain("loom.field-write-gate-unsupported");
  });

  it("rejects a write-gate predicate that references the row", async () => {
    const codes = await diags('write(name == "x")');
    expect(codes).toContain("loom.field-write-gate-not-current-user");
  });

  it("rejects a `readonly when` predicate that references the row", async () => {
    const codes = await diags('readonly when name == "x"');
    expect(codes).toContain("loom.field-write-gate-not-current-user");
  });

  it("a field with no write gate emits neither diagnostic", async () => {
    const codes = await diags("");
    expect(codes).not.toContain("loom.field-write-gate-unsupported");
    expect(codes).not.toContain("loom.field-write-gate-not-current-user");
  });

  it("surfaces write-gated fields in the wire-spec fieldCapabilities", async () => {
    const { model } = await parseString(
      sys("write(currentUser.permissions.contains(permissions.setSalary))"),
      { validate: false },
    );
    const spec = buildWireSpec(enrichLoomModel(lowerModel(model)).systems[0]!);
    expect(spec.fieldCapabilities?.["P.salary"]).toEqual({ write: true });
  });

  it("omits fieldCapabilities entirely for a capability-free model (byte-identical)", async () => {
    const { model } = await parseString(sys(""), { validate: false });
    const spec = buildWireSpec(enrichLoomModel(lowerModel(model)).systems[0]!);
    expect(spec.fieldCapabilities).toBeUndefined();
  });
});
