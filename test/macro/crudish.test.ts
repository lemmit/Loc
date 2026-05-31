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
  isCreate,
  isDestroy,
  isOperation,
  isProperty,
} from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `system Demo { ${body} }`;

function findAggregate(model: Model, name: string): Aggregate {
  for (const sm of model.members ?? []) {
    if ((sm as any).$type !== "System") continue;
    for (const m of (sm as any).members ?? []) {
      if (m.$type !== "Subdomain") continue;
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
        subdomain M { context C {
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
        subdomain M { context C {
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
        subdomain M { context C {
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

  it.each([
    ["immutable", "string"],
    ["managed", "datetime"],
    ["internal", "bool"],
  ])("excludes user-declared fields marked %s from update params", async (modifier, ty) => {
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Order with crudish {
            subject: string
            ${modifier === "managed" ? `frozenAt` : modifier === "internal" ? `flag` : `slug`}: ${ty} ${modifier}
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    const paramNames = update.params.map((p) => p.name);
    // The restrictively-accessed field is filtered out of the update
    // operation's params even though it was declared by the user (no
    // origin tag).  The access filter in `writableUpdateFields`
    // catches it independently.
    expect(paramNames).toEqual(["subject"]);
  });

  it("excludes user-declared `token` field from update params", async () => {
    // `token` separately so we satisfy the non-nullable validator
    // (token forbids `T?`).  Tests the same access-filter path as
    // the parametrized test above.
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Order with crudish {
            subject: string
            rev: int token
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    expect(update.params.map((p) => p.name)).toEqual(["subject"]);
  });

  it("INCLUDES user-declared `secret` field in update params (write-only)", async () => {
    // Regression bait: the easiest mistake when wiring the access
    // filter is "exclude everything non-default."  `secret` is
    // write-only — secrets go INTO update inputs (password changes,
    // API key rotation, etc.) but never come back out in reads.
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Account with crudish {
            handle: string
            passwordHash: string secret
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Account");
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    expect(update.params.map((p) => p.name)).toEqual(["handle", "passwordHash"]);
  });

  it("works with empty aggregate — no params, empty body, still emits update", async () => {
    const { model } = await parseString(
      wrap(`
        subdomain M { context C {
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

describe("crudish create/destroy lifecycle", () => {
  it("emits a canonical create whose params include immutable fields", async () => {
    // `slug` is immutable: excluded from `update` (above) but settable
    // at creation, so it belongs on the create surface.
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Order with crudish {
            subject: string
            slug: string immutable
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const creates = (agg.members ?? []).filter(isCreate);
    expect(creates.length).toBe(1);
    // Canonical = unnamed.
    expect(creates[0]!.name).toBeUndefined();
    expect(creates[0]!.params.map((p) => p.name)).toEqual(["subject", "slug"]);
    // The update operation omits the immutable field — the surfaces differ.
    const update = (agg.members ?? []).filter(isOperation).find((o) => o.name === "update")!;
    expect(update.params.map((p) => p.name)).toEqual(["subject"]);
  });

  it("emits a canonical (unnamed, empty-body) destroy", async () => {
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Order with crudish { subject: string }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const destroys = (agg.members ?? []).filter(isDestroy);
    expect(destroys.length).toBe(1);
    expect(destroys[0]!.name).toBeUndefined();
    expect(destroys[0]!.params.length).toBe(0);
    expect(destroys[0]!.body.length).toBe(0);
  });

  it("updateOnly: true suppresses create + destroy (softDeletable composition)", async () => {
    const { model, errors } = await parseString(
      wrap(`
        subdomain M { context C {
          aggregate Order with crudish(updateOnly: true) { subject: string }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    expect((agg.members ?? []).filter(isOperation).find((o) => o.name === "update")).toBeDefined();
    expect((agg.members ?? []).filter(isCreate).length).toBe(0);
    expect((agg.members ?? []).filter(isDestroy).length).toBe(0);
  });
});

describe("crudish via IR lowering", () => {
  it("lowered AggregateIR contains the update operation", async () => {
    const { buildLoomModel } = await import("../_helpers/ir.js");
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Order with crudish {
            subject: string
            amount: decimal
          }
        }}
      }
    `);
    let found = false;
    for (const s of ir.systems) {
      for (const m of s.subdomains) {
        for (const c of m.contexts) {
          for (const a of c.aggregates) {
            if (a.name !== "Order") continue;
            found = true;
            const op = a.operations.find((o) => o.name === "update");
            expect(op).toBeDefined();
            expect(op!.params.map((p) => p.name)).toEqual(["subject", "amount"]);
            // Lifecycle actions land in their own arrays, surfaced as the
            // canonical create/destroy.
            expect(a.canonicalCreate).not.toBeNull();
            expect(a.canonicalCreate!.kind).toBe("create");
            expect(a.canonicalCreate!.canonical).toBe(true);
            expect(a.canonicalCreate!.params.map((p) => p.name)).toEqual(["subject", "amount"]);
            expect(a.canonicalDestroy).not.toBeNull();
            expect(a.canonicalDestroy!.kind).toBe("destroy");
            expect(a.canonicalDestroy!.canonical).toBe(true);
            // `operations` stays mutate-only — create/destroy are NOT folded in.
            expect(a.operations.some((o) => o.kind === "create" || o.kind === "destroy")).toBe(
              false,
            );
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});
