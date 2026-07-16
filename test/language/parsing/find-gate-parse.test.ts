// Parsing: a repository `find` accepts an optional `requires <expr>` gate
// BEFORE its `where` filter — `find f(): T requires <g> where <p>` (auth /
// default-deny, the read-side twin of the view gate).

import { describe, expect, it } from "vitest";
import type { FindDecl, Model } from "../../../src/language/generated/ast.js";
import { isRepository, isSubdomain } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/index.js";

/** The first repository find declared anywhere in the parsed model. */
function firstFind(model: Model): FindDecl {
  for (const sys of model.members) {
    for (const sm of sys.members) {
      if (!isSubdomain(sm)) continue;
      for (const c of sm.contexts) {
        for (const member of c.members) {
          if (isRepository(member) && member.finds.length > 0) return member.finds[0];
        }
      }
    }
  }
  throw new Error("no repository find in model");
}

const wrap = (findDecl: string) => `system Sys {
  user { id: string  role: string }
  subdomain S {
    context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket {
        ${findDecl}
      }
    }
  }
}`;

describe("find requires gate parsing", () => {
  it("parses a find with a `requires` gate before `where`", async () => {
    const { model, errors } = await parseString(
      wrap('find openOnes(): Ticket[] requires currentUser.role == "agent" where open == true'),
    );
    expect(errors).toEqual([]);
    const f = firstFind(model);
    expect(f.name).toBe("openOnes");
    expect(f.gate).toBeDefined();
    expect(f.filter).toBeDefined();
  });

  it("parses a `requires` gate with no `where` filter", async () => {
    const { model, errors } = await parseString(
      wrap('find anyOne(): Ticket? requires currentUser.role == "agent"'),
    );
    expect(errors).toEqual([]);
    const f = firstFind(model);
    expect(f.gate).toBeDefined();
    expect(f.filter).toBeUndefined();
  });

  it("an ungated find has no gate (back-compat)", async () => {
    const { model, errors } = await parseString(
      wrap("find openOnes(): Ticket[] where open == true"),
    );
    expect(errors).toEqual([]);
    const f = firstFind(model);
    expect(f.gate).toBeUndefined();
    expect(f.filter).toBeDefined();
  });
});
