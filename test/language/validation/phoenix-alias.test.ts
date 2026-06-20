import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// The `liveview` framework alias (D-PHOENIX-SURFACE phase 5) — still live.
//
// `liveview` is the framework spelling; it canonicalises to the stable
// `phoenixLiveView` framework at the lowering/registry boundary, so it
// validates, lowers, and generates identically to `framework: phoenixLiveView`.
//
// The `phoenix` / `phoenixLiveView` *platform* aliases were RETIRED
// (D-ELIXIR-PLATFORM, mirroring the retired `hono` → `node` alias):
// `platform: elixir` is the only spelling, and `platform: "phoenix"` now
// fails validation as an unknown platform.
// ---------------------------------------------------------------------------

const UNHOSTABLE = /cannot host ui .* framework/;
const UNKNOWN_PLATFORM = /Unknown platform/;

describe("validator: liveview framework alias + retired phoenix platform alias", () => {
  it("rejects the retired `platform: phoenix` alias as an unknown platform", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable app { platform: "phoenix", contexts: [C], hosts: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNKNOWN_PLATFORM.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("an elixir host accepts a liveview ui (canonicalised match)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable app { platform: elixir, contexts: [C], hosts: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("an elixir host accepts a react ui (static bundle on the static-asset host)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Web { framework: react }
        deployable app { platform: elixir, contexts: [C], hosts: Web, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("still rejects a liveview ui on a non-elixir host (alias doesn't bypass the rule)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, hosts: Admin, port: 3001 }
      }
    `);
    // The message canonicalises the framework to phoenixLiveView.
    expect(
      errors.some((e) => UNHOSTABLE.test(e) && /phoenixLiveView/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("an elixir host with the ashPhoenix pack passes the design-pack format check", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int = 0 } repository As for A { } } }
        ui Admin { framework: liveview  page Home { route: "/" } }
        deployable app { platform: elixir, contexts: [C], hosts: Admin, port: 4000, design: ashPhoenix }
      }
    `);
    expect(
      errors.some((e) => /tsx pack but framework/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
