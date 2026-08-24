// A comparison whose COLUMN sits on the right — `where 100 < this.qty`.
//
// The queryable gate (`firstNonQueryableNode`) walks a comparison's operands
// symmetrically, so this shape validates clean on every adapter.  The two
// TypeScript SQL adapters could not express it, each in its own way:
//
//   - **drizzle** pulled the column off EITHER operand but never mirrored the
//     operator, so `100 < this.qty` emitted `lt(qty, 100)` — the exact
//     opposite read, silently, with a 200.
//   - **mikroorm** required the column on the LEFT and threw, which the find
//     emitter turned into `throw new Error("mikroorm v1: this find's predicate
//     is not yet supported")` — a 500 on every call of a model the validator
//     had accepted, and a narrowing `MIKROORM_SUBSET` never declared.
//
// Both now go through one normalizer (`src/ir/util/comparison-operands.ts`),
// so the two spellings of one predicate are asserted as EQUAL output rather
// than as two independent `toContain`s: an inverted operator is individually
// plausible in either half, and only the disagreement between the twins is
// the bug.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { MIRRORED_COMPARE_OP, orientComparison } from "../../../src/ir/util/comparison-operands.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const system = (body: string, persistence: string) => `
  system S {
    user { id: guid  tenantId: string }
    subdomain D {
      context C {
        ${body}
      }
    }
    api A from D
    storage primary { type: postgres }
    resource s1 { for: C, kind: state, use: primary }
    deployable api {
      platform: node { persistence: ${persistence} }
      contexts: [C]
      dataSources: [s1]
      serves: A
      port: 3000
      auth: required
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

async function repo(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith("db/repositories/item-repository.ts"));
  expect(key, "item-repository.ts not emitted").toBeDefined();
  return files.get(key!)!;
}

/** The single emitted line for `find <name>` — the read's predicate. */
function readLine(src: string, find: string): string {
  const idx = src.split("\n").findIndex((l) => l.includes(`async ${find}(`));
  expect(idx, `find ${find} not emitted`).toBeGreaterThan(-1);
  const line = src
    .split("\n")
    .slice(idx + 1, idx + 6)
    .find((l) => l.includes("this.db.select()") || l.includes("em.find("));
  expect(line, `no read emitted for ${find}`).toBeDefined();
  return line!.trim();
}

// ---------------------------------------------------------------------------
// The normalizer itself
// ---------------------------------------------------------------------------

describe("orientComparison", () => {
  it("mirrors the operator when the column came from the right", () => {
    const isCol = (s: string) => s === "col";
    expect(orientComparison("<", "100", "col", isCol)).toEqual({
      op: ">",
      column: "col",
      value: "100",
      commuted: true,
    });
    expect(orientComparison("<=", "100", "col", isCol)?.op).toBe(">=");
    expect(orientComparison(">", "100", "col", isCol)?.op).toBe("<");
    expect(orientComparison(">=", "100", "col", isCol)?.op).toBe("<=");
    // Symmetric operators keep their spelling.
    expect(orientComparison("==", "100", "col", isCol)?.op).toBe("==");
    expect(orientComparison("!=", "100", "col", isCol)?.op).toBe("!=");
  });

  it("leaves a column-on-left comparison untouched", () => {
    const isCol = (s: string) => s === "col";
    expect(orientComparison("<", "col", "100", isCol)).toEqual({
      op: "<",
      column: "col",
      value: "100",
      commuted: false,
    });
  });

  it("returns null when neither operand is a column", () => {
    expect(orientComparison("<", "1", "2", () => false)).toBeNull();
  });

  it("mirroring is an involution over every comparison operator", () => {
    for (const [op, mirrored] of Object.entries(MIRRORED_COMPARE_OP)) {
      expect(MIRRORED_COMPARE_OP[mirrored]).toBe(op);
    }
  });
});

// ---------------------------------------------------------------------------
// drizzle — the default node adapter
// ---------------------------------------------------------------------------

const FINDS = `
        aggregate Item with crudish {
          qty: int
        }
        repository Items for Item {
          find ltRight(): Item[] where 100 < this.qty
          find ltLeft(): Item[] where this.qty > 100
          find lteRight(): Item[] where 100 <= this.qty
          find lteLeft(): Item[] where this.qty >= 100
          find gtRight(): Item[] where 100 > this.qty
          find gtLeft(): Item[] where this.qty < 100
          find gteRight(): Item[] where 100 >= this.qty
          find gteLeft(): Item[] where this.qty <= 100
          find eqRight(): Item[] where 100 == this.qty
          find eqLeft(): Item[] where this.qty == 100
        }
`;

const TWINS = [
  ["ltRight", "ltLeft"],
  ["lteRight", "lteLeft"],
  ["gtRight", "gtLeft"],
  ["gteRight", "gteLeft"],
  ["eqRight", "eqLeft"],
] as const;

describe("drizzle: a value-on-left comparison commutes with its operator", () => {
  it("validates — the queryable gate admits the shape", async () => {
    expect(await errors(system(FINDS, "drizzle"))).toEqual([]);
  });

  it("each value-on-left find reads exactly what its column-on-left twin reads", async () => {
    const src = await repo(system(FINDS, "drizzle"));
    for (const [right, left] of TWINS) {
      const rightLine = readLine(src, right).replace(right, "<find>");
      const leftLine = readLine(src, left).replace(left, "<find>");
      expect(rightLine, `${right} and ${left} are the same predicate`).toBe(leftLine);
    }
  });

  it("`100 < this.qty` is gt, not lt — the inversion, spelled out", async () => {
    const src = await repo(system(FINDS, "drizzle"));
    expect(readLine(src, "ltRight")).toContain("gt(schema.items.qty, 100)");
    expect(readLine(src, "ltRight")).not.toContain("lt(schema.items.qty, 100)");
    expect(readLine(src, "lteRight")).toContain("gte(schema.items.qty, 100)");
    expect(readLine(src, "gtRight")).toContain("lt(schema.items.qty, 100)");
    expect(readLine(src, "gteRight")).toContain("lte(schema.items.qty, 100)");
  });
});

// Three more of the positions `lowerToDrizzle` reaches: a capability `filter`
// (which rides EVERY read, including findById), a `criterion` body, and a
// `retrieval` where.  A filter inverted here fails OPEN — it admits exactly
// the rows it was written to exclude.  The fourth caller — the write-scope
// predicate (`projection-query-routes-builder.ts`) — inherits the commute by
// construction, since the normalizer lives inside `lowerToDrizzle` itself; it
// is not separately exercised here.
const POSITIONS = `
        criterion Cheap of Item = 10 > this.qty
        aggregate Item with crudish {
          qty: int
          filter 0 < this.qty
        }
        retrieval Bulk() of Item {
          where: 500 <= this.qty
        }
        repository Items for Item {
          find cheap(): Item[] where Cheap()
        }
`;

describe("drizzle: the other lowering positions commute", () => {
  it("validates", async () => {
    expect(await errors(system(POSITIONS, "drizzle"))).toEqual([]);
  });

  it("a capability `filter` written value-on-left excludes, not includes", async () => {
    const src = await repo(system(POSITIONS, "drizzle"));
    // `filter 0 < this.qty` keeps rows whose qty is ABOVE zero.
    expect(src).toContain("gt(schema.items.qty, 0)");
    expect(src).not.toContain("lt(schema.items.qty, 0)");
    // …and it rides the by-id read, where a wrong filter is least visible.
    const byId = src.split("\n").find((l) => l.includes("async findById("));
    expect(byId, "findById not emitted").toBeDefined();
  });

  it("a `criterion` body written value-on-left commutes", async () => {
    const src = await repo(system(POSITIONS, "drizzle"));
    // The criterion is reified into its own helper, which the find AND-s in;
    // `10 > this.qty` → qty < 10 inside that helper.
    expect(readLine(src, "cheap")).toContain("cheapCriterion()");
    const helper = src.split("\n").find((l) => l.includes("lt(schema.items.qty, 10)"));
    expect(helper, "the criterion helper did not commute `10 > this.qty`").toBeDefined();
    expect(src).not.toContain("gt(schema.items.qty, 10)");
  });

  it("a `retrieval` where written value-on-left commutes", async () => {
    const src = await repo(system(POSITIONS, "drizzle"));
    // `500 <= this.qty` → qty >= 500.
    expect(src).toContain("gte(schema.items.qty, 500)");
    expect(src).not.toContain("lte(schema.items.qty, 500)");
  });
});

// ---------------------------------------------------------------------------
// mikroorm — the twin the capability descriptor promised could not happen
// ---------------------------------------------------------------------------

describe("mikroorm: a value-on-left comparison is a real FilterQuery, not a stub", () => {
  it("validates — `MIKROORM_SUBSET` admits the shape", async () => {
    expect(await errors(system(FINDS, "mikroorm"))).toEqual([]);
  });

  it("no find lowers to the `not yet supported` runtime-throwing stub", async () => {
    const src = await repo(system(FINDS, "mikroorm"));
    expect(src).not.toContain("not yet supported");
  });

  it("each value-on-left find reads exactly what its column-on-left twin reads", async () => {
    const src = await repo(system(FINDS, "mikroorm"));
    for (const [right, left] of TWINS) {
      const rightLine = readLine(src, right).replace(right, "<find>");
      const leftLine = readLine(src, left).replace(left, "<find>");
      expect(rightLine, `${right} and ${left} are the same predicate`).toBe(leftLine);
    }
  });

  it("`100 < this.qty` is $gt, not $lt", async () => {
    const src = await repo(system(FINDS, "mikroorm"));
    expect(readLine(src, "ltRight")).toContain("{ qty: { $gt: 100 } }");
  });
});
