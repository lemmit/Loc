// Page/component `derived` is supported on EVERY frontend now — the JS
// frontends (react/vue/svelte/angular) hoist a reactive computed; Phoenix/
// HEEx inline-recomputes the expr at each use.  There is no framework gate,
// so a `derived` never raises `loom.derived-unsupported-framework`.  This
// guards against a gate accidentally coming back.

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

function frontendSys(frontendPlatform: string): string {
  return `
system Demo {
  subdomain S { context C { } }
  ui Web {
    page P { route: "/p" state { n: int = 0 } derived doubled: int = n + n body: Stack { Text { doubled } } }
  }
  api Api from S
  deployable api { platform: node contexts: [C] serves: Api port: 3000 }
  deployable web { platform: ${frontendPlatform} targets: api ui: Web port: 3001 }
}
`;
}

const PHOENIX_SYS = `
system Demo {
  subdomain S { context C { } }
  ui Web {
    page P { route: "/p" state { n: int = 0 } derived doubled: int = n + n body: Stack { Text { doubled } } }
  }
  api Api from S
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable app { platform: elixir contexts: [C] dataSources: [cState] serves: Api ui: Web port: 4000 }
}
`;

describe("page/component `derived` — supported on every frontend", () => {
  for (const fw of ["react", "vue", "svelte", "angular"]) {
    it(`accepts derived on ${fw}`, async () => {
      expect(await derivedErrors(frontendSys(fw))).toEqual([]);
    });
  }

  it("accepts derived on phoenix (HEEx inline-recompute)", async () => {
    expect(await derivedErrors(PHOENIX_SYS)).toEqual([]);
  });
});
