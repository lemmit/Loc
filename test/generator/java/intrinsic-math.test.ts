// A3 math batch of the scalar-intrinsic catalogue (docs/plans/stdlib.md)
// on the Java/Spring backend — abs/min/max on int/long/decimal/money and
// round/floor/ceil on decimal/money.  In-memory rendering in derived
// bodies (Math.* for the primitive receivers, the BigDecimal method API
// for decimal/money — RoundingMode.HALF_UP is Java's half-away-from-zero,
// the catalogue's commercial-rounding contract), JPQL rendering in
// queryable `find … where` positions (abs/round/floor/ceiling +
// two-value least/greatest), and the Criteria/Specification path
// (cb.abs / JPA 3.1's cb.round + cb.function("least", …) for a reified
// criterion).  Catalogue rows in src/util/intrinsics.ts; Java snippets in
// render-expr.ts (JAVA_INTRINSIC_RENDERERS), render-jpql.ts
// (JPQL_INTRINSIC_SQL), render-criteria.ts (JAVA_CRITERIA_INTRINSICS).
// Sibling of the string batch (intrinsic-strings.test.ts).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Bank {
  subdomain Banking {
    context Ledger {
      aggregate Account {
        qty: int
        balance: money
        cap: money
        derived absQty: int = qty.abs()
        derived rounded: money = balance.round(2)
        derived whole: money = balance.round()
        derived floored: money = balance.floor()
        derived ceiled: money = balance.ceil()
        derived clamped: money = balance.min(cap)
        derived atLeast: int = qty.max(0)
      }
      repository Accounts for Account {
        find byRound(q: money): Account[] where this.balance.round(2) > q
        find byRoundNoPlaces(q: money): Account[] where this.balance.round() > q
        find byAbsQty(n: int): Account[] where this.qty.abs() > n
        find byMinBal(q: money): Account[] where this.balance.min(this.cap) == q
        find byCeil(q: money): Account[] where this.balance.ceil() >= q
      }
    }
  }
  api LedgerApi from Banking
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable bankApi {
    platform: java
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    port: 8081
  }
}
`;

const ROOT = "bank_api/src/main/java/com/loom/bankapi";

describe("java generator — math intrinsics batch (stdlib A3)", () => {
  it("parses + validates cleanly (all queryable where-positions)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders abs/min/max in-memory — Math.* for int, the BigDecimal API for money", async () => {
    const files = await generateSystemFiles(SRC);
    const domain = files.get(`${ROOT}/features/accounts/Account.java`)!;
    expect(domain).toContain("Math.abs(this.qty)");
    expect(domain).toContain("Math.max(this.qty, 0)");
    expect(domain).toContain("this.balance.min(this.cap)");
  });

  it("renders round/floor/ceil in-memory via setScale — HALF_UP is half-away-from-zero", async () => {
    const files = await generateSystemFiles(SRC);
    const domain = files.get(`${ROOT}/features/accounts/Account.java`)!;
    expect(domain).toContain("this.balance.setScale(2, java.math.RoundingMode.HALF_UP)");
    // places defaults to 0 when omitted.
    expect(domain).toContain("this.balance.setScale(0, java.math.RoundingMode.HALF_UP)");
    expect(domain).toContain("this.balance.setScale(0, java.math.RoundingMode.FLOOR)");
    expect(domain).toContain("this.balance.setScale(0, java.math.RoundingMode.CEILING)");
  });

  it("renders round as JPQL — with places and defaulting to the 1-arg form", async () => {
    const files = await generateSystemFiles(SRC);
    const jpa = files.get(`${ROOT}/features/accounts/AccountJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Account e where round(e.balance, 2) > :q")');
    expect(jpa).toContain('@Query("select e from Account e where round(e.balance) > :q")');
  });

  it("renders abs / two-value least / ceiling as JPQL in find where-clauses", async () => {
    const files = await generateSystemFiles(SRC);
    const jpa = files.get(`${ROOT}/features/accounts/AccountJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Account e where abs(e.qty) > :n")');
    // Column-typed `other` is legal — least(col_a, col_b).
    expect(jpa).toContain('@Query("select e from Account e where least(e.balance, e.cap) = :q")');
    expect(jpa).toContain('@Query("select e from Account e where ceiling(e.balance) >= :q")');
  });

  it("imports java.math.BigDecimal in the controller for money find params", async () => {
    const files = await generateSystemFiles(SRC);
    const controller = files.get(`${ROOT}/features/accounts/AccountsController.java`)!;
    expect(controller).toContain("import java.math.BigDecimal;");
    expect(controller).toContain("@RequestParam BigDecimal q");
  });

  it("renders round + min in a reified criterion Specification (cb.round / cb.function least)", async () => {
    const src = SRC.replace(
      "repository Accounts for Account {",
      `criterion NearCap(q: money) of Account = balance.round(2) >= q
      criterion AtLeastQty(n: int) of Account = qty.min(n) == n
      repository Accounts for Account {`,
    );
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
    const files = await generateSystemFiles(src);
    const crit = files.get(`${ROOT}/domain/criteria/AccountCriteria.java`)!;
    expect(crit).toContain(
      'cb.greaterThanOrEqualTo(cb.round(root.<BigDecimal>get("balance"), 2), q)',
    );
    // Two-value min — NOT cb.least (an aggregate): cb.function over the
    // boxed receiver type, the value arg lifted via cb.literal.
    expect(crit).toContain(
      'cb.equal(cb.function("least", Integer.class, root.<Integer>get("qty"), cb.literal(n)), n)',
    );
  });
});
