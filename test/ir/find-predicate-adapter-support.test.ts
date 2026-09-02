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
  it("admits a unary-NOT find predicate on MikroORM (wave 1 — `$not` / boolean-false entry)", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "node { persistence: mikroorm }",
        "active: bool",
        "find inactive(): Order[] where !this.active",
      ),
    );
    expect(errs).toEqual([]);
  });

  it("admits a bare-boolean-column find predicate on MikroORM (wave 1 — `{ col: true }`)", async () => {
    const errs = await findPredicateErrors(
      wrap(
        "node { persistence: mikroorm }",
        "active: bool",
        "find live(): Order[] where this.active",
      ),
    );
    expect(errs).toEqual([]);
  });

  // Flipped: this used to assert the MikroORM narrowing for a
  // `currentUser.<field>` predicate, on the descriptor's stated reason ("no
  // principal accessor on the find path").  That reason was never true —
  // `filterValue` has always rendered `requireCurrentUser().<claim>`.  The real
  // defect was one layer out: three of the four repository variants did not
  // declare the trailing `currentUser: User` parameter the Hono route passes,
  // so the shape failed with TS2554 in the GENERATED project — which no
  // predicate descriptor could have named.  All four declare it now, so the
  // shape is admitted, and the emitted signature/call-arity agreement is pinned
  // by `test/generator/typescript/mikroorm-predicate-subset.test.ts`.
  it("admits a `currentUser.<field>` find predicate on MikroORM", async () => {
    const errs = await findPredicateErrors(`
      system S {
        user { id: guid  name: string }
        subdomain M {
          context C {
            aggregate Order {
              ownerId: guid
            }
            repository Orders for Order {
              find mine(): Order[] where this.ownerId == currentUser.id
            }
          }
        }
        deployable api { platform: node { persistence: mikroorm }, contexts: [C], port: 3000, auth: required }
      }
    `);
    expect(errs).toEqual([]);
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
