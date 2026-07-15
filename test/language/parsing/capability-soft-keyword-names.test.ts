// `filter` / `stamp` / `implements` are hard keywords only at aggregate /
// context member position (`FilterDecl` / `StampDecl` / `ImplementsDecl`).
// They are soft everywhere `LooseName` / `Property.name` are used, so a
// pre-existing field, parameter, or call-arg named `filter` / `stamp` /
// `implements` keeps parsing (previously they parsed as state fields and in
// expression position but NOT as aggregate fields / operation params — the
// asymmetry this guards against).

import { describe, expect, it } from "vitest";
import {
  type Aggregate,
  isAggregate,
  isProperty,
  isSubdomain,
  isSystem,
  type Model,
  type Property,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

function firstAggregate(model: Model): Aggregate {
  for (const sys of model.members) {
    if (!isSystem(sys)) continue;
    for (const sm of sys.members) {
      if (!isSubdomain(sm)) continue;
      for (const ctx of sm.contexts) {
        for (const member of ctx.members) if (isAggregate(member)) return member;
      }
    }
  }
  throw new Error("no aggregate found");
}

const props = (agg: Aggregate): Property[] => agg.members.filter(isProperty);

describe("filter / stamp / implements as ordinary identifiers", () => {
  it("parse as aggregate field names, operation param names, and call-arg names", async () => {
    const { doc, model } = await parseString(
      `
      system S {
        subdomain D { context C {
          aggregate Order {
            filter: string
            stamp: int
            implements: bool
            derived echo: string = this.render(filter: filter)
            operation touch(filter: string, stamp: int, implements: bool) {
              let x = filter
            }
          }
        }}
      }
      `,
      { validate: false },
    );

    expect(doc.parseResult.parserErrors).toEqual([]);

    const agg = firstAggregate(model);
    expect(
      props(agg)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["filter", "implements", "stamp", "version"]);
  });
});

describe("filter / stamp / implements as assignment targets (LValueIdent)", () => {
  it("parse as `:=` targets inside an operation body", async () => {
    const { doc } = await parseString(
      `
      system S {
        subdomain D { context C {
          aggregate Order {
            filter: string
            stamp: int
            operation touch(s: string, n: int) {
              filter := s
              stamp := n
            }
          }
        }}
      }
      `,
      { validate: false },
    );
    expect(doc.parseResult.parserErrors).toEqual([]);
  });
});
