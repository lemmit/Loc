// A3 math batch of the scalar-intrinsic catalogue (docs/old/plans/stdlib.md):
// numeric abs/min/max ({int,long,decimal,money}) + round/floor/ceil
// ({decimal,money}) on the .NET backend — in-memory rendering in domain
// bodies AND the EF LINQ `Where` path.  The catalogue rows live in
// src/util/intrinsics.ts; the C# snippets in render-expr.ts.
//
// The one .NET-specific wrinkle is `round`: the catalogue contract is
// HALF-AWAY-FROM-ZERO (commercial rounding), so domain bodies force
// `MidpointRounding.AwayFromZero` (native Math.Round defaults to banker's
// half-even) — but EF Core/Npgsql cannot translate the MidpointRounding
// overloads, so the query position (CS_INTRINSIC_QUERY_RENDERERS) drops the
// mode and relies on Postgres round(numeric[, n]) already being
// half-away-from-zero (verified via ToQueryString, EF 10.0.9/Npgsql 10.0.2).
// Math.Abs/Min/Max/Floor/Ceiling all translate as-is (abs/LEAST/GREATEST/
// floor/ceiling), so no other numeric row carries a query override.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Billing {
    aggregate Invoice {
      amount: money
      budget: money
      rate: decimal
      qty: int
      big: long
      derived roundedAmount: money = amount.round(2)
      derived wholeAmount: money = amount.round()
      derived absQty: int = qty.abs()
      derived minAmount: money = amount.min(budget)
      derived flooredRate: decimal = rate.floor()
      derived ceiledRate: decimal = rate.ceil()
      operation reprice(delta: money) {
        amount := amount.max(delta).round(2)
      }
    }
    repository Invoices for Invoice {
      find pricierThan(q: money): Invoice[] where this.amount.round(2) > q
      find wholeAbove(q: money): Invoice[] where this.amount.round() > q
      find byAbsQty(n: int): Invoice[] where this.qty.abs() > n
      find cappedAt(q: money): Invoice[] where this.amount.min(q) == q
      find byMaxBig(l: long): Invoice[] where this.big.max(l) == l
      find byRateBand(r: decimal): Invoice[] where this.rate.floor() <= r && this.rate.ceil() >= r
    }
  }
`;

describe("dotnet generator — numeric math intrinsics (stdlib A3)", () => {
  it("parses + validates cleanly (receiver-typed, queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders round in-memory with MidpointRounding.AwayFromZero (both arities)", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Invoices/Invoice.cs")!;
    expect(domain).toContain("Math.Round(this.Amount, 2, MidpointRounding.AwayFromZero)");
    expect(domain).toContain("Math.Round(this.Amount, MidpointRounding.AwayFromZero)");
  });

  it("renders abs/min/floor/ceil in-memory via System.Math", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Invoices/Invoice.cs")!;
    expect(domain).toContain("Math.Abs(this.Qty)");
    expect(domain).toContain("Math.Min(this.Amount, this.Budget)");
    expect(domain).toContain("Math.Floor(this.Rate)");
    expect(domain).toContain("Math.Ceiling(this.Rate)");
  });

  it("renders chained intrinsics in an operation body (max then round)", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Invoices/Invoice.cs")!;
    expect(domain).toContain(
      "Math.Round(Math.Max(this.Amount, delta), 2, MidpointRounding.AwayFromZero)",
    );
  });

  it("renders round in the find Where lambda WITHOUT MidpointRounding (EF-translatable form)", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/InvoiceRepository.cs")!;
    // Query override: MidpointRounding overloads don't translate; Postgres
    // round() is half-away-from-zero anyway, so the contract holds.
    expect(repo).toContain(".Where(x => Math.Round(x.Amount, 2) > q)");
    expect(repo).toContain(".Where(x => Math.Round(x.Amount, 0) > q)");
    expect(repo).not.toContain("MidpointRounding");
  });

  it("renders abs/min/max/floor/ceil in Where lambdas as-is (EF translates them natively)", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/InvoiceRepository.cs")!;
    expect(repo).toContain(".Where(x => Math.Abs(x.Qty) > n)");
    expect(repo).toContain(".Where(x => Math.Min(x.Amount, q) == q)");
    expect(repo).toContain(".Where(x => Math.Max(x.Big, l) == l)");
    expect(repo).toContain(".Where(x => Math.Floor(x.Rate) <= r && Math.Ceiling(x.Rate) >= r)");
  });
});
