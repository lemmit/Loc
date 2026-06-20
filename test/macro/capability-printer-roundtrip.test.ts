// Roundtrip tests for the structural printer's capability output.
//
// Every new node kind (FilterDecl, StampDecl, ImplementsDecl) and
// the BoundedContext `with` clause needs to print back to source
// that re-parses to a structurally-equivalent AST.  Without this,
// the planned unfold code action would produce source that drifts
// from the user's intent or fails to re-parse.

import { describe, expect, it } from "vitest";
import type { Model } from "../../src/language/generated/ast.js";
import { isAggregate, isBoundedContext } from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/index.js";
import { parseString } from "../_helpers/parse.js";

async function parse(source: string): Promise<Model> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`parse errors:\n${errors.join("\n")}`);
  return model;
}

function topLevelContext(
  model: Model,
): import("../../src/language/generated/ast.js").BoundedContext {
  for (const m of model.members ?? []) {
    if (isBoundedContext(m)) return m;
    if ((m as { $type?: string }).$type === "System") {
      for (const sm of ((m as { members?: unknown[] }).members ?? []) as unknown[]) {
        if (isBoundedContext(sm as never)) return sm as never;
        if ((sm as { $type?: string }).$type === "Subdomain") {
          for (const ctx of ((sm as { contexts?: unknown[] }).contexts ?? []) as unknown[]) {
            return ctx as never;
          }
        }
      }
    }
  }
  throw new Error("no context found");
}

/** Roundtrip helper: print the top-level context, re-parse the
 * printed source as a complete context, and return both ASTs for
 * structural comparison. */
async function roundtripContext(source: string): Promise<{
  before: import("../../src/language/generated/ast.js").BoundedContext;
  after: import("../../src/language/generated/ast.js").BoundedContext;
  printed: string;
}> {
  const model = await parse(source);
  const ctx = topLevelContext(model);
  const printed = printStructural(ctx);
  const reparsed = await parse(printed);
  return { before: ctx, after: topLevelContext(reparsed), printed };
}

describe("capability source surface roundtrips through structural printer", () => {
  it("`filter !this.isDeleted` at aggregate level", async () => {
    const { printed } = await roundtripContext(`
      context Sales {
        aggregate Order {
          subject: string
          isDeleted: bool
          filter !this.isDeleted
        }
        repository Orders for Order { }
      }
    `);
    expect(printed).toMatch(/filter !this\.isDeleted/);
  });

  it('`filter for "softDeletable" !this.isDeleted` at context level', async () => {
    const { printed } = await roundtripContext(`
      context Sales {
        filter for "softDeletable" !this.isDeleted
        aggregate Order {
          subject: string
          isDeleted: bool
          implements "softDeletable"
        }
        repository Orders for Order { }
      }
    `);
    expect(printed).toMatch(/filter for "softDeletable" !this\.isDeleted/);
    expect(printed).toMatch(/implements "softDeletable"/);
  });

  it("`stamp onCreate { ... }` block prints with its assignments", async () => {
    const { printed } = await roundtripContext(`
      context Sales {
        aggregate Order {
          subject: string
          createdAt: datetime
          stamp onCreate {
            createdAt := now()
          }
        }
        repository Orders for Order { }
      }
    `);
    expect(printed).toMatch(/stamp onCreate \{/);
    expect(printed).toMatch(/createdAt := now\(\)/);
  });

  it('`stamp for "auditable" onUpdate { ... }` at context level', async () => {
    const { printed } = await roundtripContext(`
      context Sales {
        stamp for "auditable" onUpdate {
          updatedAt := now()
        }
        aggregate Order {
          subject: string
          updatedAt: datetime
          implements "auditable"
        }
        repository Orders for Order { }
      }
    `);
    expect(printed).toMatch(/stamp for "auditable" onUpdate \{/);
  });

  it("`context Foo with auditable, softDeleteByDefault { ... }` prints the with clause", async () => {
    const { printed } = await roundtripContext(`
      context Sales with auditable, softDeleteByDefault {
        aggregate Order {
          subject: string
        }
        aggregate User { name: string }
        repository Orders for Order { }
        repository Users for User { }
      }
    `);
    expect(printed).toMatch(/context Sales with auditable, softDeleteByDefault \{/);
  });

  it("re-parsed AST has the same structural shape as the original", async () => {
    const { before, after } = await roundtripContext(`
      context Sales {
        filter for "softDeletable" !this.isDeleted
        stamp for "auditable" onCreate {
          createdAt := now()
        }
        aggregate Order {
          subject: string
          isDeleted: bool
          createdAt: datetime
          implements "softDeletable"
          implements "auditable"
        }
        repository Orders for Order { }
      }
    `);
    // Compare AST shapes by counting member types.
    const countByType = (
      m: import("../../src/language/generated/ast.js").BoundedContext,
    ): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const member of m.members ?? []) {
        const t = member.$type;
        out[t] = (out[t] ?? 0) + 1;
      }
      return out;
    };
    expect(countByType(after)).toEqual(countByType(before));
    // Aggregate-level capability counts also match.
    const orderBefore = (before.members ?? []).find(
      (m) => isAggregate(m) && (m as { name?: string }).name === "Order",
    ) as import("../../src/language/generated/ast.js").Aggregate;
    const orderAfter = (after.members ?? []).find(
      (m) => isAggregate(m) && (m as { name?: string }).name === "Order",
    ) as import("../../src/language/generated/ast.js").Aggregate;
    expect(countByType(orderAfter as never)).toEqual(countByType(orderBefore as never));
  });
});
