// `crudish` — validates the macro mechanism supports compile-time
// inspection of the host aggregate's fields and statement-tree
// construction.  This was the open design question from the
// conversation: can a macro read `target.fields`, filter to user-
// declared writable fields, and emit operation bodies that
// reference them by name?  These tests confirm it can.

import { describe, expect, it } from "vitest";
import type { Aggregate, Model } from "../../src/language/generated/ast.js";
import {
  isAggregate,
  isAssignOrCallStmt,
  isOperation,
  isProperty,
} from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `system Demo { ${body} }`;

function findAggregate(model: Model, name: string): Aggregate {
  for (const sm of model.members ?? []) {
    if ((sm as any).$type !== "System") continue;
    for (const m of (sm as any).members ?? []) {
      if (m.$type !== "Module") continue;
      for (const ctx of m.contexts ?? []) {
        for (const cm of ctx.members ?? []) {
          if (isAggregate(cm) && cm.name === name) return cm;
        }
      }
    }
  }
  throw new Error(`aggregate ${name} not found`);
}

describe("crudish stdlib macro", () => {
  it("adds an update operation with one parameter per user field", async () => {
    const { model, errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Order with crudish {
            subject: string
            amount: decimal
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update");
    expect(update).toBeDefined();
    const paramNames = (update!.params ?? []).map((p) => p.name);
    expect(paramNames).toEqual(["subject", "amount"]);
  });

  it("update body assigns each parameter to the matching field", async () => {
    const { model } = await parseString(
      wrap(`
        module M { context C {
          aggregate Order with crudish {
            subject: string
            amount: decimal
          }
        }}
      `),
    );
    const agg = findAggregate(model, "Order");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    const stmts = (update.body ?? []).filter(isAssignOrCallStmt);
    expect(stmts.length).toBe(2);
    // Each statement is `<field> := <field>` — same name on both sides
    // resolves to the parameter on the RHS (param shadows field).
    expect(stmts[0]!.target.head).toBe("subject");
    expect(stmts[0]!.op).toBe(":=");
    expect(stmts[1]!.target.head).toBe("amount");
  });

  it("composes with auditable — audit fields are excluded from update surface", async () => {
    const { model, errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Order with auditable, crudish {
            subject: string
            amount: decimal
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    // Only the user-declared fields become update parameters.
    const paramNames = update.params.map((p) => p.name);
    expect(paramNames).toEqual(["subject", "amount"]);
    expect(paramNames).not.toContain("createdAt");
    expect(paramNames).not.toContain("updatedAt");
    expect(paramNames).not.toContain("createdBy");
    expect(paramNames).not.toContain("updatedBy");
    // ... but the audit fields themselves are on the aggregate.
    const fieldNames = (agg.members ?? []).filter(isProperty).map((p) => p.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(["subject", "amount", "createdAt", "updatedAt"]),
    );
  });

  it("works with empty aggregate — no params, empty body, still emits update", async () => {
    const { model } = await parseString(
      wrap(`
        module M { context C {
          aggregate Empty with crudish { }
        }}
      `),
    );
    const agg = findAggregate(model, "Empty");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    expect(update.params.length).toBe(0);
    expect(update.body.length).toBe(0);
  });
});

describe("crudish via IR lowering", () => {
  it("lowered AggregateIR contains the update operation", async () => {
    const { buildLoomModel } = await import("../_helpers/ir.js");
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Order with crudish {
            subject: string
            amount: decimal
          }
        }}
      }
    `);
    let found = false;
    for (const s of ir.systems) {
      for (const m of s.modules) {
        for (const c of m.contexts) {
          for (const a of c.aggregates) {
            if (a.name !== "Order") continue;
            found = true;
            const op = a.operations.find((o) => o.name === "update");
            expect(op).toBeDefined();
            expect(op!.params.map((p) => p.name)).toEqual(["subject", "amount"]);
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
