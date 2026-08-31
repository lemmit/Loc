import { describe, expect, it } from "vitest";
import { declarationExprSites, exprSites, siteId } from "../_helpers/expr-sites.js";

// ---------------------------------------------------------------------------
// The denominator for M-T9.40.
//
// Eleven modules walk the model's expression-bearing sites and each rolls its
// own outer loop.  Nothing says how many sites there ARE, so "does this check
// reach every expression" has never had an answer — and `validateExprIntegrity`,
// the check whose name claims the whole surface, reaches no ui page, find,
// projection, criterion, domain service, handler or test.
//
// `test/_helpers/expr-sites.ts` computes the answer from `loom-ir.ts` itself.
// This file is that computation's own gate.  It deliberately does NOT pin the
// census COUNT: a number that changes with every IR field would be a chore
// with no reader, and the count is not the invariant.  What it pins is that
// the machinery still WORKS — because the failure mode of a static analysis
// like this is not a wrong answer, it is an empty one, and an empty census
// would report perfect coverage to whatever consumes it.  (`gate-ledger`'s
// `skipKeys` has the same guard for the same reason.)
// ---------------------------------------------------------------------------

describe("expression-site census", () => {
  const all = exprSites();
  const declarations = declarationExprSites();
  const ids = new Set(all.map(siteId));

  it("finds a substantial surface, not an empty one", () => {
    // The blind-analysis guard.  A regex that stopped matching, a parse that
    // silently produced no declarations, an `EXPR_ROOTS` rename — each returns
    // `[]`, and `[]` reads as "every site is covered" to any consumer.
    expect(all.length).toBeGreaterThan(150);
    expect(declarations.length).toBeGreaterThan(120);
  });

  it("reaches the sites the existing partial walks do NOT", () => {
    // These are the census' reason to exist: every one is an expression site
    // that `validateExprIntegrity` cannot see, on a declaration kind its outer
    // loop never visits.  If the analysis regresses, it regresses here first.
    for (const id of [
      "PageIR.body", // ui page bodies — the whole frontend surface
      "PageIR.requires", // page-level authz gate
      "ComponentIR.body",
      "ActionIR.body", // named page actions
      "FindIR.filter", // repository finds
      "CriterionIR.body", // reusable predicate specifications
      "RetrievalIR.where",
      "ProjectionQueryIR.filter",
      "DomainServiceOperationIR.body",
      "CommandHandlerIR.statements",
      "QueryHandlerIR.statements",
      "TestIR.statements",
      "SeedRowIR.fields",
    ]) {
      expect(ids.has(id), `census lost the site \`${id}\``).toBe(true);
    }
  });

  it("counts the intra-expression fields separately from the declaration sites", () => {
    // The split is the point: `walk.ts` already owns the intra-expression half
    // exhaustively (a new `ExprIR` arm fails the build), so folding the two
    // together would overstate what the missing enumeration has to cover.
    expect(declarations.length).toBeLessThan(all.length);
    expect(all.some((s) => s.owner === "ExprIR")).toBe(true);
    expect(declarations.some((s) => s.owner === "ExprIR")).toBe(false);
  });

  it("follows a field through a named type, not just a direct `ExprIR`", () => {
    // `AggregateIR.operations` is `OperationIR[]`; the expressions are two hops
    // down (`OperationIR.statements` → `StmtIR`).  A census that only matched
    // fields typed `ExprIR` directly would miss almost the entire surface, and
    // would still look plausible.
    expect(ids.has("AggregateIR.operations")).toBe(true);
    expect(ids.has("BoundedContextIR.aggregates")).toBe(true);
    expect(ids.has("LoomModel.contexts")).toBe(true);
  });

  it("excludes fields that structurally cannot carry an expression", () => {
    // The other direction: a census that returned every field would also be
    // useless, and would also look plausible.
    expect(ids.has("AggregateIR.name")).toBe(false);
    expect(ids.has("AggregateIR.isAbstract")).toBe(false);
    expect(ids.has("BoundedContextIR.name")).toBe(false);
  });
});
