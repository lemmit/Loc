// A5 temporal end-to-end on the Elixir/Phoenix (vanilla Ecto) backend —
// in-memory rendering (DateTime.add/diff ms arithmetic, the hand-rolled
// calendar month shift, dt−dt) in domain bodies AND Ecto `fragment(...)`
// SQL interval rendering (`make_interval`) in queryable `find … where`
// positions.  Runtime representation: an absolute duration is plain integer
// MILLISECONDS (mirrors the TS backend); months go through the calendar
// path only.  The Elixir sibling of
// test/generator/typescript/temporal.test.ts.

import { describe, expect, it } from "vitest";
import { renderExpr, renderTypespec } from "../../../src/generator/elixir/render-expr.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Api {
  subdomain Core {
    context Billing {
      aggregate Invoice with crudish {
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
        operation extend(n: int) {
          dueDate := dueDate + days(n)
        }
      }
      repository Invoices for Invoice {
        find overdueBy(q: datetime): Invoice[] where this.dueDate + days(30) < q
        find dueSoon(n: int): Invoice[] where this.dueDate - hours(n) < now()
        find renewing(q: datetime): Invoice[] where this.createdAt + months(1) >= q
      }
    }
  }
  api BillingApi from Core
  storage pg { type: postgres }
  resource st { for: Billing, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Billing]
    dataSources: [st]
    serves: BillingApi
    port: 4000
  }
}
`;

async function load(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

/** All emitted .ex/.exs sources joined — for assertions on bodies whose
 *  emit file (context module vs controller) is an implementation detail. */
function allElixir(files: Map<string, string>): string {
  return [...files.entries()]
    .filter(([k]) => k.endsWith(".ex") || k.endsWith(".exs"))
    .map(([, v]) => v)
    .join("\n");
}

const CALENDAR_PLUS_1 =
  "(fn dt -> total = dt.year * 12 + dt.month - 1 + (1); " +
  "y = Integer.floor_div(total, 12); m = Integer.mod(total, 12) + 1; " +
  "%{dt | year: y, month: m, day: min(dt.day, :calendar.last_day_of_the_month(y, m))} end)";

const CALENDAR_MINUS_3 =
  "(fn dt -> total = dt.year * 12 + dt.month - 1 - (3); " +
  "y = Integer.floor_div(total, 12); m = Integer.mod(total, 12) + 1; " +
  "%{dt | year: y, month: m, day: min(dt.day, :calendar.last_day_of_the_month(y, m))} end)";

describe("elixir generator — A5 temporal", () => {
  it("parses + validates cleanly (incl. queryable temporal where-clauses)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders datetime ± absolute duration as DateTime.add ms arithmetic (derived wire projection)", async () => {
    const files = await load();
    const ctrl = fileEndingWith(files, "/controllers/invoice_controller.ex");
    expect(ctrl).toContain(
      '"due" => DateTime.add(record.created_at, ((30) * 86400000), :millisecond)',
    );
    expect(ctrl).toContain(
      '"early" => DateTime.add(record.due_date, -(((6) * 3600000)), :millisecond)',
    );
    // Datetime ORDER comparison goes through DateTime.compare/2 — native `>`
    // on %DateTime{} structs is structural (wrong), and Elixir 1.18's type
    // checker fails --warnings-as-errors on it.
    expect(ctrl).toContain(
      '"overdue" => DateTime.compare(DateTime.utc_now(), DateTime.add(record.due_date, ((1) * 86400000), :millisecond)) == :gt',
    );
  });

  it("renders datetime ± months through the calendar-shift path (+ and -, day clamped)", async () => {
    const files = await load();
    const ctrl = fileEndingWith(files, "/controllers/invoice_controller.ex");
    expect(ctrl).toContain(`"renewal" => ${CALENDAR_PLUS_1}.(record.created_at)`);
    expect(ctrl).toContain(`"trial" => ${CALENDAR_MINUS_3}.(record.created_at)`);
  });

  it("renders dt−dt as DateTime.diff ms, duration algebra as plain integers", async () => {
    const files = await load();
    const all = allElixir(files);
    expect(all).toContain(
      "span = DateTime.diff(record.delivered_at, record.ordered_at, :millisecond)",
    );
    expect(all).toContain("window = ((record.grace_period) * 86400000) + ((30) * 60000)");
    expect(all).toContain("doubled = ((1) * 86400000) * 2");
    expect(all).toContain("span < window + doubled");
  });

  it("binds a param referenced only inside a duration amount (usage probe descends)", async () => {
    const files = await load();
    const all = allElixir(files);
    // `extend(n)` uses `n` ONLY as `days(n)` — the param-usage probe must
    // descend into the duration node or the `Map.get` binding line is
    // dropped and the body references an unbound `n`.
    expect(all).toContain('n = Map.get(params, "n")');
    expect(all).toContain("DateTime.add(record.due_date, ((n) * 86400000), :millisecond)");
  });

  it("lowers column-side datetime ± duration to an Ecto make_interval fragment", async () => {
    const files = await load();
    const repo = fileEndingWith(files, "/invoice_repository.ex");
    expect(repo).toContain('fragment("? + make_interval(days => ?)", record.due_date, (30)) < ^q');
    // Param amount pins; a bare `now()` comparand pins too (a naked
    // `DateTime.utc_now()` is not a valid Ecto query expression).
    expect(repo).toContain(
      'fragment("? - make_interval(hours => ?)", record.due_date, (^n)) < ^DateTime.utc_now()',
    );
    // months in where-position uses make_interval(months => …) — Postgres
    // does the calendar arithmetic natively.
    expect(repo).toContain(
      'fragment("? + make_interval(months => ?)", record.created_at, (1)) >= ^q',
    );
  });

  it("value-side datetime ± duration also lowers (fragment side, param pins)", async () => {
    const files = await generateSystemFiles(`
      system Api {
        subdomain Core {
          context Billing {
            aggregate Invoice with crudish { dueDate: datetime }
            repository Invoices for Invoice {
              find w(q: datetime): Invoice[] where this.dueDate < q + days(2)
            }
          }
        }
        api BillingApi from Core
        storage pg { type: postgres }
        resource st { for: Billing, kind: state, use: pg }
        deployable api {
          platform: elixir
          contexts: [Billing]
          dataSources: [st]
          serves: BillingApi
          port: 4000
        }
      }
    `);
    const repo = fileEndingWith(files, "/invoice_repository.ex");
    expect(repo).toContain('record.due_date < fragment("? + make_interval(days => ?)", ^q, (2))');
  });
});

// ---------------------------------------------------------------------------
// Direct renderExpr unit arms — the phoenix-render-expr.test.ts style, so a
// regression names the exact leaf/arm instead of a whole-file diff.
// ---------------------------------------------------------------------------

const DATETIME: TypeIR = { kind: "primitive", name: "datetime" };
const DURATION: TypeIR = { kind: "primitive", name: "duration" };
const ctx = { thisName: "record", contextModule: "MyApp" };
const filterCtx = { ...ctx, filterArgs: true };
const docCtx = { ...ctx, docStruct: true };

const litInt = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const dur = (unit: "days" | "hours" | "minutes" | "months", n: string): ExprIR => ({
  kind: "duration",
  unit,
  amount: litInt(n),
});
const dtProp = (name: string): ExprIR => ({
  kind: "ref",
  name,
  refKind: "this-prop",
  type: DATETIME,
});

describe("phoenix renderExpr — A5 temporal arms", () => {
  it("renders the absolute-duration constructors as integer milliseconds", () => {
    expect(renderExpr(dur("days", "30"), ctx)).toBe("((30) * 86400000)");
    expect(renderExpr(dur("hours", "6"), ctx)).toBe("((6) * 3600000)");
    expect(renderExpr(dur("minutes", "45"), ctx)).toBe("((45) * 60000)");
  });

  it("renders datetime + duration via DateTime.add/:millisecond", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "+",
      left: dtProp("due"),
      right: dur("hours", "6"),
      leftType: DATETIME,
      resultType: DATETIME,
    };
    expect(renderExpr(e, ctx)).toBe("DateTime.add(record.due, ((6) * 3600000), :millisecond)");
  });

  it("renders datetime - duration with the sign folded into the amount", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "-",
      left: dtProp("due"),
      right: dur("minutes", "45"),
      leftType: DATETIME,
      resultType: DATETIME,
    };
    expect(renderExpr(e, ctx)).toBe("DateTime.add(record.due, -(((45) * 60000)), :millisecond)");
  });

  it("renders the commuted duration + datetime form", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "+",
      left: dur("days", "2"),
      right: dtProp("due"),
      leftType: DURATION,
      resultType: DATETIME,
    };
    expect(renderExpr(e, ctx)).toBe("DateTime.add(record.due, ((2) * 86400000), :millisecond)");
  });

  it("renders datetime − datetime as DateTime.diff/:millisecond", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "-",
      left: dtProp("a"),
      right: dtProp("b"),
      leftType: DATETIME,
      resultType: DURATION,
    };
    expect(renderExpr(e, ctx)).toBe("DateTime.diff(record.a, record.b, :millisecond)");
  });

  it("renders duration algebra and int scaling as native integer operators", () => {
    const algebra: ExprIR = {
      kind: "binary",
      op: "+",
      left: dur("days", "1"),
      right: dur("hours", "2"),
      leftType: DURATION,
      resultType: DURATION,
    };
    expect(renderExpr(algebra, ctx)).toBe("((1) * 86400000) + ((2) * 3600000)");
    const scaled: ExprIR = {
      kind: "binary",
      op: "*",
      left: dur("days", "1"),
      right: litInt("2"),
      leftType: DURATION,
      resultType: DURATION,
    };
    expect(renderExpr(scaled, ctx)).toBe("((1) * 86400000) * 2");
  });

  it("renders datetime ± months(n) through the hand-rolled calendar shift", () => {
    const plus: ExprIR = {
      kind: "binary",
      op: "+",
      left: dtProp("due"),
      right: dur("months", "1"),
      leftType: DATETIME,
      resultType: DATETIME,
    };
    expect(renderExpr(plus, ctx)).toBe(`${CALENDAR_PLUS_1}.(record.due)`);
  });

  it("the document (docStruct) path keeps the in-memory arms — no fragment", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "+",
      left: dtProp("due"),
      right: dur("days", "30"),
      leftType: DATETIME,
      resultType: DATETIME,
    };
    expect(renderExpr(e, docCtx)).toBe("DateTime.add(record.due, ((30) * 86400000), :millisecond)");
  });

  it("the Ecto filter path renders make_interval fragments for all four units", () => {
    const mk = (unit: "days" | "hours" | "minutes" | "months", op: "+" | "-"): ExprIR => ({
      kind: "binary",
      op,
      left: dtProp("due"),
      right: dur(unit, "3"),
      leftType: DATETIME,
      resultType: DATETIME,
    });
    expect(renderExpr(mk("days", "+"), filterCtx)).toBe(
      'fragment("? + make_interval(days => ?)", record.due, (3))',
    );
    expect(renderExpr(mk("hours", "-"), filterCtx)).toBe(
      'fragment("? - make_interval(hours => ?)", record.due, (3))',
    );
    expect(renderExpr(mk("minutes", "+"), filterCtx)).toBe(
      'fragment("? + make_interval(mins => ?)", record.due, (3))',
    );
    expect(renderExpr(mk("months", "+"), filterCtx)).toBe(
      'fragment("? + make_interval(months => ?)", record.due, (3))',
    );
  });

  it("routes in-memory datetime order comparisons through DateTime.compare/2", () => {
    const cmp = (op: "<" | "<=" | ">" | ">="): ExprIR => ({
      kind: "binary",
      op,
      left: dtProp("a"),
      right: dtProp("b"),
      leftType: DATETIME,
    });
    expect(renderExpr(cmp("<"), ctx)).toBe("DateTime.compare(record.a, record.b) == :lt");
    expect(renderExpr(cmp("<="), ctx)).toBe("DateTime.compare(record.a, record.b) in [:lt, :eq]");
    expect(renderExpr(cmp(">"), ctx)).toBe("DateTime.compare(record.a, record.b) == :gt");
    expect(renderExpr(cmp(">="), ctx)).toBe("DateTime.compare(record.a, record.b) in [:gt, :eq]");
    // Inside an Ecto query the native operator lowers to SQL — no compare/2.
    expect(renderExpr(cmp("<"), filterCtx)).toBe("record.a < record.b");
  });

  it("pins a bare now() comparand inside an Ecto filter", () => {
    const e: ExprIR = {
      kind: "binary",
      op: "<",
      left: dtProp("due"),
      right: { kind: "literal", lit: "now", value: "" },
    };
    expect(renderExpr(e, filterCtx)).toBe("record.due < ^DateTime.utc_now()");
  });
});

describe("renderTypespec — A5 duration", () => {
  it("maps the expression-only duration primitive to integer() (milliseconds)", () => {
    expect(renderTypespec({ kind: "primitive", name: "duration" } as TypeIR, "MyApp.Billing")).toBe(
      "integer()",
    );
  });
});
