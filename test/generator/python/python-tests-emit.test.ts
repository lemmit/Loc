import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — `test "…" { … }` blocks → pytest (plan S5).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/shell.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python test emission", () => {
  it("emits one pytest function per test block, slugged from the name", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain("def test_widget_activates_from_draft() -> None:");
    expect(tests).toContain("def test_activate_requires_draft() -> None:");
    expect(tests).toContain("def test_price_invariant_rejects_short_currency() -> None:");
  });

  it("coerces create-input literals: kwargs, enum refs, positional VO ctor", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain(
      'w = Widget.create(label="gizmo", size=1, status=WidgetStatus.Draft, price=Price(1.0, "USD"))',
    );
  });

  it("maps comparison matchers onto operators and expectThrows onto pytest.raises", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain("    assert w.status == WidgetStatus.Active");
    expect(tests).toContain("    assert w.size > 0");
    expect(tests).toContain("    with pytest.raises(Exception):");
    expect(tests).toContain("        w.activate()");
  });

  it("emits no test file for aggregates without test blocks", async () => {
    const files = await build();
    const testFiles = [...files.keys()].filter((k) => k.startsWith("api/tests/"));
    expect(testFiles).toEqual(["api/tests/test_widget.py"]);
  });
});

// M-T6.44 (numeric-types audit): Python CHAINS comparisons — `a == b == True`
// parses as `(a == b) and (b == True)`, so a matcher whose ACTUAL is itself a
// comparison must be parenthesized or the emitted assert silently tests the
// wrong thing (found by the numeric-operands fixture: `Decimal("7.5") == True`
// is False, so the case failed while every value was correct).
describe("python test emission — comparison-shaped actuals are parenthesized", () => {
  it("wraps a comparison actual so the assert cannot chain", async () => {
    const src = `
system S {
  subdomain M {
    context C {
      aggregate Order {
        count: int
        factor: decimal
        test "comparison inside a matcher" {
          let o = Order.create({ count: 3, factor: 2.5 })
          expect(o.count < o.factor).toBe(false)
        }
      }
      repository Orders for Order { }
    }
  }
  api A from M
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d { platform: python contexts: [C] dataSources: [st] serves: A port: 4000 }
}
`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(errors.join("\n"));
    const files = generateSystems(model).files;
    const tests = [...files.entries()].find(([p]) => /tests\/test_order\.py$/.test(p))?.[1];
    expect(tests).toBeDefined();
    expect(tests!).toContain("assert (o.count < o.factor) == False");
    // The defect, stated so a regression reads as itself: unparenthesized,
    // Python evaluates `o.factor == False` — always False for a Decimal.
    expect(tests!).not.toContain("assert o.count < o.factor == False");
  });
});
