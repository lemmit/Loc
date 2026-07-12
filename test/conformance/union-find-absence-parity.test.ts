// Cross-backend wire parity for the union-find *absent* variant — the find
// re-shape (exception-less.md A4).
//
// A `find recent(): Order or NotFound` is a single-get whose absent case is the
// `NotFound` error variant.  Under A4 every backend maps that absent variant to
// an RFC-7807 ProblemDetails at its mapped status (404) rather than a 200
// tagged-union body: the HTTP status is the discriminator, not an inline `type:
// "NotFound"` member.  Every backend (Hono / .NET / Python / Java / Elixir on
// plain Phoenix+Ecto) maps the absent variant to a 404 ProblemDetails.  This
// pins the now-uniform contract.
//
// Two tiers of assertion:
//   * The decisive invariant, asserted for ALL five backends: the absent
//     variant produces HTTP 404 + the `/errors/not-found` type URI.
//   * The `resource: "Order"` extension (the aggregate name), now asserted for
//     ALL five backends.  .NET can't carry it through `ControllerBase.Problem`
//     (no extension-member slot), so when the payload declares `resource` it
//     builds an explicit `ProblemDetails` + `ObjectResult` and sets
//     `Extensions["resource"]` (`[JsonExtensionData]` → serialized at the body
//     root), matching the other four.
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
      aggregate Order { code: string  region: string }
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
    // The Elixir backend (plain Phoenix + Ecto — the vanilla foundation is the
    // only Elixir foundation) — established the A4 absent-variant shape (#1218).
    platform: "elixir",
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
