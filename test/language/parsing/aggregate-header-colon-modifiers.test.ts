// M-T5.17 (finding #1) — Phase 2 cutover.  The aggregate-header enum-axis
// modifiers are COLON clauses (`persistedAs: eventLog`), order-independent, and
// `crossTenant` leads beside `abstract`.  The legacy paren form was removed.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";

describe("aggregate-header colon modifiers (M-T5.17 Phase 2)", () => {
  let parse: ReturnType<typeof parseHelper>;
  beforeAll(() => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
  });

  const parseAgg = async (src: string) => {
    const doc = await parse(src);
    const ctx = (doc.parseResult.value as Model).members.find((m) => m.$type === "BoundedContext");
    // biome-ignore lint/suspicious/noExplicitAny: test navigation
    const agg = (ctx as any)?.members?.find((m: { $type: string }) => m.$type === "Aggregate") as
      | Aggregate
      | undefined;
    return { errs: doc.parseResult.parserErrors.map((e) => e.message).join("; "), agg };
  };

  it("colon form sets the fields", async () => {
    const { errs, agg } = await parseAgg(`context C {
      aggregate Ledger persistedAs: eventLog shape: document {
        name: string
      }
    }`);
    expect(errs, `must parse:\n${errs}`).toBe("");
    expect(agg?.persistedAs).toBe("eventLog");
    expect(agg?.shape).toBe("document");
  });

  it("is order-independent (shape before persistedAs)", async () => {
    const { errs, agg } = await parseAgg(`context C {
      aggregate Doc shape: document persistedAs: eventLog {
        name: string
      }
    }`);
    expect(errs, `must parse:\n${errs}`).toBe("");
    expect(agg?.persistedAs).toBe("eventLog");
    expect(agg?.shape).toBe("document");
  });

  // M-T5.17 amendment — header modifiers sort by MEANING, not value type:
  // `abstract` (what it IS) stays prefix; `crossTenant` (how it PARTICIPATES)
  // joins the enum axes in the order-independent header region.
  it("crossTenant sits in the header region, with abstract still leading", async () => {
    const { errs, agg } = await parseAgg(`context C {
      abstract aggregate Base crossTenant inheritanceUsing: ownTable {
        name: string
      }
    }`);
    expect(errs, `must parse:\n${errs}`).toBe("");
    expect(agg?.isAbstract).toBe(true);
    expect(agg?.crossTenant).toBe(true);
    expect(agg?.inheritanceUsing).toBe("ownTable");
  });

  // The whole point of folding it into the `(…)*` group: no silent
  // reorder-is-a-parse-error papercut, the same guarantee the enum axes got.
  it("crossTenant is order-independent against the enum axes", async () => {
    for (const header of [
      "aggregate Base crossTenant persistedAs: eventLog shape: document",
      "aggregate Base persistedAs: eventLog crossTenant shape: document",
      "aggregate Base persistedAs: eventLog shape: document crossTenant",
    ]) {
      const { errs, agg } = await parseAgg(`context C {
        ${header} {
          name: string
        }
      }`);
      expect(errs, `must parse (${header}):\n${errs}`).toBe("");
      expect(agg?.crossTenant, header).toBe(true);
      expect(agg?.persistedAs, header).toBe("eventLog");
      expect(agg?.shape, header).toBe("document");
    }
  });

  it("crossTenant no longer parses in the prefix slot", async () => {
    const { errs } = await parseAgg(`context C {
      crossTenant aggregate Plan {
        code: string
      }
    }`);
    expect(errs, "the pre-amendment prefix form must be rejected").not.toBe("");
  });

  it("the legacy paren form is REJECTED (Phase 2 cutover)", async () => {
    const { errs } = await parseAgg(`context C {
      aggregate Old persistedAs(eventLog) {
        name: string
      }
    }`);
    expect(errs, "paren form must no longer parse").not.toBe("");
  });

  // Was: "the legacy post-name crossTenant is REJECTED".  The M-T5.17
  // sort-by-meaning amendment restores the post-name form as the canonical one
  // (`crossTenant` is participation, not nature), so the rejection is now
  // inverted — see "crossTenant no longer parses in the prefix slot" above.
});
