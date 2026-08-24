// The two `MIKROORM_SUBSET` narrowings that were not what they said, drained.
//
// The descriptor (`src/ir/util/find-predicate-capability.ts`) refused two
// queryable shapes under `persistence: mikroorm`:
//
//  1. **A queryable scalar intrinsic** ("no scalar intrinsic at all").  REAL —
//     `whereToMikroFilter` had no arm, so `prefix-filter.ddd` was refused at
//     validation and skipped on the behavioural leg.  The FilterQuery
//     vocabulary has no function-call position, but a FilterQuery KEY may be a
//     `raw()` SQL fragment, so every `queryable` catalogue row now renders as
//     the SAME Postgres call the drizzle twin makes (`MIKRO_INTRINSIC_SQL`,
//     listed in `intrinsic-completeness.test.ts` — its absence there is what
//     let the narrowing sit unexamined while five other SQL renderers had arms).
//  2. **`currentUser.<field>`** ("no principal accessor on the MikroORM find
//     path").  The STATED reason was never true — `filterValue` has always
//     rendered `requireCurrentUser().<claim>`.  The real defect was one layer
//     out: three of the four repository variants did not declare the trailing
//     `currentUser: User` parameter the Hono route passes, so the GENERATED
//     project failed `tsc` with TS2554 — which no descriptor could have named.
//
// (2) is why this suite asserts the route CALL and the repository SIGNATURE
// together: each half is individually plausible and only their disagreement is
// the bug, and it lives in the generated project, where this repo's own `tsc`
// never looks.
//
// The one surviving narrowing is `this.<refColl>.contains(x)` — a correlated
// join subquery the adapter emits nowhere — pinned negatively at the bottom.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const system = (body: string, opts?: { auth?: boolean }) => `
  system S {
    ${opts?.auth === false ? "" : "user { id: guid  tenantId: string }"}
    subdomain D {
      context C {
        ${body}
      }
    }
    api A from D
    storage primary { type: postgres }
    resource s1 { for: C, kind: state, use: primary }
    deployable api {
      platform: node { persistence: mikroorm }
      contexts: [C]
      dataSources: [s1]
      serves: A
      port: 3000
      ${opts?.auth === false ? "" : "auth: required"}
    }
  }
`;

async function errors(src: string): Promise<string[]> {
  const { model, errors: parseErrors } = await parseString(src, { validate: true });
  if (parseErrors.length > 0) return parseErrors;
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code}: ${d.message}`);
}

async function file(src: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

// ---------------------------------------------------------------------------
// (1) Queryable scalar intrinsics
// ---------------------------------------------------------------------------

const PREFIX = system(`
        criterion UnderRoot of Doc = this.path.startsWith("root")
        aggregate Doc with crudish {
          path: string
          title: string
          filter UnderRoot
        }
        repository Docs for Doc {
          find under(prefix: string): Doc[] where this.path.startsWith(prefix)
        }
`);

describe("a queryable intrinsic lowers through a raw() fragment", () => {
  it("no longer refuses the shape at validation", async () => {
    expect(await errors(PREFIX)).toEqual([]);
  });

  it("`startsWith` in PREDICATE position is a standalone raw() entry", async () => {
    // The find's own `where` — the prefix is a PARAMETER, so it binds.
    const src = await file(PREFIX, "db/repositories/doc-repository.ts");
    expect(src).toContain('[raw("starts_with(path, ?)", [prefix])]: []');
    expect(src).toContain('import { raw } from "@mikro-orm/core";');
  });

  it("a `criterion` installed as a capability `filter` rides every read", async () => {
    // The criterion's literal argument binds too — it is a VALUE, not SQL text.
    const src = await file(PREFIX, "db/repositories/doc-repository.ts");
    expect(src).toContain('[raw("starts_with(path, ?)", ["root"])]: []');
    // …including the by-id read, which is where a filter silently not applying
    // is least visible.
    const byId = src.split("\n").find((l) => l.includes("em.findOne(DocRow, { $and: [{ id:"));
    expect(byId, "findById did not AND the capability filter").toBeDefined();
    expect(byId!).toContain("starts_with(path, ?)");
  });

  it("`starts_with`, never a LIKE pattern — a `%` in the VALUE is data", async () => {
    // `prefix-filter.ddd`'s own assertion 2: `under({prefix:"root%"})` must
    // match exactly the row whose path literally starts with `root%`, not all
    // five.  `LIKE ? || '%'` gets that wrong on a bound parameter, which is why
    // the spelling — not just the binding — is pinned.
    const src = await file(PREFIX, "db/repositories/doc-repository.ts");
    expect(src).not.toMatch(/\blike\b/i);
  });
});

// ---------------------------------------------------------------------------
// (2) `currentUser.<field>` in a find predicate
// ---------------------------------------------------------------------------

const PRINCIPAL = system(`
        aggregate Doc with crudish {
          owner: string
          title: string
        }
        repository Docs for Doc {
          find mine(): Doc[] where this.owner == currentUser.tenantId
        }
`);

describe("a principal-referencing find declares the parameter its caller passes", () => {
  it("no longer refuses the shape at validation", async () => {
    expect(await errors(PRINCIPAL)).toEqual([]);
  });

  it("the repository method takes `currentUser: User` and reads it", async () => {
    const src = await file(PRINCIPAL, "db/repositories/doc-repository.ts");
    expect(src).toContain("async mine(currentUser: User): Promise<Doc[]>");
    expect(src).toContain("em.find(DocRow, { owner: currentUser.tenantId })");
    // The `User` import goes with it — omitting it is TS2304 in the generated
    // project, the same class of miss as the `mask unless` one (M-T9.29 F3).
    expect(src).toContain('import type { User } from "../../auth/user-types";');
  });

  it("the route CALL and the method SIGNATURE agree on arity", async () => {
    // The half neither side can check alone, so it is asserted as an EQUALITY
    // rather than two independent `toContain`s: the route emits
    // `repo.mine(currentUser)` whenever `findUsesCurrentUser` is true, and a
    // method that declared no parameter was TS2554 "Expected 0 arguments, but
    // got 1" in the GENERATED project — green in this repo's own `tsc`, red
    // only in the `hono-build` tier.  Either side alone reads as correct.
    const files = await generateSystemFiles(PRINCIPAL);
    const pick = (suffix: string): string => {
      const key = [...files.keys()].find((k) => k.endsWith(suffix));
      expect(key, `${suffix} not emitted`).toBeDefined();
      return files.get(key!)!;
    };
    const callArgs = /await repo\.mine\(([^)]*)\)/.exec(pick("http/doc.routes.ts"))?.[1];
    const declParams = /async mine\(([^)]*)\)/.exec(pick("db/repositories/doc-repository.ts"))?.[1];
    expect(callArgs, "the route does not call repo.mine(...)").toBeDefined();
    expect(declParams, "the repository declares no mine(...)").toBeDefined();
    const count = (s: string): number => s.split(",").filter((x) => x.trim().length > 0).length;
    expect(
      count(declParams!),
      `route calls mine(${callArgs}) but the repository declares mine(${declParams})`,
    ).toBe(count(callArgs!));
  });

  it("a capability filter still uses the AMBIENT accessor, not the parameter", async () => {
    // Capability filters ride reads that have no principal parameter
    // (`findById`, the bulk id load), so they must not name one.
    const src = await file(
      system(`
        aggregate Doc with crudish, tenantOwned {
          title: string
        }
        aggregate Org with crudish { name: string  implements tenantRegistry }
        repository Docs for Doc { }
        repository Orgs for Org { }
      `).replace("subdomain D {", "tenancy by user.tenantId of Org\n    subdomain D {"),
      "db/repositories/doc-repository.ts",
    );
    expect(src).toContain("tenantId: requireCurrentUser().tenantId");
    expect(src).not.toContain("currentUser: User");
  });
});

// ---------------------------------------------------------------------------
// The one surviving narrowing
// ---------------------------------------------------------------------------

describe("reference-collection membership stays an honest refusal", () => {
  it("`this.<refColl>.contains(x)` is refused — no correlated join on this adapter", async () => {
    const src = system(`
        aggregate Tag with crudish { label: string }
        aggregate Doc with crudish {
          title: string
          tags: Tag id[]
        }
        repository Tags for Tag { }
        repository Docs for Doc {
          find tagged(t: Tag id): Doc[] where this.tags.contains(t)
        }
    `);
    const es = await errors(src);
    expect(
      es.some((e) => /loom\.find-predicate-unsupported/.test(e)),
      `expected the membership narrowing, got: ${es.join(" | ")}`,
    ).toBe(true);
    expect(es.some((e) => /contains\(x\)' membership/.test(e))).toBe(true);
  });
});
