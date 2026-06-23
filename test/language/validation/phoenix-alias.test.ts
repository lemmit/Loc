import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Retired phoenix-family aliases.  `platform: elixir` + `framework:
// phoenixLiveView` are the only spellings:
//
//   - the `phoenix` / `phoenixLiveView` *platform* aliases were RETIRED
//     (D-ELIXIR-PLATFORM, mirroring the retired `hono` → `node` alias):
//     `platform: "phoenix"` fails validation as an unknown platform.
//   - the `liveview` *framework* alias was RETIRED too: `phoenixLiveView`
//     is the only framework spelling (the bare `liveview` keyword is gone
//     from the grammar).
//
// These tests pin that the canonical spellings still host correctly and
// that the retired platform alias is rejected.
// ---------------------------------------------------------------------------

const UNHOSTABLE = /cannot host ui .* framework/;
const UNKNOWN_PLATFORM = /Unknown platform/;

describe("validator: retired phoenix-family platform + framework aliases", () => {
  it("rejects the retired `platform: phoenix` alias as an unknown platform", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
        deployable app { platform: "phoenix", contexts: [C], hosts: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNKNOWN_PLATFORM.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("an elixir host accepts a phoenixLiveView ui", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
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

  it("still rejects a phoenixLiveView ui on a non-elixir host", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
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

  it("an elixir host with the coreComponents pack passes the design-pack format check", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int = 0 } repository As for A { } } }
        ui Admin { framework: phoenixLiveView  page Home { route: "/" } }
        deployable app { platform: elixir, contexts: [C], hosts: Admin, port: 4000, design: coreComponents }
      }
    `);
    expect(
      errors.some((e) => /tsx pack but framework/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
