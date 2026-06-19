// Page/component `derived` framework gate.  The body ref to a `derived`
// binding hoists as a `useMemo` const — only the React generator emits the
// hoist today, so a `derived` on a non-react frontend (vue/svelte/angular/
// phoenix) is rejected at the IR level rather than emitting a body ref to a
// const that's never declared.

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

function sys(frontendPlatform: string): string {
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

describe("page/component `derived` framework gate", () => {
  it("allows derived on a react frontend", async () => {
    expect(await derivedErrors(sys("react"))).toEqual([]);
  });

  it("rejects derived on a vue frontend", async () => {
    const errs = await derivedErrors(sys("vue"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("only supported on the react frontend");
    expect(errs[0]).toContain("page P");
  });

  it("rejects derived on a svelte frontend", async () => {
    expect((await derivedErrors(sys("svelte"))).length).toBe(1);
  });
});
