// Scalar-intrinsic completeness gate (docs/old/plans/stdlib.md, Phase A).
//
// The catalogue (src/util/intrinsics.ts) is the single source of truth for
// which scalar ops exist; each backend carries a snippet table for
// (a) in-memory rendering in domain bodies and (b) — for `queryable` rows —
// SQL rendering in find/view/criterion/filter positions.  This test pins
// that EVERY catalogue row has a snippet in EVERY table, so adding a row
// fails CI until each backend is filled in (the walker-stdlib-completeness
// pattern applied to the expression stdlib).
//
// .NET is exempt from the SQL-table requirement by design: its where-path
// feeds the SAME C# expression (`renderCsExpr` → LINQ lambda) to EF Core,
// which translates the in-memory form to SQL — there is no second .NET
// renderer to drift.  Its in-memory table (CS_INTRINSIC_RENDERERS) is the
// single seam and IS required.  Java carries an extra table for the
// Criteria/Specification path (reified criteria), which renders through
// `cb.*` calls rather than JPQL strings.

import { describe, expect, it } from "vitest";
import { CS_INTRINSIC_RENDERERS } from "../../src/generator/dotnet/render-expr.js";
import {
  ECTO_INTRINSIC_FRAGMENTS,
  ELIXIR_INTRINSIC_RENDERERS,
} from "../../src/generator/elixir/render-expr.js";
import { JAVA_CRITERIA_INTRINSICS } from "../../src/generator/java/render-criteria.js";
import { JAVA_INTRINSIC_RENDERERS } from "../../src/generator/java/render-expr.js";
import { JPQL_INTRINSIC_SQL } from "../../src/generator/java/render-jpql.js";
import { SQLALCHEMY_INTRINSIC_SQL } from "../../src/generator/python/find-predicate.js";
import { PY_INTRINSIC_RENDERERS } from "../../src/generator/python/render-expr.js";
import { TS_INTRINSIC_RENDERERS } from "../../src/generator/typescript/render-expr.js";
import { DRIZZLE_INTRINSIC_SQL } from "../../src/generator/typescript/repository-find-predicate.js";
import { INTRINSIC_SIGNATURES, intrinsicKey } from "../../src/util/intrinsics.js";

const IN_MEMORY_TABLES: Record<string, Record<string, unknown>> = {
  "typescript (TS_INTRINSIC_RENDERERS)": TS_INTRINSIC_RENDERERS,
  "dotnet (CS_INTRINSIC_RENDERERS)": CS_INTRINSIC_RENDERERS,
  "java (JAVA_INTRINSIC_RENDERERS)": JAVA_INTRINSIC_RENDERERS,
  "python (PY_INTRINSIC_RENDERERS)": PY_INTRINSIC_RENDERERS,
  "elixir (ELIXIR_INTRINSIC_RENDERERS)": ELIXIR_INTRINSIC_RENDERERS,
};

const SQL_TABLES: Record<string, Record<string, unknown>> = {
  "typescript/drizzle (DRIZZLE_INTRINSIC_SQL)": DRIZZLE_INTRINSIC_SQL,
  "java/jpql (JPQL_INTRINSIC_SQL)": JPQL_INTRINSIC_SQL,
  "java/criteria (JAVA_CRITERIA_INTRINSICS)": JAVA_CRITERIA_INTRINSICS,
  "python/sqlalchemy (SQLALCHEMY_INTRINSIC_SQL)": SQLALCHEMY_INTRINSIC_SQL,
  "elixir/ecto (ECTO_INTRINSIC_FRAGMENTS)": ECTO_INTRINSIC_FRAGMENTS,
};

describe("intrinsic completeness — every catalogue row has a snippet on every backend", () => {
  for (const sig of INTRINSIC_SIGNATURES) {
    const key = intrinsicKey(sig.receiver, sig.name);

    it(`${key}: in-memory snippet on all 5 backends`, () => {
      for (const [label, table] of Object.entries(IN_MEMORY_TABLES)) {
        expect(table[key], `missing in-memory snippet for '${key}' in ${label}`).toBeTypeOf(
          "function",
        );
      }
    });

    if (sig.queryable) {
      it(`${key}: SQL snippet on every query renderer (dotnet exempt — LINQ)`, () => {
        for (const [label, table] of Object.entries(SQL_TABLES)) {
          expect(table[key], `missing SQL snippet for '${key}' in ${label}`).toBeTypeOf("function");
        }
      });
    }
  }

  it("no orphan snippets — every table key is a catalogue row", () => {
    const known = new Set(INTRINSIC_SIGNATURES.map((s) => intrinsicKey(s.receiver, s.name)));
    for (const [label, table] of Object.entries({ ...IN_MEMORY_TABLES, ...SQL_TABLES })) {
      for (const key of Object.keys(table)) {
        expect(known.has(key), `orphan snippet '${key}' in ${label} (not in the catalogue)`).toBe(
          true,
        );
      }
    }
  });
});
