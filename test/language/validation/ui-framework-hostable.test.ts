import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// D-PHOENIX-SURFACE phase 3 — `loom.ui-framework-unhostable`.
//
// When a `ui { framework: … }` declaration carries its own framework
// (phase 2), the hosting deployable's platform must be able to serve it:
// `framework ∈ host.hostableFrameworks` (phase 1).  The principled rule
// is "a host serves a framework iff it provides that framework's
// runtime", so:
//   - `phoenixLiveView` (LiveView, runtime-coupled) is hostable ONLY by
//     Phoenix; rejected on every other host.
//   - `react`/`static` (static bundles) are hostable by any static-asset
//     host (react/static/dotnet/hono/phoenix).
//
// Backward-compatible: the check only fires when the `ui` declaration
// opts in by declaring `framework:`.  A `ui` with no framework keeps the
// legacy derive-from-platform path and never trips this rule.
// ---------------------------------------------------------------------------

const RX = /cannot host ui .* framework/;

describe("validator: ui framework must be hostable by the deployable (D-PHOENIX-SURFACE)", () => {
  it("rejects a LiveView ui hosted on a react (non-Phoenix) deployable", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: Admin, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => RX.test(e) && /phoenixLiveView/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a LiveView ui hosted on a phoenix deployable (its own runtime)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
        deployable app { platform: elixir, contexts: [C], ui: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => RX.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("accepts a react ui hosted on a react deployable (static bundle, any static host)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { framework: react }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => RX.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("accepts a react ui embedded in a dotnet deployable (wwwroot static host)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { framework: react }
        deployable app { platform: dotnet, contexts: [C], ui: WebApp, port: 8080 }
      }
    `);
    expect(
      errors.some((e) => RX.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("does not fire for a ui with no declared framework (legacy path untouched)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: WebApp, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => RX.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
