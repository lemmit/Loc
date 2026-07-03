// `unique (...)` uniqueness invariant (uniqueness-and-indexes.md, D-UNIQUE-DOMAIN).
//
// Surface coverage: a first-class `unique (a, b)` aggregate member parses,
// populates its `columns`, coexists with the other domain rules, and accepts
// soft-keyword field names (e.g. `title`) via the shared `LooseName` name set.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  type Aggregate,
  isAggregate,
  type Model,
  type Unique,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

function firstAggregate(model: Model): Aggregate {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node)) return node;
  }
  throw new Error("no aggregate found");
}

const wrap = (agg: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        ${agg}
        repository Customers for Customer { }
      }
    }
  }
`;

describe("unique (...) — parsing", () => {
  it("parses a single-column unique key", async () => {
    const { model, errors } = await parseString(
      wrap(`aggregate Customer { email: string  name: string  unique (email) }`),
    );
    expect(errors).toEqual([]);
    const agg = firstAggregate(model);
    const unique = agg.members.find((m) => m.$type === "Unique") as Unique;
    expect(unique).toBeDefined();
    expect(unique.columns).toEqual(["email"]);
  });

  it("parses a composite (scoped) unique key", async () => {
    const { model, errors } = await parseString(
      wrap(`aggregate Customer { tenantId: string  email: string  unique (tenantId, email) }`),
    );
    expect(errors).toEqual([]);
    const unique = firstAggregate(model).members.find((m) => m.$type === "Unique") as Unique;
    expect(unique.columns).toEqual(["tenantId", "email"]);
  });

  it("accepts a soft-keyword column name (e.g. `title`)", async () => {
    const { model, errors } = await parseString(
      wrap(`aggregate Customer { title: string  unique (title) }`),
    );
    expect(errors).toEqual([]);
    const unique = firstAggregate(model).members.find((m) => m.$type === "Unique") as Unique;
    expect(unique.columns).toEqual(["title"]);
  });

  it("coexists with invariants and derived fields", async () => {
    const { model, errors } = await parseString(
      wrap(
        `aggregate Customer { email: string  invariant email.length > 0  unique (email)  derived display: string = email }`,
      ),
    );
    expect(errors).toEqual([]);
    const kinds = firstAggregate(model).members.map((m) => m.$type);
    expect(kinds).toContain("Unique");
    expect(kinds).toContain("Invariant");
    expect(kinds).toContain("DerivedProp");
  });
});
