// ---------------------------------------------------------------------------
// `loom.scaffold-filter-param-unsupported` — the honest half of M-T1.15.
//
// `filterFindsForAggregate` wires one filter input per param of each
// array-returning repository `find`, ALL-OR-NOTHING: a find with a single
// param it cannot render is skipped whole.  M-T1.15 widened the renderable set
// from `string` to `string`/`int`/`long`/`<X> id`; `enum` and
// `decimal`/`money` stayed out because the FRONTEND emitters cannot carry them
// (an enum `state {}` field is typed as bare `string` on every frontend while
// the query param is the zod enum union → TS2322; the bar's "unset" sentinel
// is the int literal `0`, which F# types as `decimal <> int` → FS0001).
//
// Measured on `main` before this gate: a repository with
// `byTitle(t: string)`, `byStatus(s: Status)` and `byRate(r: decimal)`
// scaffolded a list page whose filter bar carried ONLY `byTitleT`; the other
// two finds were absent from the page and from every diagnostic.
//
// The test doubles as the pin between the two halves that must agree — the
// macro's `filterParamKind` (AST `TypeRef`) and the IR check's
// `filterParamRenderable` (`TypeIR`), which cannot share a predicate because
// they see different representations.  For each param type it asserts EITHER a
// bound filter state field OR the diagnostic — never both, never neither.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { PageIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { RENDERABLE_FILTER_PRIMITIVES } from "../../src/util/filter-param-kinds.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.scaffold-filter-param-unsupported";

const wrap = (finds: string, uiExtra = "") => `
system Demo {
  subdomain S {
    context Shop {
      enum Status { Open, Closed }
      aggregate Order with crudish {
        title:  string
        status: Status
        rate:   decimal
        qty:    int
      }
      repository Orders for Order {
${finds}
      }
    }
  }
  api ShopApi from S
  ui Web with scaffold(aggregates: [Order]) {
    api Shop: ShopApi
    ${uiExtra}
  }
  storage primarySql { type: postgres }
  resource shopState { for: Shop, kind: state, use: primarySql }
  deployable api { platform: node contexts: [Shop] dataSources: [shopState] serves: ShopApi port: 3000 }
  deployable web { platform: static targets: api ui: Web { Shop: api } port: 3001 }
}`;

async function model(src: string) {
  const { model: ast, errors } = await parseString(src);
  const hard = errors.filter((e) => !e.includes("wire-shaped list query"));
  if (hard.length) throw new Error(`unexpected parse errors:\n${hard.join("\n")}`);
  return enrichLoomModel(lowerModel(ast));
}

async function probe(finds: string, uiExtra = "") {
  const loom = await model(wrap(finds, uiExtra));
  const diags = validateLoomModel(loom);
  const pages: PageIR[] = loom.systems.flatMap((s) => s.uis.flatMap((u) => u.pages));
  const list = pages.find((p) => p.name === "List");
  return {
    codes: diags.filter((d) => d.code === CODE).map((d) => d.message),
    stateFields: (list?.state ?? []).map((f) => f.name),
  };
}

describe("loom.scaffold-filter-param-unsupported — the gate", () => {
  it("reports an enum filter param the bar cannot render", async () => {
    const { codes, stateFields } = await probe(
      `        find byStatus(s: Status): Order[] where this.status == s`,
    );
    expect(codes).toHaveLength(1);
    expect(codes[0]).toContain("`s: Status`");
    expect(codes[0]).toContain("byStatus");
    expect(stateFields).not.toContain("byStatusS");
  });

  it("reports a decimal filter param", async () => {
    const { codes, stateFields } = await probe(
      `        find byRate(r: decimal): Order[] where this.rate == r`,
    );
    expect(codes).toHaveLength(1);
    expect(codes[0]).toContain("`r: decimal`");
    expect(stateFields).not.toContain("byRateR");
  });

  // The message is a REMEDY, so its type list has to be the set the gate
  // actually refuses.  #2699 landed `bool` / `datetime` / `guid` in
  // `RENDERABLE_FILTER_PRIMITIVES` and the catalog text kept naming all three as
  // having "no input at all" — sending an author to change a param type that
  // already works, and hiding the two kinds that ARE still refused.  This pins
  // both directions against `RENDERABLE_FILTER_PRIMITIVES` itself rather than
  // against a hand-copied list, so the next kind to land fails here instead of
  // rotting the message (experience_gathered §91: a list in prose is a cache).
  it("the message's type list matches the set the gate actually renders", async () => {
    const { codes } = await probe(
      `        find byStatus(s: Status): Order[] where this.status == s`,
    );
    const message = codes[0]!;
    // Split at the hinge.  Naming a kind ANYWHERE is not enough — the stale
    // text named `bool`/`datetime`/`guid` too, as things that "have no input at
    // all", so a mere `toContain` passes on the exact wording under test.  What
    // has to hold is WHICH SIDE of the sentence each kind lands on.
    const hinge = message.indexOf("Two kinds are still held back");
    expect(hinge, `message must keep the renders/refuses split:\n${message}`).toBeGreaterThan(0);
    const renders = message.slice(0, hinge);
    const refuses = message.slice(hinge);

    // Forward ratchet: a kind the gate renders must be OFFERED.  Add one to
    // `RENDERABLE_FILTER_PRIMITIVES` without touching the message and this
    // fails — which is the whole point, since the message is the remedy.
    for (const kind of RENDERABLE_FILTER_PRIMITIVES) {
      expect(
        renders,
        `'${kind}' renders — it belongs in the offered list, not below the hinge`,
      ).toContain(`\`${kind}\``);
    }
    // Reverse ratchet: the two still refused are named below the hinge with
    // their reasons, and NOT offered above it.  (Only the offered side gets a
    // blanket exclusion — the refusing side legitimately mentions `string`
    // while explaining the enum case, so "appears below the hinge" cannot mean
    // "is listed as refused".)
    expect(refuses).toMatch(/`decimal`\/`money`/);
    expect(refuses).toMatch(/`enum`/);
    expect(renders).not.toMatch(/`decimal`|`money`|`enum`/);
    // The stale enumeration verbatim, so it cannot return by copy-paste.
    expect(message).not.toMatch(/no input at all/);
    expect(message).not.toMatch(/`bool`\/`datetime`\/`guid`/);
  });

  it("stays quiet for the kinds M-T1.15 landed — string, int and `X id`", async () => {
    const { codes, stateFields } = await probe(
      `        find byTitle(t: string): Order[] where this.title == t
        find byQty(q: int): Order[] where this.qty == q
        find byRef(o: Order id): Order[] where this.id == o`,
    );
    expect(codes).toEqual([]);
    expect(stateFields).toEqual(expect.arrayContaining(["byTitleT", "byQtyQ", "byRefO"]));
  });

  it("is ALL-OR-NOTHING: one bad param sinks a find whose others are fine", async () => {
    const { codes, stateFields } = await probe(
      `        find byTitleAndStatus(t: string, s: Status): Order[] where this.title == t`,
    );
    expect(codes).toHaveLength(1);
    expect(stateFields).not.toContain("byTitleAndStatusT");
  });

  it("stays quiet on a single-record find — the bar only wires list queries", async () => {
    const { codes } = await probe(
      `        find oneByStatus(s: Status): Order? where this.status == s`,
    );
    expect(codes).toEqual([]);
  });

  it("stays quiet when an overriding `page List` already binds the find", async () => {
    const { codes } = await probe(
      `        find byStatus(s: Status): Order[] where this.status == s`,
      `area Orders {
         page List {
           route: "/orders"
           body: QueryView {
             of: Shop.Order.byStatus("Open"),
             loading: Skeleton { count: 1 },
             error: Alert { "err" },
             empty: Empty { "none" },
             data: rows => Text { "ok" }
           }
         }
       }`,
    );
    expect(codes).toEqual([]);
  });

  it("is a warning, not an error — a find need not belong in the bar", async () => {
    const loom = await model(
      wrap(`        find byStatus(s: Status): Order[] where this.status == s`),
    );
    const d = validateLoomModel(loom).filter((x) => x.code === CODE);
    expect(d.map((x) => x.severity)).toEqual(["warning"]);
  });
});
