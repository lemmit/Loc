// A5 temporal end-to-end on the Java/Spring backend — java.time rendering in
// domain bodies (Duration algebra, `Duration.between` for dt−dt, the UTC
// `plusMonths` calendar hop for months) AND where-position lowering: HQL
// duration arithmetic (`e.dueDate + 30 day`) in the JPQL `@Query` finds plus
// HibernateCriteriaBuilder duration arithmetic (`addDuration` /
// `subtractDuration` / `durationScaled`) in the reified criterion
// Specifications.  Runtime representation: an absolute duration is a
// `java.time.Duration`; months go through the calendar paths only.
// Boot-verified end-to-end against Postgres (Spring parses every @Query at
// startup; the finds and Specifications executed with correct row sets).

import { describe, expect, it } from "vitest";
import { renderCriteriaPredicate } from "../../../src/generator/java/render-criteria.js";
import type { AggregateIR, ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system TemporalShop {
  subdomain Billing {
    context Invoicing {
      aggregate Invoice {
        createdAt: datetime
        dueDate: datetime
        deliveredAt: datetime
        orderedAt: datetime
        gracePeriod: int
        derived isOverdue: bool = now() > dueDate + days(30)
        derived renewal: datetime = createdAt + months(1)
        derived trial: datetime = createdAt - months(3)
        derived early: datetime = dueDate - hours(6)
        operation slack(): bool {
          let d = days(1)
          let renewedBy = orderedAt + months(1)
          let span = deliveredAt - orderedAt
          let window = days(gracePeriod) + minutes(30)
          let doubled = d * 2
          return span < window + doubled && renewedBy > deliveredAt
        }
      }
      repository Invoices for Invoice {
        find slipping(q: datetime): Invoice[] where this.dueDate < q + hours(6)
        find slippingDays(q: datetime): Invoice[] where this.dueDate < q + days(2)
        find overdueBy(q: datetime): Invoice[] where this.dueDate + days(30) < q
        find dueSoon(n: int): Invoice[] where this.dueDate - hours(n) < now()
        find renewing(q: datetime): Invoice[] where this.createdAt + months(1) >= q
        find renewingSoon(q: datetime): Invoice[] where this.dueDate < q + months(1)
      }

      criterion Slipping(q: datetime) of Invoice = dueDate < q + hours(6)
      criterion LongOverdue of Invoice = dueDate + days(30) < now()
      criterion DueWithin(n: int) of Invoice = dueDate - hours(n) < now()
      criterion GraceExpired of Invoice = dueDate + days(gracePeriod) < now()

      retrieval SlippingSoon(q: datetime) of Invoice { where: Slipping(q) }
      retrieval OverdueList of Invoice { where: LongOverdue }
      retrieval DueSoonList(n: int) of Invoice { where: DueWithin(n) }
      retrieval GraceExpiredList of Invoice { where: GraceExpired }
    }
  }
  api InvoicingApi from Billing
  storage primary { type: postgres }
  resource invoicingState { for: Invoicing, kind: state, use: primary }
  deployable invoicingApi {
    platform: java
    contexts: [Invoicing]
    dataSources: [invoicingState]
    serves: InvoicingApi
    port: 8081
  }
}
`;

const ROOT = "invoicing_api/src/main/java/com/loom/invoicingapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — A5 temporal", () => {
  it("parses + validates cleanly (incl. queryable temporal where-clauses)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders datetime ± absolute duration through Instant.plus/minus + Duration ctors", async () => {
    const domain = (await files()).get(`${ROOT}/features/invoices/Invoice.java`)!;
    expect(domain).toContain("import java.time.Duration;");
    expect(domain).toContain("Instant.now().isAfter(this.dueDate.plus(Duration.ofDays(30)))");
    expect(domain).toContain("return this.dueDate.minus(Duration.ofHours(6));");
  });

  it("renders datetime ± months through the UTC calendar hop (+ and -)", async () => {
    const domain = (await files()).get(`${ROOT}/features/invoices/Invoice.java`)!;
    // Instant has no plusMonths — hop through the UTC calendar.
    expect(domain).toContain(
      "return this.createdAt.atOffset(java.time.ZoneOffset.UTC).plusMonths((1)).toInstant();",
    );
    expect(domain).toContain(
      "return this.createdAt.atOffset(java.time.ZoneOffset.UTC).minusMonths((3)).toInstant();",
    );
  });

  it("renders dt−dt as Duration.between, duration algebra/scaling/compare as Duration methods", async () => {
    const domain = (await files()).get(`${ROOT}/features/invoices/Invoice.java`)!;
    // Loom `a - b` = a minus b = Duration.between(b, a).
    expect(domain).toContain("var span = Duration.between(this.orderedAt, this.deliveredAt);");
    // Duration-typed let via the ctor leaf.
    expect(domain).toContain("var d = Duration.ofDays(1);");
    expect(domain).toContain(
      "var window = Duration.ofDays(this.gracePeriod).plus(Duration.ofMinutes(30));",
    );
    expect(domain).toContain("var doubled = d.multipliedBy(2);");
    // Duration ordering is Comparable-based.
    expect(domain).toContain("span.compareTo(window.plus(doubled)) < 0");
    // months inside an operation body takes the same calendar hop.
    expect(domain).toContain(
      "var renewedBy = this.orderedAt.atOffset(java.time.ZoneOffset.UTC).plusMonths((1)).toInstant();",
    );
  });

  it("lowers where-position datetime ± duration to HQL duration arithmetic (column side)", async () => {
    const jpa = (await files()).get(`${ROOT}/features/invoices/InvoiceJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Invoice e where (e.dueDate + 30 day) < :q")');
    // Param amount binds; `now()` is HQL's `instant` (the current Instant).
    expect(jpa).toContain(
      '@Query("select e from Invoice e where (e.dueDate - :n hour) < instant")',
    );
    // months in where-position stays HQL-native — Postgres interval months
    // does the calendar arithmetic, no client-side hop.
    expect(jpa).toContain('@Query("select e from Invoice e where (e.createdAt + 1 month) >= :q")');
  });

  it("lowers where-position datetime ± duration on the VALUE side too (all four units typed)", async () => {
    const jpa = (await files()).get(`${ROOT}/features/invoices/InvoiceJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Invoice e where e.dueDate < (:q + 6 hour)")');
    expect(jpa).toContain('@Query("select e from Invoice e where e.dueDate < (:q + 2 day)")');
    expect(jpa).toContain('@Query("select e from Invoice e where e.dueDate < (:q + 1 month)")');
  });

  it("renders reified criterion Specifications via HibernateCriteriaBuilder duration arithmetic", async () => {
    const crit = (await files()).get(`${ROOT}/domain/criteria/InvoiceCriteria.java`)!;
    expect(crit).toContain("import org.hibernate.query.criteria.HibernateCriteriaBuilder;");
    // Column side, constant amount.
    expect(crit).toContain(
      'cb.lessThan(((HibernateCriteriaBuilder) cb).addDuration(root.<Instant>get("dueDate"), Duration.ofDays(30)), Instant.now())',
    );
    // Column side, param amount (a plain Java Duration closed over by the spec).
    expect(crit).toContain(
      'cb.lessThan(((HibernateCriteriaBuilder) cb).subtractDuration(root.<Instant>get("dueDate"), Duration.ofHours(n)), Instant.now())',
    );
    // Column AMOUNT — scales a one-unit duration by the column.
    expect(crit).toContain(
      '((HibernateCriteriaBuilder) cb).durationScaled(root.<Integer>get("gracePeriod"), Duration.ofDays(1))',
    );
    // All-value temporal side stays plain Java and binds as one parameter.
    expect(crit).toContain(
      'cb.lessThan(root.<Instant>get("dueDate"), q.plus(Duration.ofHours(6)))',
    );
  });

  it("criteria months arm renders the unit-tagged Hibernate duration (calendar-correct SQL)", () => {
    // `months(...)` inside a criterion body is currently unreachable through
    // the DSL (the AST months-position gate can't type candidate fields in a
    // criterion env — a shared-layer gap, not java's), so pin the renderer
    // arm directly over synthetic IR: `createdAt + months(2) >= m`.
    const dt: TypeIR = { kind: "primitive", name: "datetime" };
    const agg = {
      name: "Invoice",
      idValueType: "guid",
      fields: [
        { name: "createdAt", type: dt },
        { name: "gracePeriod", type: { kind: "primitive", name: "int" } },
      ],
    } as unknown as AggregateIR;
    const createdAt: ExprIR = {
      kind: "member",
      receiver: { kind: "this" },
      member: "createdAt",
      receiverType: { kind: "entity", name: "Invoice" },
      memberType: dt,
    };
    const body = (amount: ExprIR): ExprIR => ({
      kind: "binary",
      op: ">=",
      left: {
        kind: "binary",
        op: "+",
        left: createdAt,
        right: { kind: "duration", unit: "months", amount },
        leftType: dt,
        resultType: dt,
      },
      right: { kind: "ref", name: "m", refKind: "param", type: dt },
      leftType: dt,
      resultType: { kind: "primitive", name: "bool" },
    });
    const imports = new Set<string>();
    const constMonths = renderCriteriaPredicate(body({ kind: "literal", lit: "int", value: "2" }), {
      agg,
      voLookup: new Map(),
      imports,
    });
    expect(constMonths).toBe(
      'cb.greaterThanOrEqualTo(((HibernateCriteriaBuilder) cb).addDuration(root.<Instant>get("createdAt"), ((HibernateCriteriaBuilder) cb).duration(2, TemporalUnit.MONTH)), m)',
    );
    expect(imports).toContain("org.hibernate.query.common.TemporalUnit");
    expect(imports).toContain("org.hibernate.query.criteria.HibernateCriteriaBuilder");
    // Column amount scales a one-month unit duration.
    const colAmount: ExprIR = {
      kind: "member",
      receiver: { kind: "this" },
      member: "gracePeriod",
      receiverType: { kind: "entity", name: "Invoice" },
      memberType: { kind: "primitive", name: "int" },
    };
    const colMonths = renderCriteriaPredicate(body(colAmount), {
      agg,
      voLookup: new Map(),
      imports: new Set(),
    });
    expect(colMonths).toContain(
      '((HibernateCriteriaBuilder) cb).durationScaled(root.<Integer>get("gracePeriod"), ((HibernateCriteriaBuilder) cb).duration(1, TemporalUnit.MONTH))',
    );
  });
});
