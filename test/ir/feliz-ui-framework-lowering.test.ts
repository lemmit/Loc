// A bare `platform: feliz` deployable lowers `uiFramework` to `"feliz"`.
//
// Feliz self-hosts (`hostableFrameworks: {feliz}` — it builds through
// `dotnet fable` + vite and serves no foreign bundle), so the framework a
// feliz deployable renders is never in doubt.  Lowering nevertheless had no
// feliz branch and fell through to the react default, which is not cosmetic:
// EVERY per-framework validator gate keys on `uiFramework`, so a feliz
// deployable was silently measured against react's capability sets.  The
// `auth: ui` gate is where that showed — it passed only because the resolved
// framework said "react", while an explicit `framework: feliz` ui (which skips
// the fallback) was falsely rejected.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { parseValid } from "../_helpers/index.js";

const SRC = `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    api Sales: SalesApi
    page X { route: "/x"  body: Text("hi") }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: feliz, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`;

describe("feliz uiFramework lowering", () => {
  it("resolves a bare `platform: feliz` mount to framework 'feliz', not the react default", async () => {
    const loom = lowerModel(await parseValid(SRC));
    const web = loom.systems[0]?.deployables.find((d) => d.name === "web");
    expect(web?.uiFramework).toBe("feliz");
  });
});
