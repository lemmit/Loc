import { describe, expect, it } from "vitest";
import { middleEllipsis, needsEllipsis } from "../../web/src/util/middle-ellipsis.js";

// Middle-ellipsis truncation (M-T8.21 slice 3, audit M17): a path keeps its
// END (the distinguishing part) and its start, dropping the middle.

describe("middleEllipsis", () => {
  it("leaves short strings alone", () => {
    expect(middleEllipsis("order.ts", 20)).toBe("order.ts");
    expect(middleEllipsis("", 5)).toBe("");
    expect(needsEllipsis("order.ts", 20)).toBe(false);
  });

  it("keeps both ends and puts the ellipsis in the middle", () => {
    const out = middleEllipsis("src/domain/sales/order.ts", 15);
    expect(out).toBe("src/dom…rder.ts");
    expect(Array.from(out).length).toBe(15);
    expect(needsEllipsis("src/domain/sales/order.ts", 14)).toBe(true);
  });

  it("the tail keeps the extra character when the budget is odd", () => {
    expect(middleEllipsis("abcdefghij", 5)).toBe("ab…ij");
    expect(middleEllipsis("abcdefghij", 6)).toBe("ab…hij");
  });

  it("counts code points, not UTF-16 units", () => {
    const s = "😀😀😀😀😀😀😀😀";
    expect(middleEllipsis(s, 8)).toBe(s);
    expect(middleEllipsis(s, 5)).toBe("😀😀…😀😀");
  });

  it("degrades to the ellipsis alone under a 3-character budget", () => {
    expect(middleEllipsis("abcdef", 2)).toBe("…");
  });
});
