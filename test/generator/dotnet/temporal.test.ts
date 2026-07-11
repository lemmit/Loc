// A5 temporal end-to-end on the .NET backend — in-memory rendering
// (native DateTime/TimeSpan arithmetic, dt−dt) in domain bodies AND
// EF-translatable `DateTime.Add{Days,Hours,Minutes}` rendering in queryable
// `find … where` positions.  Runtime representation: an absolute duration
// is a `TimeSpan`.  Mirrors test/generator/typescript/temporal.test.ts.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { toLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Billing {
    aggregate Invoice {
      createdAt: datetime
      dueDate: datetime
      deliveredAt: datetime
      orderedAt: datetime
      gracePeriod: int
      derived due: datetime = createdAt + days(30)
      derived early: datetime = dueDate - hours(6)
      derived overdue: bool = now() > dueDate + days(1)
      operation slack(): bool {
        let span = deliveredAt - orderedAt
        let window = days(gracePeriod) + minutes(30)
        let doubled = days(1) * 2
        return span < window + doubled
      }
    }
    repository Invoices for Invoice {
      find overdueBy(q: datetime): Invoice[] where this.dueDate + days(30) < q
      find dueSoon(n: int): Invoice[] where this.dueDate - hours(n) < now()
      find slipped(q: datetime): Invoice[] where this.dueDate < q + days(2)
    }
  }
`;

describe("dotnet generator — A5 temporal", () => {
  it("parses + validates cleanly (incl. queryable temporal where-clauses)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders duration constructors as TimeSpan and datetime ± duration as native operators", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Invoices/Invoice.cs")!;
    expect(domain).toContain("this.CreatedAt + TimeSpan.FromDays(30)");
    expect(domain).toContain("this.DueDate - TimeSpan.FromHours(6)");
    expect(domain).toContain("DateTime.UtcNow > this.DueDate + TimeSpan.FromDays(1)");
  });

  it("renders dt−dt, duration algebra, and duration * int as native TimeSpan ops", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Invoices/Invoice.cs")!;
    // datetime − datetime → TimeSpan, via the native operator (a
    // duration-typed let).
    expect(domain).toContain("var span = this.DeliveredAt - this.OrderedAt;");
    // duration ± duration → TimeSpan operators.
    expect(domain).toContain(
      "var window = TimeSpan.FromDays(this.GracePeriod) + TimeSpan.FromMinutes(30);",
    );
    // duration * int → TimeSpan scaling (native since .NET Core 2.0).
    expect(domain).toContain("var doubled = TimeSpan.FromDays(1) * 2;");
    expect(domain).toContain("return span < window + doubled;");
  });

  it("lowers column-side datetime ± duration to EF-translatable Add{Days,Hours} in Where", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/InvoiceRepository.cs")!;
    expect(repo).toContain(".Where(x => (x.DueDate).AddDays((30)) < q)");
    // param amount composes; `now()` renders as DateTime.UtcNow (funcletized
    // into a query parameter by EF).
    expect(repo).toContain(".Where(x => (x.DueDate).AddHours(-(n)) < DateTime.UtcNow)");
  });

  it("value-side datetime ± duration also lowers (EF funcletizes the value side)", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/InvoiceRepository.cs")!;
    expect(repo).toContain(".Where(x => x.DueDate < (q).AddDays((2)))");
  });

  it("never emits the in-memory TimeSpan spelling inside a Where lambda", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/InvoiceRepository.cs")!;
    expect(repo).not.toContain("TimeSpan.From");
  });

  it("rejects a non-constructor duration composite in where-position (honest gate)", async () => {
    const src = `
      context Billing {
        aggregate Invoice { dueDate: datetime }
        repository Invoices for Invoice {
          find w(q: datetime): Invoice[] where this.dueDate + (days(1) + hours(2)) < q
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    // The queryable gate is IR-level (phase ⑦) and platform-neutral — only
    // DIRECT constructor operands are admitted; a `duration + duration`
    // composite is honestly rejected (matching exactly what the EF binary
    // arm lowers).
    const diags = validateLoomModel(toLoomModel(model));
    expect(diags.some((d) => d.severity === "error" && d.message.includes("arithmetic"))).toBe(
      true,
    );
  });
});
