import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// .NET test emission — a binary actual inside a matcher is parenthesized.
//
// `.Should()` is postfix member access, which binds tighter than every C#
// operator, so `a == b.Should().Be(true)` compares `a` to the assertion
// object and the generated project does not build (CS0019).  The C# twin of
// python's chained-comparison hazard (both found by the numeric-operands
// fixture, M-T6.44); Java is immune (its matcher arm always wraps
// `(${actual})`), Elixir is immune (`assert a < b == false` parses as
// `(a < b) == false`).
// ---------------------------------------------------------------------------

describe(".NET test emission — binary actuals inside matchers are parenthesized", () => {
  it("wraps a comparison actual before .Should()", async () => {
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
  deployable d { platform: dotnet contexts: [C] dataSources: [st] serves: A port: 4000 }
}
`;
    const files = await generateSystemFiles(src);
    const tests = [...files.entries()].find(([p]) => /Tests\/.*OrderTests\.cs$/.test(p))?.[1];
    expect(tests).toBeDefined();
    expect(tests!).toContain("(o.Count < o.Factor).Should().Be(false);");
    // The defect, stated so a regression reads as itself: unparenthesized, C#
    // parses this as `o.Count < (o.Factor.Should().Be(false))` — CS0019.
    expect(tests!).not.toContain("o.Count < o.Factor.Should()");
  });

  it("a member actual stays unwrapped (byte-identity for non-hazard shapes)", async () => {
    const src = `
system S {
  subdomain M {
    context C {
      aggregate Order {
        count: int
        test "member actual" {
          let o = Order.create({ count: 3 })
          expect(o.count).toBe(3)
        }
      }
      repository Orders for Order { }
    }
  }
  api A from M
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d { platform: dotnet contexts: [C] dataSources: [st] serves: A port: 4000 }
}
`;
    const files = await generateSystemFiles(src);
    const tests = [...files.entries()].find(([p]) => /Tests\/.*OrderTests\.cs$/.test(p))?.[1];
    expect(tests).toBeDefined();
    expect(tests!).toContain("o.Count.Should().Be(3);");
    expect(tests!).not.toContain("(o.Count).Should()");
  });
});
