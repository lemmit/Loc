// A VALUE-OBJECT field default at the WIRE boundary.
//
// A field default is rendered by each backend's DOMAIN expression renderer.
// On the backends with a distinct wire DTO that puts a domain class into a
// wire-typed slot — which python (`mypy --strict`) and .NET (CS0246) reject
// and Hono ACCEPTS, structurally.  That asymmetry is why the assertions below
// are per-backend text rather than one shared shape: there is no single
// "correct" rendering, because the three targets disagree about what a wire
// default can even BE.
//
//   python  a Pydantic default is an ordinary runtime expression → it can be
//           the wire model itself: `MoneyModel(amount=0, currency="USD")`.
//   .NET    a record parameter default must be a COMPILE-TIME CONSTANT
//           (CS1736), and no constructor call is one → the param goes nullable
//           and the controller coalesces, reusing the escape hatch
//           server-sourced defaults already take.
//   hono    `.default(...)` feeds a zod schema whose output is the wire object
//           → a plain object literal, not the domain class.
//
// The compile tiers own whether the emitted projects BUILD (that is
// `corpus:vo-field-default`); this file owns the SHAPE, so a regression is a
// fast unit failure rather than a five-minute docker build.

import { describe, expect, it } from "vitest";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";

const FEATURE = "vo-field-default";

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  expect(hit, `no emitted file ends with ${suffix} — the probe is stale`).toBeDefined();
  return hit![1];
}

describe("a value-object field default renders in the WIRE shape", () => {
  it("python: the request model default is the wire model, not the domain class", async () => {
    const src = fileEndingWith(await generateCorpusCase(FEATURE, "python"), "invoice_routes.py");
    expect(src).toContain('total: MoneyModel = MoneyModel(amount=0, currency="USD")');
    expect(src).toContain('credit: MoneyModel = MoneyModel(amount=0, currency="EUR")');
    // The defect: the DOMAIN class in a wire-typed slot.
    expect(src).not.toMatch(/total: MoneyModel = Money\(/);
  });

  it("hono: the zod default is a wire object literal, not a domain instance", async () => {
    const src = fileEndingWith(await generateCorpusCase(FEATURE, "node"), "invoice.routes.ts");
    expect(src).toContain('total: MoneySchema.default({ amount: 0, currency: "USD" })');
    // This is the one that COMPILES either way — structural typing — so
    // nothing but this assertion stands between it and silent reintroduction.
    expect(src).not.toContain("MoneySchema.default(new Money(");
  });

  it(".NET: the request param goes nullable and the controller coalesces", async () => {
    const files = await generateCorpusCase(FEATURE, "dotnet");
    const req = fileEndingWith(files, "InvoiceRequests.cs");
    expect(req).toContain("MoneyRequest? Total = null");
    // `new Money(...)` is not a compile-time constant (CS1736) and the request
    // file cannot even name the domain type (CS0246).
    expect(req).not.toContain("= new Money(");

    const ctl = fileEndingWith(files, "InvoicesController.cs");
    expect(ctl).toContain('request.Total is null ? new Money(0m, "USD")');
  });

  it(".NET: a nullable VO field's FluentValidation rule narrows and guards", async () => {
    // The knock-on that only appears once the field is nullable:
    // `IValidator<T>` is not `IValidator<T?>` (CS8620).  Two features
    // individually fine and jointly broken.
    const src = fileEndingWith(
      await generateCorpusCase(FEATURE, "dotnet"),
      "InvoiceRequestValidators.cs",
    );
    expect(src).toContain(
      "RuleFor(x => x.Total!).SetValidator(new MoneyRequestValidator()).When(x => x.Total is not null);",
    );
  });

  it("java: the entity imports BigDecimal for a default it renders into the factory", async () => {
    // Java carries no wire default at all — it coalesces in the service — so
    // it looked unaffected.  It was not: the factory renders the default, and
    // NOTHING scanned field defaults for expression-triggered imports, so a
    // decimal-bearing default emitted `new BigDecimal(...)` with no import.
    const src = fileEndingWith(await generateCorpusCase(FEATURE, "java"), "Invoice.java");
    expect(src).toContain("import java.math.BigDecimal;");
    expect(src).toContain('new Money(new BigDecimal("0"), "USD")');
  });
});
