import { describe, expect, it } from "vitest";
import { parseDdd } from "../../web/src/builder/parse.js";
import { REFUSAL_WHY, refusalMessage } from "../../web/src/builder/refusal.js";
import { addConstructSource, addSystemExtraSource } from "../../web/src/builder/system/add.js";
import { addContextExtraSource } from "../../web/src/builder/system-v2/add-extra.js";
import { paletteBlockers } from "../../web/src/builder/system-v2/add-palette-blockers.js";

// The model builder's "+" palette (M-T8.17 slice 4, audit H10): an entry whose
// template needs a cross-reference the model lacks used to be a live button
// that no-op'd.  `paletteBlockers` is the pure predicate the palette renders
// as "disabled + reason"; what is pinned here is that it mirrors the add
// helpers' null paths EXACTLY — blocked ⇔ the add would return null — so the
// tooltip never lies in either direction.

const BARE = `system S {
  subdomain Sales {
    context Orders {
    }
  }
}`;

const FULL = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
        total: int
      }
      event OrderPlaced {
      }
    }
  }
  storage db {
    type: postgres
  }
}`;

describe("paletteBlockers — system view", () => {
  it("names the missing prerequisite for each blocked entry on a bare model", () => {
    const b = paletteBlockers(parseDdd(BARE).ast, [{ kind: "system", name: "S" }]);
    expect(b.get("api")).toBeUndefined(); // a subdomain exists
    expect(b.get("resource")).toMatch(/storage/);
    expect(b.get("channelSource")).toMatch(/channel/);
    expect(b.get("timerSource")).toMatch(/event/);
    expect(b.has("capability")).toBe(false);
  });

  it("blocked ⇔ the add helper returns null", () => {
    const ast = parseDdd(BARE).ast;
    const b = paletteBlockers(ast, [{ kind: "system", name: "S" }]);
    for (const kind of ["resource", "channelSource", "timerSource", "capability"] as const) {
      const wouldFail = addSystemExtraSource(BARE, kind) === null;
      expect(b.has(kind), kind).toBe(wouldFail);
    }
    expect(b.has("api")).toBe(addConstructSource(BARE, "api") === null);
  });

  it("an api entry is blocked when no subdomain exists", () => {
    const src = "system S {\n}";
    const b = paletteBlockers(parseDdd(src).ast, [{ kind: "system", name: "S" }]);
    expect(b.get("api")).toMatch(/subdomain/);
    expect(addConstructSource(src, "api")).toBeNull();
  });
});

describe("paletteBlockers — context view", () => {
  it("repository needs an aggregate, channel needs an event — in THIS context", () => {
    const b = paletteBlockers(parseDdd(BARE).ast, [
      { kind: "system", name: "S" },
      { kind: "subdomain", name: "Sales" },
      { kind: "context", name: "Orders" },
    ]);
    expect(b.get("repository")).toMatch(/aggregate/);
    expect(b.get("channel")).toMatch(/event/);
    expect(addConstructSource(BARE, "repository", { context: "Orders" })).toBeNull();
    expect(addContextExtraSource(BARE, "Orders", "channel")).toBeNull();
  });

  it("nothing is blocked once the prerequisites exist", () => {
    const path = [
      { kind: "system", name: "S" },
      { kind: "subdomain", name: "Sales" },
      { kind: "context", name: "Orders" },
    ] as const;
    const b = paletteBlockers(parseDdd(FULL).ast, [...path]);
    expect([...b.keys()]).toEqual([]);
    expect(addConstructSource(FULL, "repository", { context: "Orders" })).not.toBeNull();
    expect(addContextExtraSource(FULL, "Orders", "channel")).not.toBeNull();
    const sys = paletteBlockers(parseDdd(FULL).ast, [{ kind: "system", name: "S" }]);
    expect(sys.has("resource")).toBe(false);
    expect(sys.has("timerSource")).toBe(false);
  });
});

describe("refusal message", () => {
  it("names the construct and the reason; the bare line is the fallback", () => {
    expect(refusalMessage({ what: "aggregate Order", why: REFUSAL_WHY.noParse })).toBe(
      `aggregate Order: ${REFUSAL_WHY.noParse}`,
    );
    expect(refusalMessage(null)).toMatch(/not written/);
  });
});
