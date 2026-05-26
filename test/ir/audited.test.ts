import { AstUtils } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import {
  type Aggregate,
  isOperation,
  type Model,
  type Operation,
} from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";

// ---------------------------------------------------------------------------
// `audited` operation modifier — per-invocation audit records instrumented
// on the TypeScript/Hono backend.  Covers the grammar flag, IR lowering, the
// validator warning on private operations, code emission + emission toggle,
// and no-crash safety on the non-TS backends.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function parseModel(
  src: string,
): Promise<{ model: Model; errors: string[]; warnings: string[] }> {
  const doc = await parse(src, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

// A Cart with an audited `cancel` op + a plain `touch` op, on a hono
// deployable.  `extra` is appended into the aggregate body verbatim.
const SYSTEM = (extra = "", platform = "hono", targets = "") => `
system S {
  module M {
    context C {
      aggregate Cart ids guid {
        label: string
        derived display: string = label
        status: int
        operation cancel(reason: int) audited {
          status := reason
        }
        operation touch(n: int) {
          status := n
        }
${extra}
      }
      repository Carts for Cart {
        find byLabel(label: string): Cart? where this.label == label
      }
    }
  }
  deployable api { platform: ${platform}, ${targets || "modules: M,"} port: 3000 }
}
`;

describe("audited — grammar", () => {
  it("sets Operation.audited on an audited operation", async () => {
    const { model, errors } = await parseModel(SYSTEM());
    expect(errors).toEqual([]);
    expect(findOperation(model, "Cart", "cancel").audited).toBe(true);
    expect(findOperation(model, "Cart", "touch").audited).toBeFalsy();
  });

  it("coexists with `extern`", async () => {
    const src = SYSTEM().replace(
      "operation cancel(reason: int) audited {\n          status := reason\n        }",
      "operation cancel(reason: int) extern audited {\n          precondition reason > 0\n        }",
    );
    const { model, errors } = await parseModel(src);
    expect(errors).toEqual([]);
    const op = findOperation(model, "Cart", "cancel");
    expect(op.extern).toBe(true);
    expect(op.audited).toBe(true);
  });

  it("parses on a private operation", async () => {
    const src = SYSTEM("        private operation recalc() audited { status := 0 }\n");
    const { model, errors } = await parseModel(src);
    expect(errors).toEqual([]);
    const op = findOperation(model, "Cart", "recalc");
    expect(op.private).toBe(true);
    expect(op.audited).toBe(true);
  });
});

describe("audited — validation", () => {
  it("warns when `audited` is on a private operation", async () => {
    const src = SYSTEM("        private operation recalc() audited { status := 0 }\n");
    const { warnings } = await parseModel(src);
    expect(
      warnings.some((w) => /'audited' has no effect on private operation 'recalc'/.test(w)),
    ).toBe(true);
  });

  it("does not warn for a public audited operation", async () => {
    const { warnings } = await parseModel(SYSTEM());
    expect(warnings.some((w) => /'audited' has no effect/.test(w))).toBe(false);
  });
});

describe("audited — IR lowering", () => {
  it("flags the audited operation and leaves others unflagged", async () => {
    const { model, errors } = await parseModel(SYSTEM());
    expect(errors).toEqual([]);
    const cart = lowerModel(model).systems[0]!.modules[0]!.contexts[0]!.aggregates[0]!;
    expect(cart.operations.find((o) => o.name === "cancel")?.audited).toBe(true);
    expect(cart.operations.find((o) => o.name === "touch")?.audited).toBe(false);
  });
});

describe("audited — TypeScript emission", () => {
  it("adds the audit_records table and writes a row transactionally with the save", async () => {
    const { model } = await parseModel(SYSTEM());
    const files = generateSystems(model).files;

    // DB-only: the audit log is a Drizzle table, not an in-memory SDK file.
    expect(files.has("api/domain/audit.ts")).toBe(false);
    const schema = files.get("api/db/schema.ts")!;
    expect(schema).toContain('export const auditRecords = pgTable("audit_records"');
    expect(schema).toContain('jsonb("before")');

    const routes = files.get("api/http/cart.routes.ts")!;
    // The save and the audit insert share one transaction (atomic).
    expect(routes).toContain("await db.transaction(async (tx) => {");
    expect(routes).toContain("const repoTx = new CartRepository(tx, events);");
    expect(routes).toContain("await repoTx.save(aggregate);");
    expect(routes).toContain("await tx.insert(schema.auditRecords).values({");
    expect(routes).toContain('operationId: "cancelCart",');
    expect(routes).toContain('action: "cancel",');
    expect(routes).toContain('targetType: "Cart",');
    expect(routes).toContain("targetId: id,");
    expect(routes).toContain("const before = repoTx.toWire(aggregate);");
    expect(routes).toContain("const after = repoTx.toWire(aggregate);");
  });

  it("instruments only the audited operation, not the plain one", async () => {
    const { model } = await parseModel(SYSTEM());
    const routes = generateSystems(model).files.get("api/http/cart.routes.ts")!;
    // Exactly one audit insert site (cancel); touch is uninstrumented.
    expect(routes.match(/tx\.insert\(schema\.auditRecords\)/g)).toHaveLength(1);
  });

  it("emits no audit table or transaction when no operation is audited (toggle off)", async () => {
    const src = SYSTEM().replace(
      "operation cancel(reason: int) audited {",
      "operation cancel(reason: int) {",
    );
    const { model } = await parseModel(src);
    const files = generateSystems(model).files;
    expect(files.get("api/db/schema.ts")).not.toContain("auditRecords");
    expect(files.get("api/http/cart.routes.ts")).not.toContain("tx.insert(schema.auditRecords)");
  });
});

describe("audited — other-backend no-crash safety", () => {
  it("generates a dotnet deployable for an audited model with no audit code", async () => {
    const { model, errors } = await parseModel(SYSTEM("", "dotnet"));
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    // No TS audit artefacts leak into the .NET output.
    expect([...files.keys()].some((p) => p.endsWith("/domain/audit.ts"))).toBe(false);
    expect([...files.keys()].some((p) => /auditRecords/.test(files.get(p)!))).toBe(false);
  });
});

function findOperation(model: Model, agg: string, name: string): Operation {
  for (const node of AstUtils.streamAst(model)) {
    if (
      isOperation(node) &&
      node.name === name &&
      AstUtils.getContainerOfType(node, (n): n is Aggregate => n.$type === "Aggregate")?.name ===
        agg
    ) {
      return node;
    }
  }
  throw new Error(`operation ${agg}.${name} not found`);
}
