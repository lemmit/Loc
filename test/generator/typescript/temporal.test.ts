// A5 temporal end-to-end on the Hono/TS backend — in-memory rendering
// (ms arithmetic, dt−dt) in domain bodies AND SQL interval rendering
// (`make_interval`) in queryable `find … where` positions.  Runtime
// representation: an absolute duration is plain MILLISECONDS (a number).

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateHono } from "../../_helpers/generate.js";
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
    }
  }
`;

describe("typescript generator — A5 temporal", () => {
  it("parses + validates cleanly (incl. queryable temporal where-clauses)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders datetime ± absolute duration as getTime() ms arithmetic", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/invoice.ts")!;
    expect(domain).toContain(
      "get due(): Date { return new Date((this._createdAt).getTime() + (((30) * 86400000))); }",
    );
    expect(domain).toContain(
      "get early(): Date { return new Date((this._dueDate).getTime() - (((6) * 3600000))); }",
    );
    expect(domain).toContain(
      "new Date() > new Date((this._dueDate).getTime() + (((1) * 86400000)))",
    );
  });

  it("renders dt−dt as ms, duration algebra as plain numbers", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/invoice.ts")!;
    expect(domain).toContain(
      "const span = ((this._deliveredAt).getTime() - (this._orderedAt).getTime());",
    );
    expect(domain).toContain("const window = ((this._gracePeriod) * 86400000) + ((30) * 60000);");
    expect(domain).toContain("const doubled = ((1) * 86400000) * 2;");
  });

  it("lowers column-side datetime ± duration to sql`make_interval` and imports sql", async () => {
    const { model } = await parseString(SRC);
    const repo = generateHono(model).get("db/repositories/invoice-repository.ts")!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source interpolating in the generated sql tag, not here
    expect(repo).toContain("lt(sql`${schema.invoices.dueDate} + make_interval(days => ${30})`, q)");
    expect(repo).toContain(
      // param amount binds; `now()` renders as a bound Date value
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source
      "lt(sql`${schema.invoices.dueDate} - make_interval(hours => ${n})`, new Date())",
    );
    expect(repo).toMatch(/import \{[^}]*\bsql\b[^}]*\} from "drizzle-orm";/);
  });

  it("value-side datetime ± duration also lowers (fragment side, param binds)", async () => {
    const src = `
      context Billing {
        aggregate Invoice { dueDate: datetime }
        repository Invoices for Invoice {
          find w(q: datetime): Invoice[] where this.dueDate < q + days(2)
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/invoice-repository.ts")!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source
    expect(repo).toContain("lt(schema.invoices.dueDate, sql`${q} + make_interval(days => ${2})`)");
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
    // The queryable gate is IR-level (phase ⑦) — only DIRECT constructor
    // operands are admitted; a `duration + duration` composite is honestly
    // rejected (matching exactly what lowerToDrizzle lowers).
    const diags = validateLoomModel(toLoomModel(model));
    expect(diags.some((d) => d.severity === "error" && d.message.includes("arithmetic"))).toBe(
      true,
    );
  });
});
