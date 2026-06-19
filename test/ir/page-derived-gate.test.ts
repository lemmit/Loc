// Page/component `derived` framework gate.  A body ref to a `derived`
// binding hoists as a reactive computed before the body — `useMemo` (React),
// `computed` (Vue/Angular), `$derived` (Svelte).  All the JS frontends emit
// the hoist; only Phoenix/HEEx stays gated (LiveView's render topology has no
// equivalent hoist site yet), so a `derived` there is rejected at the IR level
// rather than emitting a body ref to a binding that's never declared.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function derivedErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.derived-unsupported-framework")
    .map((d) => d.message);
}

/** A JS-frontend system: the `web` deployable targets the backend and
 *  mounts the ui carrying a `derived`. */
function frontendSys(frontendPlatform: string): string {
  return `
system Demo {
  subdomain S { context C { } }
  ui Web {
    page P {
      route: "/p"
      state { n: int = 0 }
      derived doubled: int = n + n
      body: Stack { Text { doubled } }
    }
  }
  api Api from S
  deployable api { platform: node contexts: [C] serves: Api port: 3000 }
  deployable web { platform: ${frontendPlatform} targets: api ui: Web port: 3001 }
}
`;
}

/** A Phoenix/LiveView fullstack system: the elixir deployable mounts the
 *  ui directly (no separate frontend deployable). */
const PHOENIX_SYS = `
system Demo {
  subdomain S { context C { } }
  ui Web {
    page P {
      route: "/p"
      state { n: int = 0 }
      derived doubled: int = n + n
      body: Stack { Text { doubled } }
    }
  }
  api Api from S
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable app {
    platform: phoenix { foundation: ash }
    contexts: [C]
    dataSources: [cState]
    serves: Api
    ui: Web
    port: 4000
  }
}
`;

describe("page/component `derived` framework gate", () => {
  it("allows derived on a react frontend", async () => {
    expect(await derivedErrors(frontendSys("react"))).toEqual([]);
  });

  it("allows derived on a vue frontend", async () => {
    expect(await derivedErrors(frontendSys("vue"))).toEqual([]);
  });

  it("allows derived on a svelte frontend", async () => {
    expect(await derivedErrors(frontendSys("svelte"))).toEqual([]);
  });

  it("allows derived on an angular frontend", async () => {
    expect(await derivedErrors(frontendSys("angular"))).toEqual([]);
  });

  it("rejects derived on a phoenix (HEEx) frontend", async () => {
    const errs = await derivedErrors(PHOENIX_SYS);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("page P");
    expect(errs[0]).toContain("react, vue, svelte, and angular");
  });
});
