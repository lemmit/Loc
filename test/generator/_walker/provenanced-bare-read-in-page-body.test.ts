// ---------------------------------------------------------------------------
// `provenanced-bare-read-in-page-body` (wave-1 ledger row, closed by wave-2
// residue) — a HAND-WRITTEN page body reading a `provenanced` field bare
// (`row.total`, not `row.total.value`) must get the `.value` hop, same as a
// scaffolded body already does.
//
// `provenance-info-cross-target.test.ts` (sibling file) pins the SCAFFOLDED
// half — `scaffoldDetails` builds its body with the `.value` hop spelled out
// by `_body-builders.ts`, so it never exercises the auto-unwrap path at all.
// This file pins the other half: a page the user writes by hand, whose body
// the walker (`src/generator/_walker/walker-core.ts`, `emitMemberAccess` /
// `isProvenancedCarrierRead`) must unwrap on its own — the wire type is the
// `{ value, lineage }` carrier (M-T6.12), so a bare read puts the whole
// object into a text slot: TS2322 on the JSX targets, a stringified record on
// Feliz/Flutter, with no diagnostic anywhere to catch it.
//
// Verified LANDED on this base (re-derived per the wave-1 hand-off's exact
// patch shape, `docs/new-plan/waves/handoffs/wave-1-python-macros.md`): the
// `isProvenancedCarrierRead` mirror of HEEx's `provenancedFieldNames(ctx)`
// already sits in `emitExpr`'s `case "member":` / `emitMemberAccess`. This
// test is the missing PIN — nothing in the suite exercised a hand-written
// (non-scaffold) body reading a provenanced field before it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const HOST: Record<string, string> = {
  react: "static",
  vue: "static",
  svelte: "static",
  feliz: "feliz",
  flutter: "flutter",
};

const sys = (framework: string) => `
system ProvBody {
  subdomain Ordering {
    context Ordering {
      aggregate Order {
        reference: string
        total: int provenanced
        create(reference: string) { }
        operation reprice(t: int) { total := t }
      }
      repository Orders for Order { }
    }
  }
  ui Web {
    framework: ${framework}
    api Ops: OrdersApi
    page OrderDetail(id: Order id) {
      route: "/orders/:id"
      body: Stack {
        QueryView {
          of: Ops.Order.byId(id),
          single: true,
          data: row => Card {
            Text { row.reference },
            Text { row.total },
            Text { row.total.value }
          }
        }
      }
    }
  }
  api OrdersApi from Ordering
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: node, contexts: [Ordering], dataSources: [orderingState], serves: OrdersApi, port: 4100
  }
  deployable web {
    platform: ${HOST[framework]}, targets: api, ui: Web { Ops: api }, port: 4101
  }
}
`;

/** The page's own rendered source, across the frameworks whose UI is a
 *  static bundle (react/vue/svelte, all hosted by `platform: static`
 *  dispatching on `framework:`) plus the two non-bundle self-hosts. */
async function pageSource(framework: string, ext: string): Promise<string> {
  const files = await generateSystemFiles(sys(framework));
  // SvelteKit routes by file-system path (`routes/.../[id]/+page.svelte`),
  // not by a `<page-name>.svelte` filename like the other bundle targets.
  const key = [...files.keys()].find((p) =>
    framework === "svelte"
      ? p.startsWith("web/src/routes/") && p.endsWith(`+page.${ext}`)
      : p.startsWith("web/") && p.endsWith(`order_detail.${ext}`),
  );
  expect(key, `${framework} page file emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("provenanced-bare-read-in-page-body — react", () => {
  it("auto-unwraps the bare read to `.value`, leaves the explicit hop single, and leaves a plain field untouched", async () => {
    const src = await pageSource("react", "tsx");
    expect(src).toContain("{orderById.data.reference}");
    // Bare `row.total` gained the `.value` hop the wire carrier needs.
    expect(src).toContain("{orderById.data.total.value}");
    // The explicit `.value` did NOT double-hop to `.value.value`.
    expect(src).not.toContain("total.value.value");
    // Exactly two `.total.value` reads (bare + explicit), never a bare
    // `.total}` reaching the carrier object directly.
    const bareCarrier = src.match(/orderById\.data\.total\}/g) ?? [];
    expect(bareCarrier).toHaveLength(0);
    const hopped = src.match(/orderById\.data\.total\.value\}/g) ?? [];
    expect(hopped).toHaveLength(2);
  });
});

describe("provenanced-bare-read-in-page-body — vue", () => {
  it("auto-unwraps the bare read to `.value` in the template interpolation", async () => {
    const src = await pageSource("vue", "vue");
    expect(src).toContain("{{ orderById.data.reference }}");
    expect(src).toContain("{{ orderById.data.total.value }}");
    expect(src).not.toContain("total.value.value");
    const hopped = src.match(/orderById\.data\.total\.value \}\}/g) ?? [];
    expect(hopped).toHaveLength(2);
  });
});

describe("provenanced-bare-read-in-page-body — svelte", () => {
  it("auto-unwraps the bare read to `.value`", async () => {
    const src = await pageSource("svelte", "svelte");
    expect(src).toContain("orderById.data.reference");
    expect(src).not.toContain("total.value.value");
    // Bare + explicit both hop exactly once; a bare carrier read (no `.value`
    // at all) never reaches markup.
    const hopped = src.match(/orderById\.data\.total\.value/g) ?? [];
    expect(hopped).toHaveLength(2);
  });
});
