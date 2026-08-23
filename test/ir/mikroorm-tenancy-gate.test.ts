// Hierarchical tenancy on `persistence: mikroorm` is SUPPORTED — no diagnostic,
// no silent unscoping.
//
// History, because this file is the record of both failure modes:
//
//  1. SILENT LEAK.  `mikroContextFilters` lowered each capability filter through
//     `whereToMikroFilter` and CAUGHT the failure the subtree predicate caused:
//
//         try { out.push(whereToMikroFilter(pred)); }
//         catch { /* unlowerable principal filter — left unapplied */ }
//
//     For a `deep`/`global` scope that is not a degraded read — it is NO tenant
//     predicate at all, so every tenant's rows were readable on every read.
//     Verified at the time: generating `tenancy-hierarchy.ddd` with
//     `persistence: mikroorm` produced repositories whose reads carried no
//     `dataKey` / `tenantId` term whatsoever.
//  2. HONEST REFUSAL.  `validateMikroOrmSupport` grew a gate, so the shape was
//     rejected instead of leaking.
//  3. SUPPORTED (this).  The FilterQuery OPERATORS still cannot express a prefix
//     test, but a FilterQuery KEY may be a `raw()` SQL fragment and the
//     predicate is ordinary SQL.  `authzFilterEntry` renders the
//     descendant-or-self test (`starts_with(data_key, ?)` + the NULL-dataKey
//     tenant floor), the `orgPath` resolver is registered on this adapter too,
//     and the silent catch is GONE — an unlowerable principal filter now crashes
//     codegen rather than vanishing.
//
// So this file pins the absence of a diagnostic; the emitted shape is pinned by
// `test/generator/typescript/mikroorm-deep-scope.test.ts`, and the runtime
// agreement by `test/e2e/tenancy-hierarchy-mikroorm.test.ts`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";
import { corpusSource } from "../fixtures/corpus/harness.js";

async function errorsFor(platform: string): Promise<string[]> {
  const src = corpusSource("tenancy-hierarchy").replaceAll("__PLATFORM__", platform);
  const { model, errors } = await parseString(src, { validate: true });
  if (errors.length > 0) return errors;
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code}`);
}

describe("hierarchical tenancy × the mikroorm adapter", () => {
  it("validates clean — the subtree predicate is expressible after all", async () => {
    expect(await errorsFor("node { persistence: mikroorm }")).toEqual([]);
  });

  it("still generates clean on the default adapter", async () => {
    expect(await errorsFor("node")).toEqual([]);
  });
});
