// Bucket V / P0 — per-persistence-adapter find-predicate capability gate.
//
// EF Core lowers the full queryable subset; the narrower relational adapters
// (Dapper, MikroORM) reject the shapes they can't lower to SQL.  Without this
// gate the predicate throws at generate time (MikroORM `whereToMikroFilter`,
// Dapper `whereToSql`) or emits a runtime-broken stub.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function findPredicateErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.find-predicate-unsupported")
    .map((d) => d.message);
}

const wrap = (persistence: string, aggBody: string, repoBody: string) => `
  system S {
    subdomain M {
      context C {
        aggregate Order {
          ${aggBody}
        }
        repository Orders for Order {
          ${repoBody}
        }
      }
    }
    deployable api { platform: ${persistence}, contexts: [C], port: 3000 }
  }
`;

describe("find-predicate adapter support (P0)", () => {
  it("rejects a unary-NOT find predicate on MikroORM (whereToMikroFilter is comparisons + &&/|| only)", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "node { persistence: mikroorm }",
        "active: bool",
        "find inactive(): Order[] where !this.active",
      ),
    );
    expect(errs.some((m) => /persistence: mikroorm/.test(m) && /unary/.test(m))).toBe(true);
  });

  it("rejects a bare-boolean-column find predicate on MikroORM", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "node { persistence: mikroorm }",
        "active: bool",
        "find live(): Order[] where this.active",
      ),
    );
    expect(errs.some((m) => /persistence: mikroorm/.test(m))).toBe(true);
  });

  it("admits the same MikroORM predicate when it is a plain comparison", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "node { persistence: mikroorm }",
        "active: bool",
        "find live(): Order[] where this.active == true",
      ),
    );
    expect(errs).toEqual([]);
  });

  it("admits a unary-NOT find predicate on EF Core (the full-subset baseline)", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "dotnet { persistence: efcore }",
        "active: bool",
        "find inactive(): Order[] where !this.active",
      ),
    );
    expect(errs).toEqual([]);
  });

  it("admits a unary-NOT find predicate on the default (drizzle) node adapter", async () => {
    const errs = await findPredicateErrors(
      wrap("node", "active: bool", "find inactive(): Order[] where !this.active"),
    );
    expect(errs).toEqual([]);
  });
});
