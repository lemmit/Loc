// Cross-backend wire parity for the union-find *absent* variant — the find
// re-shape (exception-less.md A4).
//
// A `find recent(): Order or NotFound` is a single-get whose absent case is the
// `NotFound` error variant.  Under A4 every backend maps that absent variant to
// an RFC-7807 ProblemDetails at its mapped status (404) rather than a 200
// tagged-union body: the HTTP status is the discriminator, not an inline `type:
// "NotFound"` member.  This was the last divergence — Phoenix/Ash inline-tagged
// the absent variant at 200 until the controller action learned the `case`
// arm; every other backend (Hono / .NET / Python / Java / the vanilla Elixir
// foundation) already 404'd it.  This pins the now-uniform contract.
//
// Two tiers of assertion:
//   * The decisive invariant, asserted for ALL six backends: the absent
//     variant produces HTTP 404 + the `/errors/not-found` type URI.
//   * The `resource: "Order"` extension (the aggregate name), now asserted for
//     ALL six backends.  .NET can't carry it through `ControllerBase.Problem`
//     (no extension-member slot), so when the payload declares `resource` it
//     builds an explicit `ProblemDetails` + `ObjectResult` and sets
//     `Extensions["resource"]` (`[JsonExtensionData]` → serialized at the body
//     root), matching the other five.
//
// Lives in the always-on `test` gate (no docker) alongside
// `union-wire-parity.test.ts` (which pins the union *type* shape — the inline
// success variant).  This one pins the *absent*-variant HTTP mapping.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** The same union-find `.ddd` per backend — only the deployable platform (and
 *  the ui wiring Phoenix needs) varies. */
function system(platform: string, ui: boolean): string {
  return `
system S {
  subdomain Sales {
    context Orders {
      error NotFound { resource: string }
      aggregate Order ids guid { code: string  region: string }
      repository Orders for Order { find recent(): Order or NotFound }
    }
  }
  api OrdersApi from Sales
  ${ui ? "ui A with scaffold(subdomains: [Sales]) { }" : ""}
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [s]
    serves: OrdersApi
    ${ui ? "ui: A" : ""}
    port: 4000
  }
}`;
}

/** Slice the source file around the `recent` find handler so the assertions
 *  read the absent-variant arm, not an unrelated `not-found` elsewhere. */
function recentRegion(src: string, anchor: RegExp): string {
  const i = src.search(anchor);
  return i < 0 ? "" : src.slice(i, i + 700);
}

type Backend = {
  platform: string;
  ui: boolean;
  file: string;
  anchor: RegExp;
  /** Does this backend carry the `resource` extension on the absent body? */
  hasResource: boolean;
};

const BACKENDS: Backend[] = [
  {
    platform: "node",
    ui: false,
    file: "d/http/order.routes.ts",
    anchor: /result == null/,
    hasResource: true,
  },
  {
    platform: "python",
    ui: false,
    file: "d/app/http/order_routes.py",
    anchor: /is None/,
    hasResource: true,
  },
  {
    platform: "dotnet",
    ui: false,
    file: "d/Api/OrdersController.cs",
    anchor: /RecentOrder/,
    hasResource: true,
  },
  {
    platform: "java",
    ui: false,
    file: "d/src/main/java/com/loom/d/features/orders/OrdersController.java",
    anchor: /recentOrder/i,
    hasResource: true,
  },
  {
    platform: "elixir",
    ui: true,
    file: "d/lib/d_web/controllers/orders_controller.ex",
    anchor: /def recent/,
    hasResource: true,
  },
  {
    // The vanilla Elixir foundation (plain Phoenix + Ecto, no Ash) — the
    // backend that established the A4 absent-variant shape (#1218).
    platform: "elixir { foundation: vanilla }",
    ui: false,
    file: "d/lib/d_web/controllers/order_controller.ex",
    anchor: /def recent/,
    hasResource: true,
  },
];

async function absentArm(b: Backend): Promise<string> {
  const files = await generateSystemFiles(system(b.platform, b.ui));
  return recentRegion(files.get(b.file)!, b.anchor);
}

describe("union-find absent variant — cross-backend wire parity (A4)", () => {
  for (const b of BACKENDS) {
    it(`${b.platform}: absent variant → 404 + /errors/not-found`, async () => {
      const arm = await absentArm(b);
      expect(arm).toContain("404");
      expect(arm).toContain("/errors/not-found");
    });

    if (b.hasResource) {
      it(`${b.platform}: absent body carries the resource extension`, async () => {
        const arm = await absentArm(b);
        expect(arm).toMatch(/resource/);
        expect(arm).toContain('"Order"');
      });
    }
  }
});
