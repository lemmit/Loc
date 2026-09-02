// The derived `history(id)` read reaches the phase-④ api-body allowlist.
//
// `checkApiBodyRefs` walks every `<apiParam>.<Aggregate>.<op>(…)` chain in a
// page body and refuses an `op` outside `listValidApiOperations(agg)` — an
// AST-level allowlist of the CRUD verbs, the aggregate's public operations, and
// its repository's declared finds.
//
// The entity-history read is none of those: it is SYNTHESIZED at phase ⑥
// (`ensureHistoryFind`, src/ir/util/audit-history.ts) onto every `audited`
// aggregate that will serve one.  The allowlist could not see it, so exactly
// one of the two spellings of the SAME call validated:
//
//     QueryView { of: Product.history(id), … }         // bare — accepted
//     QueryView { of: Sales.Product.history(id), … }   // api handle — REFUSED
//
// …and the refused one is the spelling `scaffoldDetails` itself emits whenever
// the ui declares an api handle (`queryRoot()` in `_body-builders.ts`).  So a
// hand-written page could not say what the scaffold says, which is the whole
// promise of the customization gradient.
//
// The fix derives allowlist membership from the `audited` AST flag, through the
// one shared predicate the scaffold macro uses (`src/util/audit-ast.ts`), so
// "the macro emits the section" and "the validator accepts the call" cannot
// disagree.  These cases pin BOTH halves: that the two spellings validate, that
// they lower to the same read, and that the allowlist did not just go blanket-
// permissive (a non-audited aggregate still refuses `history`).

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** `of:` subject of the page's `QueryView`, with the api-handle root — when
 *  present — stripped, so the two spellings are compared on what they actually
 *  READ rather than on how the author reached the aggregate. */
const HISTORY_OF = (readExpr: string) => `QueryView {
              of: ${readExpr},
              data: entries => Timeline { of: entries }
            }`;

const SYS = (readExpr: string, aggHeader: string) => `
system S {
  subdomain Sales {
    context Orders {
      aggregate ${aggHeader} {
        code: string
        operation rename(next: string) { code := next }
      }
      repository Products for Product { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  ui W {
    framework: react
    api Sales: SalesApi
    page Detail {
      route: "/products/:id"
      body: Stack {
        ${HISTORY_OF(readExpr)}
      }
    }
  }
  deployable back { platform: node, contexts: [Orders], dataSources: [st], serves: SalesApi, port: 3000 }
  deployable web { platform: static, targets: back, ui: W { Sales: back }, port: 3001 }
}`;

async function errorsFor(source: string): Promise<string[]> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  return (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
}

/** The generated Detail page component — the observable end of "lowers to the
 *  same read".  The two spellings do NOT produce identical IR (the api-handle
 *  form keeps its `<handle>.` root as a member access, the bare form does not),
 *  and they are not supposed to: `isEntityHistoryRead`
 *  (`src/generator/_walker/history-read.ts`) accepts both receiver shapes on
 *  purpose.  What must not differ is what comes OUT — same hook, same
 *  `Timeline`, same file. */
async function detailPageSource(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const entry = [...files].find(([p]) => /pages\/detail\.tsx$/.test(p));
  if (!entry) {
    throw new Error(`no generated Detail page among: ${[...files.keys()].join(", ")}`);
  }
  return entry[1];
}

const AUDITED = "Product audited";
const PLAIN = "Product";

describe("the derived history(id) read in the phase-④ api-body allowlist", () => {
  it("accepts the BARE aggregate spelling on an audited aggregate", async () => {
    const errors = await errorsFor(SYS("Product.history(id)", AUDITED));
    expect(errors.filter((e) => /history/.test(e))).toEqual([]);
  });

  it("accepts the API-HANDLE spelling — the one the scaffold itself emits", async () => {
    const errors = await errorsFor(SYS("Sales.Product.history(id)", AUDITED));
    expect(errors.filter((e) => /history/.test(e))).toEqual([]);
  });

  it("generates the same page from both spellings", async () => {
    const bare = await detailPageSource(SYS("Product.history(id)", AUDITED));
    const viaApi = await detailPageSource(SYS("Sales.Product.history(id)", AUDITED));
    expect(viaApi).toBe(bare);
    // …and it really is the history read that was rendered, not two identically
    // empty pages: the derived `useHistory<Agg>` hook has to be bound to the
    // route id, and the `Timeline` primitive expanded into its markup.
    expect(bare).toMatch(/useHistoryProduct\(id\)/);
    expect(bare).toMatch(/loom-timeline/);
  }, 120_000);

  it("still refuses history on an aggregate that serves no history read", async () => {
    // The allowlist must stay DERIVED, not blanket-permissive: a non-audited
    // aggregate synthesizes no `history` find, so the call would compile to a
    // client hook that was never emitted.
    const errors = await errorsFor(SYS("Sales.Product.history(id)", PLAIN));
    expect(
      errors.some((e) => /Operation 'history' is not declared on aggregate 'Product'/.test(e)),
      `expected the non-audited aggregate to still refuse 'history'; got: ${errors.join(" | ")}`,
    ).toBe(true);
  });

  it("names history among the available operations when it IS served", async () => {
    // The diagnostic's "Available: …" list is how an author discovers the read,
    // so the allowlist has to carry it, not merely stop rejecting it.
    const errors = await errorsFor(SYS("Sales.Product.nosuchop(id)", AUDITED));
    const offending = errors.find((e) => /Operation 'nosuchop'/.test(e));
    expect(offending, `no allowlist diagnostic raised; got: ${errors.join(" | ")}`).toBeDefined();
    expect(offending).toContain("history");
  });
});
