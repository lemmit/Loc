// Array-typed page state (`state { xs: string[] }`).
//
// Two separate defects, one per side of the `useState<T>(init)` declaration:
//
//   - the TS TYPE fell through to `any` — which silently disables type
//     checking on every read of the field, so the `generated-react-build`
//     tsc gate could not catch a bug behind it;
//   - the ZERO VALUE fell through to `undefined` — so a page with no `=`
//     initializer mounted the field as `undefined` and the first `.map` /
//     `.length` in the body threw at runtime.
//
// The store emitters already special-cased the array zero value
// (`storeFieldInit`), so the store and page-state paths disagreed for the same
// declared type.  The fix lives in the SHARED `defaultInitForJs`, so every
// JS-family frontend gets the same zero value.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const DOMAIN = `
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
`;

/** Generate one page carrying `state` plus a `body` that REFERENCES it.
 *
 *  The body reference is load-bearing: a page-state field no expression reads
 *  or writes is dropped from the emitted component entirely, so a fixture with
 *  an inert body silently asserts nothing. */
async function genPage(
  state: string,
  body: string,
  platform: "static" | "svelte" = "static",
  action = "",
): Promise<string> {
  const files = await generateSystemFiles(`
    system S {
      ${DOMAIN}
      ui WebApp {
        api Sales: SalesApi
        page X {
          route: "/x"
          ${state}
          ${action}
          body: ${body}
        }
      }
      storage loomDb { type: postgres }
      resource ordersState { for: Orders, kind: state, use: loomDb }
      deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], serves: SalesApi, port: 3000 }
      deployable web {
        platform: ${platform === "svelte" ? "svelte" : "static"},
        targets: api, ui: WebApp { Sales: api }, port: 3001
      }
    }
  `);
  const key = [...files.keys()].find((k) => /\/(x\.tsx|\+page\.svelte)$/.test(k));
  if (!key) throw new Error(`page not found; have:\n${[...files.keys()].join("\n")}`);
  return files.get(key)!;
}

/** A body that writes the named array field, so it survives into the output —
 *  through a named `action`, the only form that may carry an effect
 *  (`loom.effect-in-lambda`).  Returns the body; `writesArrayAction` is its
 *  matching `action` declaration. */
const writesArray = (): string => `Stack { Button("pick", onClick: pick) }`;
const writesArrayAction = (field: string, lit: string): string =>
  `action pick() { ${field} := ${lit} }`;

describe("array-typed page state — React", () => {
  it("declares the element type and seeds the empty array", async () => {
    const page = await genPage(
      `state { selectedIds: string[] }`,
      writesArray(),
      "static",
      writesArrayAction("selectedIds", `["a"]`),
    );
    expect(page).toContain("const [selectedIds, setSelectedIds] = useState<string[]>([]);");
    // `any` defeats the tsc build gate on every read of the field; `undefined`
    // means the first `.map`/`.length` in a page body throws.
    expect(page).not.toContain("useState<any>");
    expect(page).not.toContain("useState<string[]>(undefined)");
  });

  it("maps the element type through, not just string", async () => {
    const page = await genPage(
      `state { tiers: int[] }`,
      writesArray(),
      "static",
      writesArrayAction("tiers", "[1]"),
    );
    expect(page).toContain("useState<number[]>([])");
  });

  it("leaves scalar state untouched", async () => {
    const page = await genPage(
      `state { note: string = "hi"  n: int }`,
      `Stack { Text { note }, Button("inc", onClick: inc) }`,
      "static",
      `action inc() { n := n + 1 }`,
    );
    expect(page).toContain(`const [note, setNote] = useState<string>("hi");`);
    expect(page).toContain("const [n, setN] = useState<number>(0);");
  });
});

describe("array-typed page state — Svelte", () => {
  it("declares the element type, not `any`", async () => {
    const page = await genPage(
      `state { selectedIds: string[] }`,
      writesArray(),
      "svelte",
      writesArrayAction("selectedIds", `["a"]`),
    );
    expect(page).toContain("string[]");
    expect(page).not.toContain(": any");
  });
});
