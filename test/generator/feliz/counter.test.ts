// Feliz frontend — the Counter MVU projection (fable-elmish-frontend.md).
// The emitted App.fs is proven to compile via `dotnet fable` (SDK:8.0
// container, proposal §10); this pins the F# projection structure so a
// regression surfaces in the fast suite before the docker gate.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

const COUNTER = `
system CounterApp {
  subdomain S { context C { } }
  ui WebApp {
    framework: feliz
    page Counter {
      route: "/"
      state { count: int = 0 }
      action inc() { count := count + 1 }
      action dec() { count := count - 1 }
      body: Stack {
        Heading { "Counter", level: 1 },
        Text { "Count: " + count },
        Button { "+", onClick: inc },
        Button { "-", onClick: dec }
      }
    }
  }
  deployable api { platform: node contexts: [C] port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
}
`;

async function emitCounter(): Promise<Map<string, string>> {
  const model = await buildLoomModel(COUNTER);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts([], sys, web);
}

describe("feliz Counter", () => {
  it("projects Model / Msg / init / update off state + actions", async () => {
    const app = (await emitCounter()).get("src/App.fs")!;
    // Model record — one field per state cell.
    expect(app).toContain("type Model =");
    expect(app).toContain("Count: int");
    // Msg — one case per action (projection, no gensym).
    expect(app).toContain("type Msg =");
    expect(app).toContain("| Inc");
    expect(app).toContain("| Dec");
    // init — zero value from the state init.
    expect(app).toContain("Count = 0");
    // update — one arm per action, record-`with` writes.
    expect(app).toContain("| Inc ->");
    expect(app).toContain("{ model with Count = (model.Count + 1) }");
    expect(app).toContain("{ model with Count = (model.Count - 1) }");
    expect(app).toContain("model, Cmd.none");
  });

  it("emits an F# view (no JS expression leak)", async () => {
    const app = (await emitCounter()).get("src/App.fs")!;
    expect(app).toContain("let view (model: Model) (dispatch: Msg -> unit) =");
    // Dispatch wrappers for used actions.
    expect(app).toContain("let inc () = dispatch Inc");
    expect(app).toContain("let dec () = dispatch Dec");
    // Feliz element tree via the shared walkBody + procedural pack.
    expect(app).toContain("Html.div [");
    expect(app).toContain(
      'Html.h1 [ prop.className "text-3xl font-bold"; prop.children [ Html.text "Counter" ] ]',
    );
    // Button props (label + onClick as props, never mixed with children).
    expect(app).toContain("prop.onClick (fun _ -> inc())");
    // The state read is F#, not JS — `string model.Count`, never `String(...)`.
    expect(app).toContain("string model.Count");
    expect(app).not.toContain("String(");
    // MVU wiring.
    expect(app).toContain("Program.mkProgram init update view");
    expect(app).toContain('Program.withReactSynchronous "root"');
  });

  it("emits the Fable/Vite project shell", async () => {
    const files = await emitCounter();
    expect(files.has("App.fsproj")).toBe(true);
    expect(files.has(".config/dotnet-tools.json")).toBe(true);
    expect(files.get("App.fsproj")).toContain('Include="Feliz"');
    expect(files.get(".config/dotnet-tools.json")).toContain('"fable"');
    expect(files.has("index.html")).toBe(true);
    // Fable emits out/src/App.js (mirrors the fsproj `src/App.fs` layout); the
    // <script> must reference it RELATIVELY so Vite/Rollup resolves it at build
    // (proven: a root-absolute `/out/App.js` fails `vite build`).
    expect(files.get("index.html")).toContain('src="./out/src/App.js"');
    expect(files.get("Dockerfile")).toContain("dotnet tool restore");
  });

  // Reachability — `platform: feliz` / `framework: feliz` must PARSE + VALIDATE
  // (generator tests bypass validateLoomModel; experience_gathered.md §22).
  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(COUNTER, { validate: true });
    expect(errors).toEqual([]);
  });

  // End-to-end through the PlatformSurface — `generate system` routes the
  // `platform: feliz` deployable to the Feliz generator and lands App.fs.
  it("generates the Feliz project through the system composer", async () => {
    const files = await generateSystemFiles(COUNTER);
    const appFs = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"));
    expect(appFs).toBeDefined();
    expect(appFs![1]).toContain("Program.mkProgram init update view");
  });
});
