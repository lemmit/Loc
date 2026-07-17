// loom.repository-find-deprecated (read-path-architecture.md, migration slice 6).
//
// A wire-shaped LIST `find` on a repository (returns `T[]` or `T paged`) is a
// bespoke list finder — deprecated in favour of `Repo.run(<Criterion>)` /
// `retrieval`.  A WARNING (existing `.ddd` keeps parsing).  A unique-key
// reconstitution find (single `T` / `T?`) is NOT a list query and stays clean.

import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const SYS = (finds: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order {
        ${finds}
      }
      criterion InRegion(rgn: string) of Order = region == rgn
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function warnCodes(finds: string): Promise<(string | number | undefined)[]> {
  const { diagnostics } = await parseString(SYS(finds));
  return (diagnostics as Diagnostic[]).filter((d) => d.severity === 2).map((d) => d.code);
}

describe("loom.repository-find-deprecated", () => {
  it("warns on a list find returning T[]", async () => {
    expect(await warnCodes("find byRegion(rgn: string): Order[]")).toContain(
      "loom.repository-find-deprecated",
    );
  });

  it("warns on a paged list find (T paged)", async () => {
    expect(await warnCodes("find recent(): Order paged")).toContain(
      "loom.repository-find-deprecated",
    );
  });

  it("does NOT warn on a unique-key reconstitution find (T? / T)", async () => {
    expect(await warnCodes("find bySlug(slug: string): Order?")).not.toContain(
      "loom.repository-find-deprecated",
    );
    expect(await warnCodes("find getOne(id: string): Order")).not.toContain(
      "loom.repository-find-deprecated",
    );
  });

  it("does not fire for the implicit auto-findAll (synthesized, not author-declared)", async () => {
    // A repo with NO declared finds still gets the enrich-synthesized paged
    // `all` — but that's an IR-level find, never an AST FindDecl, so this
    // AST-level gate can't (and shouldn't) see it.
    expect(await warnCodes("")).not.toContain("loom.repository-find-deprecated");
  });
});

// Regression gate: the scaffold macros must not GENERATE the deprecated
// construct — a scaffold should emit the criterion-driven read path
// (scaffoldPaged → a queryHandler over Repo.run(<Criterion>)), never mint a
// bespoke list `find`.  These fixtures declare NO author finds, so any
// `loom.repository-find-deprecated` warning could only come from the scaffold
// expansion itself.
describe("scaffolds do not generate the deprecated (list-find) construct", () => {
  async function warns(src: string): Promise<boolean> {
    const { diagnostics } = await parseString(src);
    return (diagnostics as Diagnostic[]).some((d) => d.code === "loom.repository-find-deprecated");
  }

  it("scaffoldPaged emits run(criterion), not a list find", async () => {
    const src = `
system S {
  subdomain Sales {
    context Orders with scaffoldPaged(of: InRegion) {
      aggregate Order { code: string  region: string }
      repository Orders for Order { }
      criterion InRegion(rgn: string) of Order = region == rgn
    }
  }
  api A with scaffoldPagedApi(of: InRegion) from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;
    expect(await warns(src)).toBe(false);
  });

  it("scaffoldHandlers + crudish mint no bespoke list finds", async () => {
    const src = `
system S {
  subdomain Sales {
    context Orders with scaffoldHandlers {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order { }
    }
  }
  api A with scaffoldApi(of: Sales)
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;
    expect(await warns(src)).toBe(false);
  });
});
