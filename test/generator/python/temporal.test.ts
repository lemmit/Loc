// A5 temporal end-to-end on the Python/FastAPI backend — in-memory
// rendering (stdlib `timedelta` arithmetic, the dateutil `relativedelta`
// calendar path, dt−dt) in domain bodies AND SQL interval rendering
// (`func.make_interval`) in queryable `find … where` positions.  Runtime
// representation: an absolute duration is a `datetime.timedelta`; months
// go through `relativedelta` only.  The Python mirror of
// test/generator/typescript/temporal.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

/** Wrap a Billing context in a single python-deployable system. */
function sys(context: string): string {
  return `system Temporal {
    subdomain Billing {
      ${context}
    }

    api BillingApi from Billing

    storage pg { type: postgres }
    resource billingState { for: Billing, kind: state, use: pg }

    deployable api {
      platform: python
      contexts: [Billing]
      dataSources: [billingState]
      serves: BillingApi
      port: 8000
    }
  }`;
}

const SRC = sys(`
  context Billing {
    aggregate Invoice ids guid {
      createdAt: datetime
      dueDate: datetime
      deliveredAt: datetime
      orderedAt: datetime
      gracePeriod: int
      derived due: datetime = createdAt + days(30)
      derived renewal: datetime = createdAt + months(1)
      derived trial: datetime = createdAt - months(3)
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
      find renewing(q: datetime): Invoice[] where this.createdAt + months(1) >= q
      find windowed(q: datetime): Invoice[] where this.dueDate < q + days(2)
    }
  }
`);

async function build(src: string) {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python generator — A5 temporal", () => {
  it("parses + validates cleanly (incl. queryable temporal where-clauses)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders datetime ± absolute duration as native timedelta arithmetic", async () => {
    const files = await build(SRC);
    const domain = files.get("api/app/domain/invoice.py")!;
    expect(domain).toContain("return self._created_at + timedelta(days=(30))");
    expect(domain).toContain("return self._due_date - timedelta(hours=(6))");
    expect(domain).toContain("datetime.now(UTC) > self._due_date + timedelta(days=(1))");
    expect(domain).toContain("from datetime import UTC, datetime, timedelta");
  });

  it("renders datetime ± months through the relativedelta calendar path (+ and -)", async () => {
    const files = await build(SRC);
    const domain = files.get("api/app/domain/invoice.py")!;
    expect(domain).toContain("return self._created_at + relativedelta(months=(1))");
    expect(domain).toContain("return self._created_at - relativedelta(months=(3))");
    expect(domain).toContain("from dateutil.relativedelta import relativedelta");
  });

  it("renders dt−dt, duration algebra/scaling, and duration-typed lets natively", async () => {
    const files = await build(SRC);
    const domain = files.get("api/app/domain/invoice.py")!;
    // datetime − datetime → timedelta, bound to a plain local.
    expect(domain).toContain("span = self._delivered_at - self._ordered_at");
    // duration + duration (param-driven amount included).
    expect(domain).toContain(
      "window = timedelta(days=(self._grace_period)) + timedelta(minutes=(30))",
    );
    // duration * int.
    expect(domain).toContain("doubled = timedelta(days=(1)) * 2");
    expect(domain).toContain("return span < window + doubled");
  });

  it("lowers column-side datetime ± duration to func.make_interval (param + literal amounts)", async () => {
    const files = await build(SRC);
    const repo = files.get("api/app/db/repositories/invoice_repository.py")!;
    expect(repo).toContain("((InvoiceRow.due_date + func.make_interval(0, 0, 0, 30)) < q)");
    // param amount binds; `now()` renders as a bound host-value datetime.
    expect(repo).toContain(
      "((InvoiceRow.due_date - func.make_interval(0, 0, 0, 0, n)) < datetime.now(UTC))",
    );
    // months in where-position uses make_interval's months slot — Postgres
    // does the calendar arithmetic natively (no relativedelta on SQL side).
    expect(repo).toContain("((InvoiceRow.created_at + func.make_interval(0, 1)) >= q)");
    expect(repo).toMatch(/from sqlalchemy import .*\bfunc\b/);
    // The temporal find params / now() bind need the datetime import.
    expect(repo).toContain("from datetime import UTC, datetime");
  });

  it("value-side datetime ± duration lowers via literal(...) so the ± stays SQL-bound", async () => {
    const files = await build(SRC);
    const repo = files.get("api/app/db/repositories/invoice_repository.py")!;
    expect(repo).toContain("(InvoiceRow.due_date < (literal(q) + func.make_interval(0, 0, 0, 2)))");
    expect(repo).toMatch(/from sqlalchemy import .*\bliteral\b/);
  });

  it("ships python-dateutil (+ stubs) in pyproject only when months is used", async () => {
    const withMonths = await build(SRC);
    const pyproject = withMonths.get("api/pyproject.toml")!;
    expect(pyproject).toContain('"python-dateutil>=2.9,<3",');
    expect(pyproject).toContain('"types-python-dateutil>=2.9,<3",');

    const withoutMonths = await build(
      sys(`
        context Billing {
          aggregate Invoice ids guid {
            dueDate: datetime
            derived due: datetime = dueDate + days(30)
          }
          repository Invoices for Invoice { }
        }
      `),
    );
    const plain = withoutMonths.get("api/pyproject.toml")!;
    expect(plain).not.toContain("python-dateutil");
    expect(plain).not.toContain("types-python-dateutil");
    // days/hours/minutes stay stdlib — timedelta needs no dependency.
    expect(withoutMonths.get("api/app/domain/invoice.py")!).toContain(
      "return self._due_date + timedelta(days=(30))",
    );
  });
});
