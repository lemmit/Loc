import { describe, expect, it } from "vitest";
import { forEachModelExpr, SITES } from "../../src/ir/util/model-exprs.js";
import { declarationExprSites, siteId } from "../_helpers/expr-sites.js";
import { loadExampleModel, toLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// The completeness gate for the model-wide expression enumeration (M-T9.40).
//
// `src/ir/util/model-exprs.ts` claims to reach every expression a `LoomModel`
// can hold.  Eleven modules made a weaker version of that claim before it and
// none could be checked — which is why `validateExprIntegrity`, the check whose
// name covers the whole surface, reached 2,316 of the 3,609 expressions in five
// examples until it was migrated onto this walk, and why nobody could say so.
//
// The claim is checkable here because the two halves are computed
// INDEPENDENTLY: `SITES` is written by hand next to the walk, and the census
// (`test/_helpers/expr-sites.ts`) is derived from `loom-ir.ts`'s own type
// declarations.  Asserting they are equal — in BOTH directions — is what turns
// "we think it is total" into a build failure the day it stops being.  Adding
// an expression-bearing field to the IR fails this test until the walk
// acknowledges it.
//
// This is the §89 shape (two halves of one contract, computed independently)
// with the gate that §89 was written about NOT having.
// ---------------------------------------------------------------------------

describe("model-wide expression enumeration", () => {
  const census = declarationExprSites().map(siteId).sort();
  const declared = [...SITES.visited, ...SITES.aliased, ...SITES.inert.keys()].sort();

  it("declares exactly the sites the IR types say exist", () => {
    // Both directions.  A census site the module does not name is a hole in the
    // walk; a name the census does not carry is a site that was renamed or
    // deleted out from under it — and a stale entry is how a walk keeps
    // claiming coverage it lost.
    expect(declared).toEqual(census);
  });

  it("keeps `visited` and the acknowledgements disjoint", () => {
    // A site cannot be both walked and excused; if it were, the excuse would
    // silently outlive the walk that made it unnecessary.
    for (const s of SITES.aliased) expect(SITES.visited.has(s)).toBe(false);
    for (const s of SITES.inert.keys()) expect(SITES.visited.has(s)).toBe(false);
  });

  it("gives every inert site a reason", () => {
    for (const [site, reason] of SITES.inert) {
      expect(reason.length, `\`${site}\` is excused with an empty reason`).toBeGreaterThan(20);
    }
  });

  describe("over the real examples", () => {
    it("reaches the sites the existing partial walks cannot", async () => {
      const hits = new Map<string, number>();
      for (const ex of ["examples/acme.ddd", "examples/showcase.ddd", "examples/banking.ddd"]) {
        const model = toLoomModel(await loadExampleModel(ex));
        forEachModelExpr(model, (v) => hits.set(v.site, (hits.get(v.site) ?? 0) + 1));
      }

      // Static coverage is a declaration; this is the walk actually arriving.
      // Every site below is one `validateExprIntegrity`'s outer loop does NOT
      // visit — read off its source, not assumed. (It DOES reach page
      // body/title/requires/state and the domain sites; the gap is everything
      // else, which is where this list comes from.)
      for (const site of [
        "ComponentIR.body",
        "ActionIR.body",
        "FieldIR.default",
        "AggregateIR.contextFilters",
        "ContextStampAssignmentIR.value",
        "FindIR.filter",
        "FindIR.criterionRef",
        "CriterionIR.body",
        "RetrievalIR.where",
        "RetrievalIR.criterionRef",
        "DomainServiceOperationIR.body",
        "QueryHandlerIR.statements",
        "QueryHandlerIR.returnValue",
        "CreateIR.statements",
        "OnIR.statements",
        "HandleIR.statements",
        "TestIR.statements",
        "TestStmtIR.expr",
        "TestE2EIR.statements",
        "SeedRowIR.fields",
        "LayoutIR.header",
        "MenuMetaIR.entries",
        "MenuLinkIR.props",
        "UiNotificationIR.toasts",
        "BackfillIntentIR.value",
      ]) {
        expect(hits.get(site) ?? 0, `the walk never reached \`${site}\``).toBeGreaterThan(0);
      }

      // The unreached surface is not a long tail of curiosities: the e2e test
      // statements and find filters alone outnumber every aggregate operation
      // body in these examples.
      expect(
        (hits.get("TestE2EIR.statements") ?? 0) + (hits.get("FindIR.filter") ?? 0),
      ).toBeGreaterThan(hits.get("OperationIR.statements") ?? 0);
    });

    it("is DEEP — a consumer cannot be accidentally shallow", async () => {
      // The enumeration hands over every sub-expression, not just the root of
      // each site.  A root-only walk would let a consumer look total and miss
      // everything nested, which is the same failure one level down.
      const model = toLoomModel(await loadExampleModel("examples/acme.ddd"));
      const kinds = new Set<string>();
      let count = 0;
      forEachModelExpr(model, (v) => {
        count++;
        kinds.add(v.expr.kind);
      });
      expect(count).toBeGreaterThan(500);
      // `member` / `binary` only occur nested inside another expression, so
      // seeing them proves the recursion ran.
      expect(kinds.has("member")).toBe(true);
      expect(kinds.has("binary")).toBe(true);
    });

    it("labels every visit with a source and a real site", async () => {
      const model = toLoomModel(await loadExampleModel("examples/acme.ddd"));
      const bad: string[] = [];
      forEachModelExpr(model, (v) => {
        if (!v.source || !SITES.visited.has(v.site)) bad.push(`${v.site} @ ${v.source}`);
      });
      // A visit tagged with a site the module does not declare would break the
      // link between the static claim above and what actually runs.
      expect(bad.slice(0, 5)).toEqual([]);
    });
  });
});
