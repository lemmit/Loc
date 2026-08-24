// ---------------------------------------------------------------------------
// `money` on Flutter — the whole contract in one place (M-T1.21).
//
// Money is the RS-12 wire STRING here, not a Dart `double`: `NUMERIC(19,4)` is
// 19 significant digits and a binary float carries ~15-17, so any number-typed
// representation either loses the top of the range or drifts at the bottom.
// Dart's SDK ships no decimal type and this design deliberately adds no pub
// dependency, so arithmetic/comparison/intrinsics route through a generated
// `lib/money.dart` (`LoomMoney`) over BigInt scaled units.
//
// `decimal` is the control THROUGHOUT: it rides the wire as a JSON number, is a
// real Dart `double`, and every decimal arm below must stay untouched.  The
// wire codec itself (decode/encode/identity) is pinned next door in
// `money-wire-roundtrip.test.ts`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  coerceDartMoneyInit,
  DART_LEAVES,
  dartMoneyBinary,
  dartMoneyLiteral,
  dartZeroValue,
  renderDartIntrinsic,
} from "../../../src/generator/flutter/dart-expr.js";
import {
  renderFlutterMoneyRuntime,
  usesMoney,
} from "../../../src/generator/flutter/money-runtime.js";
import type { ExprIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const money: TypeIR = { kind: "primitive", name: "money" } as TypeIR;
const decimal: TypeIR = { kind: "primitive", name: "decimal" } as TypeIR;

const binary = (
  op: string,
  leftType: TypeIR,
  rightType: TypeIR,
): Extract<ExprIR, { kind: "binary" }> =>
  ({ kind: "binary", op, leftType, rightType }) as Extract<ExprIR, { kind: "binary" }>;

// ---------------------------------------------------------------------------
// Literals, zero, state seeds
// ---------------------------------------------------------------------------

describe("money literals are Dart strings at the wire scale", () => {
  it("pads a literal's own digits — no float hop", () => {
    expect(dartMoneyLiteral("12.5")).toBe("'12.5000'");
    expect(dartMoneyLiteral("0")).toBe("'0.0000'");
    expect(dartMoneyLiteral("-3.25")).toBe("'-3.2500'");
    expect(dartMoneyLiteral(".5")).toBe("'0.5000'");
  });

  it("keeps a literal that already carries MORE digits than the wire scale", () => {
    // Truncating here would silently drop digits the author wrote; the backend
    // accepts any scale on the way in and quantizes at the column.
    expect(dartMoneyLiteral("1.234567")).toBe("'1.234567'");
  });

  it("the `money` literal KIND renders through it", () => {
    expect(DART_LEAVES.literal("money", "7.5")).toBe("'7.5000'");
    // CONTROL: a decimal literal is still a bare Dart number.
    expect(DART_LEAVES.literal("decimal", "7.5")).toBe("7.5");
  });

  it("an initless money cell seeds the WIRE zero, not 0.0", () => {
    expect(dartZeroValue(money)).toBe("'0.0000'");
    expect(dartZeroValue(decimal)).toBe("0.0");
  });

  it("a money cell seeded with a bare decimal literal is coerced to the string", () => {
    // `m: money = 1.50` lowers as a DECIMAL literal, which renders as `1.50` —
    // a `double` seeded into a `String` cell, which does not compile.
    expect(coerceDartMoneyInit(money, "1.50")).toBe("'1.5000'");
    expect(coerceDartMoneyInit(money, "-0.01")).toBe("'-0.0100'");
    // Already a money expression → untouched (byte-identical).
    expect(coerceDartMoneyInit(money, "LoomMoney.normalize('2.50')")).toBe(
      "LoomMoney.normalize('2.50')",
    );
    expect(coerceDartMoneyInit(money, "'2.5000'")).toBe("'2.5000'");
    // CONTROL: a decimal cell keeps its number.
    expect(coerceDartMoneyInit(decimal, "1.50")).toBe("1.50");
  });
});

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

describe("money conversions never go through a bare double", () => {
  it("into money", () => {
    expect(DART_LEAVES.convert("s", "money", "string")).toBe("LoomMoney.normalize(s)");
    expect(DART_LEAVES.convert("n", "money", "int")).toBe("LoomMoney.fromNum(n)");
  });

  it("out of money", () => {
    // A money value already IS a String — `.toString()` would be a no-op and
    // `int.parse('12.5000')` would THROW.
    expect(DART_LEAVES.convert("m", "string", "money")).toBe("m");
    expect(DART_LEAVES.convert("m", "int", "money")).toBe("LoomMoney.toNum(m).toInt()");
    expect(DART_LEAVES.convert("m", "decimal", "money")).toBe("LoomMoney.toNum(m).toDouble()");
  });

  it("CONTROL: decimal conversions are unchanged", () => {
    expect(DART_LEAVES.convert("s", "decimal", "string")).toBe("double.parse(s)");
    expect(DART_LEAVES.convert("n", "decimal", "int")).toBe("(n).toDouble()");
    expect(DART_LEAVES.convert("d", "string", "decimal")).toBe("d.toString()");
  });
});

// ---------------------------------------------------------------------------
// Binary operators — the seam
// ---------------------------------------------------------------------------

describe("money binaries route through LoomMoney", () => {
  it("arithmetic", () => {
    // `+` on two Dart Strings CONCATENATES — silently wrong, not a compile error.
    expect(dartMoneyBinary("a", "b", binary("+", money, money))).toBe("LoomMoney.add(a, b)");
    expect(dartMoneyBinary("a", "b", binary("-", money, money))).toBe("LoomMoney.sub(a, b)");
    expect(dartMoneyBinary("a", "n", binary("*", money, decimal))).toBe("LoomMoney.mul(a, n)");
    expect(dartMoneyBinary("a", "n", binary("/", money, decimal))).toBe("LoomMoney.div(a, n)");
    // An int on the LEFT still dispatches — the money side may be either.
    expect(dartMoneyBinary("n", "a", binary("*", decimal, money))).toBe("LoomMoney.mul(n, a)");
  });

  it("comparisons compare VALUES, not text", () => {
    expect(dartMoneyBinary("a", "b", binary("<", money, money))).toBe(
      "(LoomMoney.compare(a, b) < 0)",
    );
    expect(dartMoneyBinary("a", "b", binary(">=", money, money))).toBe(
      "(LoomMoney.compare(a, b) >= 0)",
    );
    // `'1.5' == '1.5000'` is false as text and true as money.
    expect(dartMoneyBinary("a", "b", binary("==", money, money))).toBe(
      "(LoomMoney.compare(a, b) == 0)",
    );
    expect(dartMoneyBinary("a", "b", binary("!=", money, money))).toBe(
      "(LoomMoney.compare(a, b) != 0)",
    );
  });

  it("sees through an optional money operand", () => {
    const opt: TypeIR = { kind: "optional", inner: money } as TypeIR;
    expect(dartMoneyBinary("a", "b", binary("+", opt, money))).toBe("LoomMoney.add(a, b)");
  });

  it("CONTROL: a money-free binary falls through to the plain operator leaf", () => {
    expect(dartMoneyBinary("a", "b", binary("+", decimal, decimal))).toBeNull();
    expect(dartMoneyBinary("a", "b", binary("&&", decimal, decimal))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Intrinsics
// ---------------------------------------------------------------------------

describe("money intrinsics are exact, decimal's stay double math", () => {
  const r = (recv: string, member: string, args: string[] = []) =>
    renderDartIntrinsic(money, member, recv, args);

  it("the six money arms call the runtime", () => {
    expect(r("m", "abs")).toBe("LoomMoney.abs(m)");
    expect(r("m", "min", ["o"])).toBe("LoomMoney.min(m, o)");
    expect(r("m", "max", ["o"])).toBe("LoomMoney.max(m, o)");
    expect(r("m", "round")).toBe("LoomMoney.round(m)");
    expect(r("m", "round", ["2"])).toBe("LoomMoney.round(m, 2)");
    expect(r("m", "floor")).toBe("LoomMoney.floor(m)");
    expect(r("m", "ceil")).toBe("LoomMoney.ceil(m)");
  });

  it("CONTROL: the decimal arms are untouched double math", () => {
    expect(renderDartIntrinsic(decimal, "floor", "d", [])).toBe("(d.floorToDouble())");
    expect(renderDartIntrinsic(decimal, "min", "d", ["o"])).toBe("(math.min(d, o))");
  });
});

// ---------------------------------------------------------------------------
// The emitted runtime + its import wiring
// ---------------------------------------------------------------------------

describe("lib/money.dart", () => {
  it("derives its scale and zero from the one wire constant", () => {
    const dart = renderFlutterMoneyRuntime();
    expect(dart).toContain("static const int scale = 4;");
    expect(dart).toContain("static const String zero = '0.0000';");
    // The exact core is BigInt units — not a double anywhere in the arithmetic.
    expect(dart).toContain("static BigInt units(Object? v)");
    expect(dart).toContain(
      "static String add(Object? a, Object? b) => _fromUnits(units(a) + units(b));",
    );
    // …and no pub dependency: BigInt is core Dart.
    expect(dart).not.toContain("package:decimal");
  });

  it("is emitted (with the matching import) exactly when a page uses it", async () => {
    const withMoney = await generateSystemFiles(SYS_MONEY);
    expect(withMoney.get("app/lib/money.dart")).toBeDefined();
    const page = withMoney.get("app/lib/pages/home_page.dart")!;
    expect(usesMoney(page)).toBe(true);
    expect(page).toContain("import '../money.dart';");

    // A money-free app carries neither the file nor a dangling import.
    const without = await generateSystemFiles(SYS_NO_MONEY);
    expect(without.get("app/lib/money.dart")).toBeUndefined();
    for (const [path, content] of without) {
      if (path.endsWith(".dart")) expect(content).not.toContain("money.dart");
    }
  });
});

/** The same app with no `money` anywhere — the negative control for the
 *  on-demand emission (an unused Dart import is an analyzer warning, and a
 *  dangling one is a compile error). */
const SYS_NO_MONEY = `
system PlainUi {
  subdomain S { context Ops {
    aggregate Product { name: string  price: int }
    repository Products for Product { } } }
  api OpsApi from S
  storage pg { type: postgres }
  resource st { for: Ops, kind: state, use: pg }
  ui App {
    framework: flutter
    api Ops: OpsApi
    page Home {
      route: "/"
      state { budget: int = 12 }
      action raise() { budget := budget + 2 }
      body: Stack { Text { budget }, Button { "Raise", onClick: raise } }
    }
  }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Ops: api } port: 3006 }
}`;

const SYS_MONEY = `
system MoneyUi {
  subdomain S { context Ops {
    aggregate Product { name: string  price: money }
    repository Products for Product { } } }
  api OpsApi from S
  storage pg { type: postgres }
  resource st { for: Ops, kind: state, use: pg }
  ui App {
    framework: flutter
    api Ops: OpsApi
    page Home {
      route: "/"
      state { budget: money = 12.5 }
      action raise() { budget := budget + money("2.50") }
      body: Stack { Money { budget }, Button { "Raise", onClick: raise } }
    }
  }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Ops: api } port: 3006 }
}`;

describe("money through the emitted page", () => {
  it("seeds, adds and DISPLAYS money without ever touching a double", async () => {
    const page = (await generateSystemFiles(SYS_MONEY)).get("app/lib/pages/home_page.dart")!;
    expect(page).toContain("final String budget;");
    expect(page).toContain("HomeState(budget: '12.5000')");
    expect(page).toContain("budget: LoomMoney.add(state.budget, '2.5000')");
    // The display parses ONLY to format — `NumberFormat.format` takes a `num`.
    expect(page).toContain("format(LoomMoney.toNum(state.budget))");
  });

  it("a NumberField bound to a money cell still has a setter behind it", async () => {
    const page = (
      await generateSystemFiles(
        SYS_MONEY.replace(
          `body: Stack { Money { budget }, Button { "Raise", onClick: raise } }`,
          `body: Stack { NumberField { "Budget", bind: budget } }`,
        ),
      )
    ).get("app/lib/pages/home_page.dart")!;
    // The pack dispatches to `set<Field>Text`; keying the parse on the DART TYPE
    // (where money now spells `String`) would have emitted no such method.
    expect(page).toContain("setBudgetText(v)");
    expect(page).toContain("void setBudgetText(String v)");
    expect(page).toContain("state.copyWith(budget: v.trim())");
  });
});

// ---------------------------------------------------------------------------
// Client-side Table sort
// ---------------------------------------------------------------------------

const SYS_TABLE = `
system Shop {
  subdomain Sales { context Orders {
    aggregate Product { name: string  price: money  rate: decimal }
    repository Products for Product { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    framework: flutter
    api Shop: ShopApi
    page List {
      route: "/products"
      state { sortKey: string = ""  sortDir: string = "asc" }
      body: QueryView { of: Shop.Product.all,
        loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
        data: rows => Table(
          Column("Name", p => p.name, sortable: true),
          Column("Price", p => p.price, sortable: true),
          Column("Rate", p => p.rate, sortable: true),
          rows: rows, sortKey: sortKey, sortDir: sortDir) }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

describe("a money column sorts by VALUE", () => {
  it("compares money through the runtime and everything else as a Comparable", async () => {
    const page = (await generateSystemFiles(SYS_TABLE)).get("app/lib/pages/list_page.dart")!;
    // Money is a String here, so the `Comparable` arm would order '10.0000'
    // BEFORE '9.0000' — a silently wrong table, not a crash.
    expect(page).toContain("'price' => LoomMoney.compare(a.price, b.price)");
    // CONTROL: a `decimal` column is a real Dart `double` and keeps the plain
    // comparator — routing it through the money runtime would re-quantize it.
    expect(page).toContain("'rate' => (a.rate as Comparable).compareTo(b.rate as Comparable)");
    expect(page).toContain("'name' => (a.name as Comparable).compareTo(b.name as Comparable)");
  });
});

// ---------------------------------------------------------------------------
// Persisted store cells
// ---------------------------------------------------------------------------

const SYS_STORE = `
system Persisted {
  subdomain S { context Ops {
    aggregate Product { name: string  price: money }
    repository Products for Product { } } }
  api OpsApi from S
  storage pg { type: postgres }
  resource st { for: Ops, kind: state, use: pg }
  ui App {
    framework: flutter
    api Ops: OpsApi
    store Cart persist: local {
      state { subtotal: money = 1.50  rate: decimal = 0.2 }
      action bump(extra: money) { subtotal := subtotal + extra }
    }
    page Home { route: "/"  body: Stack { Text { Cart.subtotal } } }
  }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Ops: api } port: 3006 }
}`;

describe("a persisted money cell stays the wire string across the storage boundary", () => {
  it("holds, reads and writes the string — matching what the JS frontends store", async () => {
    const stores = (await generateSystemFiles(SYS_STORE)).get("app/lib/stores.dart")!;
    expect(stores).toContain("final String subtotal;");
    expect(stores).toContain("if (raw == null) return '1.5000';");
    // Read tolerates a number in the blob (a hand edit) without wiping the cell.
    expect(stores).toContain("return raw is String ? raw : raw.toString();");
    // Write is identity — the blob shape the JS frontends' `Decimal.toJSON`
    // produces is exactly what this cell already holds.
    expect(stores).toContain("'subtotal': s.subtotal,");
    expect(stores).not.toContain("s.subtotal.toString()");
    // CONTROL: the decimal cell is still a `double` read as a number.
    expect(stores).toContain("final double rate;");
    expect(stores).toContain("import 'money.dart';");
  });
});
