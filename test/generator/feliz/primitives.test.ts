// Feliz procedural pack — the static primitives beyond Counter's set
// (fable-elmish-frontend.md §4).  The emitted F# is proven to compile via
// `dotnet fable` (SDK:8.0 container); this pins the render shape so a
// regression surfaces in the fast suite before the docker gate.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SHOWCASE = `
system ShowcaseApp {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Showcase {
      route: "/"
      state { count: int = 0 }
      action inc() { count := count + 1 }
      body: Stack {
        Heading { "Feliz primitives", level: 1 },
        Card { "Counter card",
          Stack {
            Text { "Count: " + count },
            Button { "+", onClick: inc }
          }
        },
        Divider { },
        Badge { "beta" }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

describe("feliz pack primitives", () => {
  it("renders Card / Divider / Badge as Feliz F#", async () => {
    const model = await buildLoomModel(SHOWCASE);
    const sys = model.systems[0]!;
    const web = sys.deployables.find((d) => d.name === "web")!;
    const app = generateFelizForContexts([], sys, web).get("src/App.fs")!;
    // Card — a titled container wrapping its single content element.
    expect(app).toContain('Html.div [ prop.className "loom-card"');
    expect(app).toContain('Html.h3 [ Html.text "Counter card" ]');
    // Divider → <hr>, Badge → a labelled span.
    expect(app).toContain("Html.hr []");
    expect(app).toContain('Html.span [ prop.className "loom-badge"; prop.text "beta" ]');
    // The nested Stack content still rides the walker (Card body → Stack).
    expect(app).toContain("prop.onClick (fun _ -> inc())");
  });
});
