// Scaffolded page `area` names must use `util/naming`'s plural/snake — the
// SAME single source of truth `classifyPage` (src/ir/util/page-kind.ts)
// consumes — so a scaffolded page's area matches the classifier's expectation
// for IRREGULAR plurals.
//
// From `docs/audits/repo-code-review-2026-07.md` C3: the scaffold macro carried
// hand-copied `plural`/`snake` helpers that had drifted from `util/naming`
// (`Box` → `Boxs` instead of `Boxes`, no `x/z/ch/sh` rule; `Day` → `Daies`
// instead of `Days`; no consecutive-capitals rule for `APIKey`).  Because
// `classifyPage` matches a page's `area` against `snake(plural(agg.name))` using
// the `util/naming` versions, the drift made List/New/Detail all classify as
// `custom` for such names — the Detail page never received its synthesized `id`
// route param, and the New-drop / list-create-button strip never fired.
//
// This pins that the emitted area (hence emitPath) uses the canonical plural.

import { describe, expect, it } from "vitest";
import { plural, snake } from "../../src/util/naming.js";
import { buildLoomModel } from "../_helpers/index.js";

const DDD = (agg: string, field: string) => `
  system Demo {
    subdomain Sales {
      context Store {
        aggregate ${agg} { ${field}: string derived display: string = ${field} }
        repository ${agg}s for ${agg} {}
      }
    }
    api StoreApi from Sales
    ui App with scaffold(aggregates: [${agg}]) {
      api Store: StoreApi
    }
    deployable api {
      platform: node
      contexts: [Store]
      serves: StoreApi
      port: 3000
    }
    deployable web {
      platform: static
      targets: api
      ui: App { Store: api }
      port: 3001
    }
  }
`;

async function areaOfList(agg: string, field: string): Promise<string[]> {
  const loom = await buildLoomModel(DDD(agg, field));
  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      const list = ui.pages.find((p) => p.name === "List");
      if (list) return list.area ?? [];
    }
  }
  throw new Error("List page not found");
}

describe("scaffold area names use canonical util/naming plural", () => {
  // `Box` → `boxes` (x → es), NOT the drifted `boxs`.
  it("pluralizes an -x aggregate the way classifyPage expects", async () => {
    const area = await areaOfList("Box", "code");
    expect(area).toEqual([snake(plural("Box"))]); // ["boxes"]
    expect(area).toContain("boxes");
    expect(area).not.toContain("boxs");
  });

  // `Day` (vowel + y) → `days`, NOT the drifted `daies`.
  it("does not apply y→ies after a vowel", async () => {
    const area = await areaOfList("Day", "note");
    expect(area).toEqual([snake(plural("Day"))]); // ["days"]
    expect(area).toContain("days");
    expect(area).not.toContain("daies");
  });

  // A regular name is unchanged by the consolidation (no churn).
  it("leaves regular names byte-identical", async () => {
    const area = await areaOfList("Order", "code");
    expect(area).toEqual(["orders"]);
  });
});
