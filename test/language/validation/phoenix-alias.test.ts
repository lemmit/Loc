import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// D-PHOENIX-SURFACE phase 5 — the `phoenix` platform + `liveview`
// framework aliases.
//
// `phoenix` is the host-platform spelling (decoupled from the framework
// name); `liveview` is the framework spelling.  Both canonicalise to the
// still-stable `phoenixLiveView` at the lowering/registry boundary, so
// the new spelling validates, lowers, and generates identically to the
// legacy `platform: phoenixLiveView` + `framework: phoenixLiveView`.
// ---------------------------------------------------------------------------

const UNHOSTABLE = /cannot host ui .* framework/;
const UNKNOWN_PLATFORM = /Unknown platform/;

describe("validator: phoenix/liveview aliases (D-PHOENIX-SURFACE)", () => {
  it("accepts `platform: phoenix` (not flagged as an unknown platform)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable app { platform: phoenix, contexts: [C], hosts: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNKNOWN_PLATFORM.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("a phoenix host accepts a liveview ui (canonicalised match)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable app { platform: phoenix, contexts: [C], hosts: Admin, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("a phoenix host accepts a react ui (static bundle on the static-asset host)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Web { framework: react }
        deployable app { platform: phoenix, contexts: [C], hosts: Web, port: 4000 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("still rejects a liveview ui on a non-phoenix host (alias doesn't bypass the rule)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: liveview }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, hosts: Admin, port: 3001 }
      }
    `);
    // The message canonicalises the framework to phoenixLiveView.
    expect(
      errors.some((e) => UNHOSTABLE.test(e) && /phoenixLiveView/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("a phoenix host with the ashPhoenix pack passes the design-pack format check", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int = 0 } repository As for A { } } }
        ui Admin { framework: liveview  page Home { route: "/" } }
        deployable app { platform: phoenix, contexts: [C], hosts: Admin, port: 4000, design: ashPhoenix }
      }
    `);
    expect(
      errors.some((e) => /tsx pack but framework/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
