// Phase 2 of "criterion everywhere — full filter targeting".
//
// A non-principal `filter <expr>` capability (the soft-delete case,
// `filter !this.isDeleted`) must be AND-ed into EVERY root-table read in
// the generated Drizzle repository — unlike EF Core's global
// HasQueryFilter, Drizzle has no automatic filter, so each read site
// (findById, findManyByIds, every find) carries the predicate explicitly.
// Half-applying it would be a soft-delete correctness hole.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Doc {
      subject: string
      isDeleted: bool
      filter !this.isDeleted
    }
    repository Docs for Doc {
      find bySubject(s: string): Doc[] where subject == s
    }
  }
`;

describe("typescript generator — capability filter (contextFilters)", () => {
  it("AND-s the non-principal filter into every root read site", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const repo = files.get("db/repositories/doc-repository.ts")!;
    expect(repo).toBeDefined();

    // findById: `eq(schema.docs.id, id)` AND-ed with `not(...)`.
    expect(repo).toMatch(
      /findById[\s\S]*?\.where\(and\(eq\(schema\.docs\.id, id\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // findManyByIds: `inArray(...)` AND-ed with the filter.
    expect(repo).toMatch(
      /findManyByIds[\s\S]*?\.where\(and\(inArray\(schema\.docs\.id, ids\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // The named find: its own `where` AND-ed with the filter.
    expect(repo).toMatch(
      /bySubject[\s\S]*?\.where\(and\(eq\(schema\.docs\.subject, s\), not\(eq\(schema\.docs\.isDeleted, true\)\)\)\)/,
    );
    // `not` must be imported from drizzle-orm (import narrower keeps it).
    expect(repo).toMatch(/import \{[^}]*\bnot\b[^}]*\} from "drizzle-orm";/);
  });

  it("reifies a filter that is exactly one named criterion (module-level fn)", async () => {
    // reified-criteria.md, the anonymous-`filter` row: `filter NotDeleted`
    // calls the criterion's module-level predicate fn instead of re-inlining
    // its body — deduped with find/retrieval consumers of the same criterion.
    const { model, errors } = await parseString(`
      context Sales {
        criterion NotDeleted of Doc = !this.isDeleted
        aggregate Doc {
          subject: string
          isDeleted: bool
          filter NotDeleted
        }
        repository Docs for Doc {
          find bySubject(s: string): Doc[] where subject == s
        }
      }
    `);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/doc-repository.ts")!;
    // One module-level predicate fn, body = the lowered criterion.
    expect(repo).toContain(
      "const notDeletedCriterion = () => not(eq(schema.docs.isDeleted, true));",
    );
    // Every root read calls the fn (no re-inlined body at the use sites).
    expect(repo).toMatch(
      /findById[\s\S]*?\.where\(and\(eq\(schema\.docs\.id, id\), notDeletedCriterion\(\)\)\)/,
    );
    expect(repo).toMatch(
      /bySubject[\s\S]*?\.where\(and\(eq\(schema\.docs\.subject, s\), notDeletedCriterion\(\)\)\)/,
    );
    // The criterion body appears exactly once (the fn) — use sites call it.
    expect(repo.match(/not\(eq\(schema\.docs\.isDeleted, true\)\)/g)).toHaveLength(1);
  });

  it("emits no capability predicate when the aggregate has no filter", async () => {
    const { model } = await parseString(`
      context Sales {
        aggregate Plain { subject: string }
        repository Plains for Plain {
          find bySubject(s: string): Plain[] where subject == s
        }
      }
    `);
    const files = generateHono(model);
    const repo = files.get("db/repositories/plain-repository.ts")!;
    // Plain findById keeps the bare id predicate (no and-wrapping).
    expect(repo).toMatch(/findById[\s\S]*?\.where\(eq\(schema\.plains\.id, id\)\)/);
  });
});
