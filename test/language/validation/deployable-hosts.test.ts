import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// D-PHOENIX-SURFACE phase 4 — the `hosts:` clause on a deployable.
//
// `hosts:` is the host↔ui relation that supersedes the legacy `ui:`
// bindings.  It is a UI mount on equal footing: it satisfies the
// "must declare a UI" rules, is rejected on platforms that don't mount
// a UI, and is subject to the same host-framework-compatibility check
// (phase 3) — applied to each hosted `ui`.
// ---------------------------------------------------------------------------

const UNHOSTABLE = /cannot host ui .* framework/;
const MISSING_UI = /must declare a 'ui:' binding/;

describe("validator: deployable hosts: clause (D-PHOENIX-SURFACE)", () => {
  it("a react deployable satisfies the UI-presence rule via hosts: (no missing-ui error)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { framework: react }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, hosts: WebApp, port: 3001 }
      }
    `);
    expect(
      errors.some((e) => MISSING_UI.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("rejects hosts: on a platform that doesn't mount a UI (hono)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { framework: react }
        deployable api { platform: hono, contexts: [C], hosts: WebApp, port: 3000 }
      }
    `);
    expect(
      errors.some((e) => /only valid on platforms that mount a UI/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("runs the host-compatibility check on a hosted ui — rejects LiveView on a dotnet host", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Admin { framework: phoenixLiveView }
        deployable app { platform: dotnet, contexts: [C], hosts: Admin, port: 8080 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e) && /phoenixLiveView/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a react ui embedded via hosts: in a dotnet host (static-asset host)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui WebApp { framework: react }
        deployable app { platform: dotnet, contexts: [C], hosts: WebApp, port: 8080 }
      }
    `);
    expect(
      errors.some((e) => UNHOSTABLE.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("checks every entry of a multi-host clause (one bad framework among several)", async () => {
    const { errors } = await parseString(`
      system S {
        subdomain M { context C { aggregate A { x: int } } }
        ui Web { framework: react }
        ui Admin { framework: phoenixLiveView }
        deployable app { platform: dotnet, contexts: [C], hosts: [Web, Admin], port: 8080 }
      }
    `);
    // Web (react) is fine on dotnet; Admin (LiveView) is not.
    expect(
      errors.some((e) => UNHOSTABLE.test(e) && /Admin/.test(e) && /phoenixLiveView/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});
