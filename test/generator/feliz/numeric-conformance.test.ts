// Feliz numeric conformance (M-T1.22, audit F2) — the arms where F#'s numeric
// semantics diverge from Loom's and the divergence is invisible to the
// compile-only `generated-feliz-build` gate:
//
//   • `a / b` on two integers.  Loom's type system WIDENS integer division to
//     `decimal` (`5 / 2` is `2.5`) — every other target honours that through
//     the shared `isIntDivWidenedToDecimal` predicate.  F# is in the truncating
//     family, so without the widening arm a page body silently computed `2`.
//   • `long`.  It collapsed to F# `int` (+ `Decode.int`), so anything past
//     int32 was rejected by the record decoder — a runtime failure the Fable
//     compile cannot see.
//   • bad numeric TEXT in a number input.  Every form cell is a `string`; the
//     encoder converts with F#'s `int`/`decimal`, which PARSE and THROW.  A
//     `type=number` input happily holds `"2.5"` in an `int` field, so submit
//     threw an unhandled Elmish exception instead of showing a form error.
//
// Both feliz expression paths are asserted for the division: the VIEW path
// (shared `_walker/walker-core.ts` → the `exprNumericBinary` seam) and the MVU
// UPDATE path (`fs-expr.ts`'s own dispatcher). They share one function, and
// this pins that they cannot drift apart.
//
// The same seam also coerces MIXED numeric operands (`int + long`,
// `int * decimal`): Loom's type system widens along `int → long → decimal`
// implicitly, F# not at all — so without the conversion the emitted operator
// is a hard Fable type error.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const sys = (body: string) => `
system P {
  subdomain S { context C {
    aggregate Order { name: string }
    repository Orders for Order { }
  } }
  api A from S
  ui WebApp {
    api C: A
    ${body}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3005 }
}`;

/** Generate `src/App.fs` for a feliz-hosted ui with this ui body. */
async function app(body: string): Promise<string> {
  const model = await buildLoomModel(sys(body));
  const s = model.systems[0]!;
  const web = s.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
}

describe("feliz: integer division widens to decimal", () => {
  it("widens both operands on the MVU update path", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { hits: int = 5  visits: int = 2  rate: decimal = 0 }
      action compute() { rate := hits / visits }
      body: Button("go", onClick: compute)
    }`);
    // Both operands converted — F#'s `int / int` truncates, and `decimal l / r`
    // with an `int` right-hand side does not even typecheck.
    expect(fs).toContain("((decimal model.Hits) / (decimal model.Visits))");
    // The un-widened form must not survive anywhere.
    expect(fs).not.toContain("(model.Hits / model.Visits)");
  });

  // A body-position division goes through the SHARED walker
  // (`_walker/walker-core.ts`), not `fs-expr.ts`'s own dispatcher — so it only
  // reaches the F# arm through the new `WalkerTarget.exprNumericBinary` seam.
  it("widens both operands on the view path (the walker seam)", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { hits: int = 5  visits: int = 2 }
      body: Text { \`Rate: {hits / visits}\` }
    }`);
    expect(fs).toContain("((decimal model.Hits) / (decimal model.Visits))");
    expect(fs).not.toContain("(model.Hits / model.Visits)");
  });

  it("converts only the integral side of a mixed decimal / int division", async () => {
    const fs = await app(`
    page Calc {
      route: "/calc"
      state { total: decimal = 10  parts: int = 4  rate: decimal = 0 }
      action compute() { rate := total / parts }
      body: Button("go", onClick: compute)
    }`);
    // The int-div predicate refuses a mixed pair (its decimal side is already
    // fractional and must not be re-wrapped) — but F# has no implicit
    // `int → decimal` conversion either, so the INT side still converts up.
    expect(fs).toContain("(model.Total / (decimal model.Parts))");
    expect(fs).not.toContain("(decimal model.Total)");
  });
});

describe("feliz: mixed-width numeric operands coerce (F# widens nothing)", () => {
  it("converts the int side up when it meets a long", async () => {
    const fs = await app(`
    page Stats {
      route: "/stats"
      state { impressions: long  bonus: int = 0  reach: long }
      action compute() { reach := impressions + bonus }
      body: Button("go", onClick: compute)
    }`);
    // int64 + int is a hard F# type error — the narrower side converts.
    expect(fs).toContain("(model.Impressions + (int64 model.Bonus))");
  });

  it("converts the integral side up when it meets a decimal, on the view path too", async () => {
    const fs = await app(`
    page Cart {
      route: "/cart"
      state { price: decimal = 0  qty: int = 1 }
      body: Text { \`Total: {qty * price}\` }
    }`);
    // The body-position expression reaches F# through the walker seam.
    expect(fs).toContain("((decimal model.Qty) * model.Price)");
  });
});

describe("feliz: a Loom `long` is an F# int64", () => {
  const LONG_SYS = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  impressions: long }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Products {
      route: "/products"
      body: QueryView {
        of: Shop.Product.all,
        loading: Text { "…" }, error: Text { "!" }, empty: Text { "0" },
        data: rows => Stack { For { each: rows, p => Card { p.name } } }
      }
    }
    page ProductNew {
      route: "/products/new"
      body: Stack { CreateForm { of: Product } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}`;

  /** `src/App.fs` for a system source (rather than a bare ui body). */
  async function appOf(source: string): Promise<string> {
    const model = await buildLoomModel(source);
    const s = model.systems[0]!;
    const web = s.deployables.find((d) => d.name === "web")!;
    return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
  }

  it("spells the wire record field int64 and decodes it with Decode.int64", async () => {
    const fs = await appOf(LONG_SYS);
    expect(fs).toContain("impressions: int64");
    // `Decode.int` bounds-checks against Int32 and fails the WHOLE record
    // decode past 2^31 — the exact range a `long` exists to carry.
    expect(fs).toContain('get.Required.Field "impressions" Decode.int64');
  });

  it("encodes a long form field as a JSON number, not Encode.int64's string", async () => {
    const fs = await appOf(LONG_SYS);
    // Thoth's `Encode.int64` renders `value.ToString(InvariantCulture)` — a
    // JSON STRING — so the int64 goes out through `Encode.float`.
    expect(fs).toContain('"impressions", Encode.float (float (int64 form.impressions))');
    expect(fs).not.toContain('"impressions", Encode.int (int form.impressions)');
  });

  it("spells a long state cell int64, zeroes it 0L, and parses input via Int64", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { impressions: long }
      body: Stack {
        NumberField { "Impressions", bind: impressions },
        Text { \`{impressions}\` }
      }
    }`);
    expect(fs).toContain("Impressions: int64");
    expect(fs).toContain("Impressions = 0L");
    expect(fs).toContain(
      "| SetImpressions v -> { model with Impressions = (match System.Int64.TryParse v with | true, n -> n | _ -> 0L) }, Cmd.none",
    );
    expect(fs).not.toContain("System.Int32.TryParse v");
  });

  // Lowering PROMOTES a bare int literal to `long` when it meets a long
  // operand, so the literal leaf must emit the `L` suffix — a bare `3` is an
  // F# `int`, and `int64 > int` does not typecheck.
  it("suffixes a promoted long literal with L", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { impressions: long  hot: bool = false }
      action evaluate() { hot := impressions > 3 }
      body: Button("go", onClick: evaluate)
    }`);
    expect(fs).toContain("(model.Impressions > 3L)");
  });

  // A `long(x)` conversion must widen to int64, not truncate through `int`.
  it("converts to int64, never through int", async () => {
    const fs = await app(`
    page Counter {
      route: "/counter"
      state { small: int = 0  impressions: long }
      action widen() { impressions := long(small) }
      body: Button("go", onClick: widen)
    }`);
    expect(fs).toContain("(int64 model.Small)");
    expect(fs).not.toContain("(int model.Small)");
  });

  // A PERSISTED store field of type `long` crosses the JS boundary as a raw
  // string; its codec has to parse through Int64 or the parsed `int` will not
  // typecheck against the `int64` Model field (`feliz-persist-codec.ts`).
  it("persists a long store field through Int64.TryParse", async () => {
    const fs = await app(`
    store Stats persist: local {
      state { impressions: long }
      action bump() { impressions := impressions + 1 }
    }
    page Home {
      route: "/"
      body: Text { \`{Stats.impressions}\` }
    }`);
    expect(fs).toContain("StatsImpressions: int64");
    expect(fs).toContain("System.Int64.TryParse raw");
  });
});

describe("feliz: numeric form text validates before the encoder parses it", () => {
  // name (required, non-numeric) / price (required, fractional) /
  // rank (OPTIONAL, integral) — the three validation shapes side by side.
  const FORM_SYS = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish { name: string  price: money  rank: int? }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page ProductNew {
      route: "/products/new"
      body: Stack { CreateForm { of: Product } }
    }
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}`;

  async function appOf(source: string): Promise<string> {
    const model = await buildLoomModel(source);
    const s = model.systems[0]!;
    const web = s.deployables.find((d) => d.name === "web")!;
    return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
  }

  it("emits blank-tolerant TryParse helpers, one per strictness in use", async () => {
    const fs = await appOf(FORM_SYS);
    // The spelling `update-emit.ts` already proves compiles under Fable.
    expect(fs).toContain("  let isWholeText (s: string) : bool =");
    expect(fs).toContain(
      "    System.String.IsNullOrWhiteSpace s || (match System.Int64.TryParse s with | true, _ -> true | _ -> false)",
    );
    expect(fs).toContain("  let isNumberText (s: string) : bool =");
    expect(fs).toContain(
      "    System.String.IsNullOrWhiteSpace s || (match System.Decimal.TryParse s with | true, _ -> true | _ -> false)",
    );
  });

  it("adds a parse term per numeric field to the Valid predicate — optional included", async () => {
    const fs = await appOf(FORM_SYS);
    // One flat && chain: required contributes non-empty, numeric contributes
    // parse, a required numeric contributes both.  `rank` is OPTIONAL and still
    // guarded: its encoder's `int` conversion throws on unparseable text too.
    expect(fs).toContain(
      "  let productFormValid (form: ProductForm) : bool =\n" +
        "    not (System.String.IsNullOrWhiteSpace form.name)" +
        " && not (System.String.IsNullOrWhiteSpace form.price) && isNumberText form.price" +
        " && isWholeText form.rank",
    );
  });

  it("gives a required numeric the Required→parse error ladder", async () => {
    const fs = await appOf(FORM_SYS);
    expect(fs).toContain(
      '    if System.String.IsNullOrWhiteSpace form.price then Some "Required" elif not (isNumberText form.price) then Some "Must be a number" else None',
    );
  });

  it("gives an optional numeric a parse-only error fn — blank stays a legitimate omission", async () => {
    const fs = await appOf(FORM_SYS);
    expect(fs).toContain(
      '    if isWholeText form.rank then None else Some "Must be a whole number"',
    );
    // No Required rung, and no non-empty term anywhere for the optional cell.
    expect(fs).not.toContain("IsNullOrWhiteSpace form.rank");
  });

  it("wires the optional numeric cell into the touched/onBlur inline-error path", async () => {
    const fs = await appOf(FORM_SYS);
    // `rank` is not required, but it is message-bearing now — the view must
    // dispatch its blur so the "Must be a whole number" message can show.
    expect(fs).toContain('prop.onBlur (fun _ -> dispatch (TouchProductForm "rank"))');
  });

  it("emits no numeric helpers for a form with no numeric field", async () => {
    const fs = await appOf(
      FORM_SYS.replace("name: string  price: money  rank: int?", "name: string"),
    );
    expect(fs).toContain("module Validation =");
    expect(fs).not.toContain("isWholeText");
    expect(fs).not.toContain("isNumberText");
  });
});

describe("feliz: a promoted decimal/money literal carries the m suffix", () => {
  const sys2 = (body: string) => `
system P {
  subdomain S { context C {
    aggregate Order { name: string }
    repository Orders for Order { }
  } }
  api A from S
  ui WebApp {
    api C: A
    ${body}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3005 }
}`;

  async function app2(body: string): Promise<string> {
    const model = await buildLoomModel(sys2(body));
    const s = model.systems[0]!;
    const web = s.deployables.find((d) => d.name === "web")!;
    return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
  }

  // Lowering PROMOTES a bare int literal to `decimal` when it meets a decimal
  // operand (`price > 10` stamps `lit: "decimal"`), and a bare `10` is an F#
  // `int` — Fable has no implicit `int → decimal`, so without the `m` suffix
  // the comparison does not typecheck.  The exact sibling of the `L` case.
  it("suffixes a promoted decimal literal with m on the MVU path", async () => {
    const fs = await app2(`
    page Cart {
      route: "/cart"
      state { price: decimal = 0  pricey: bool = false }
      action evaluate() { pricey := price > 10 }
      body: Button("go", onClick: evaluate)
    }`);
    expect(fs).toContain("(model.Price > 10m)");
  });

  it("suffixes a promoted decimal literal with m on the view path", async () => {
    const fs = await app2(`
    page Cart {
      route: "/cart"
      state { price: decimal = 0 }
      body: Text { \`Deal: {price < 5}\` }
    }`);
    expect(fs).toContain("(model.Price < 5m)");
  });
});

describe("feliz: dynamic-row numeric cells guard the submit too", () => {
  // A VO[] row cell feeds the SAME throwing encoders as a flat cell, so each
  // row group with a numeric sub-field contributes a `List.forall` parse term
  // to `<form>Valid` (row required-ness stays informational — only the parse
  // hazard gates submit).
  const ROW_SYS = `
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Ordering {
      valueobject LineItem { sku: string  qty: int  price: money }
      aggregate Order with crudish {
        reference: string
        items: LineItem[]
      }
      repository Orders for Order { }
    }
  }
  storage db { type: postgres }
  resource ordState { for: Ordering, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page OrderNew {
      route: "/orders/new"
      body: Stack { CreateForm { of: Order } }
    }
  }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}`;

  async function appOf(source: string): Promise<string> {
    const model = await buildLoomModel(source);
    const s = model.systems[0]!;
    const web = s.deployables.find((d) => d.name === "web")!;
    return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
  }

  it("folds a List.forall parse term per numeric row cell into the Valid predicate", async () => {
    const fs = await appOf(ROW_SYS);
    expect(fs).toContain(
      "  let orderFormValid (form: OrderForm) : bool =\n" +
        "    not (System.String.IsNullOrWhiteSpace form.reference)" +
        " && List.forall (fun row -> isWholeText row.qty && isNumberText row.price) form.items",
    );
    // The string row cell contributes nothing.
    expect(fs).not.toContain("row.sku)");
  });
});
