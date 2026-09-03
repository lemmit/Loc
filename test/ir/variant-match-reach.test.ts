import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

// ---------------------------------------------------------------------------
// WHERE the variant-match gates run, as opposed to WHAT they check.
//
// `variant-match.test.ts` covers the four semantic rules on an operation body.
// This covers the axis that file cannot see: the gates only fire where the
// check's outer loop goes, and until M-T9.40 that loop was a hand-rolled copy
// reaching aggregate `operations`, appliers, invariants, derived and functions
// plus workflow `statements` — and NOT `create` / `destroy` operation bodies,
// workflow `create` blocks, handlers, subscriptions, value-object and
// entity-part members, page and component bodies, or tests.  A `match` written
// in any of those was parsed, lowered and emitted with none of its four gates
// run.
//
// A control case runs alongside the widened one on purpose.  Without it, a
// regression that disabled the check ENTIRELY would look identical to a pass
// here — the assertion would be measuring the wrong thing while staying green,
// which is the failure mode this whole mission is about.
// ---------------------------------------------------------------------------

const SYS = (member: string) => `
  system Shop {
    subdomain Sales {
      context Shop {
        error NF { detail: string }
        aggregate A {
          code: string
          operation reserve(): A or NF { return NF { detail: code } }
          ${member}
        }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource shopState { for: Shop, kind: state, use: pg }
    deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
  }
`;

/** `Missing` is not a variant of `A or NF`, so a conforming check reports
 *  `loom.match-unknown-variant` wherever it reaches this arm. */
const BAD_MATCH = `match o { A a => a.code, NF n => n.detail, Missing m => "x" }`;

const matchCodes = async (member: string): Promise<string[]> => {
  const { model } = await parseString(SYS(member), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code?.startsWith("loom.match-"))
    .map((d) => d.code as string);
};

describe("variant-match gates reach every body that can hold a match", () => {
  it("an operation body — the control", async () => {
    // The site the old outer loop already reached.  If this ever goes quiet the
    // check is broken outright, and the widened case below proves nothing.
    expect(
      await matchCodes(`operation bad(): string { let o = reserve() return ${BAD_MATCH} }`),
    ).not.toEqual([]);
  });

  it("a `create` operation body", async () => {
    // The old loop walked `agg.operations` and not `agg.creates` — so every
    // hand-written `create` body was unchecked.  Verified by reverting the
    // outer loop: this case reported nothing before the migration.
    expect(await matchCodes(`create make(c: string) { code := c let o = reserve() }`)).toEqual(
      [],
      // sanity: the well-formed shape is quiet, so the assertion below is about
      // the bad arm and not about `create` bodies being noisy in general
    );
    expect(
      await matchCodes(
        `create make(c: string) { code := c let o = reserve() let s = ${BAD_MATCH} }`,
      ),
    ).not.toEqual([]);
  });
});
