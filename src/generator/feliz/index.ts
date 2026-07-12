// Feliz frontend generator — projects a Loom `ui` into a Fable/Feliz/Elmish
// (MVU) F# app (fable-elmish-frontend.md).  Model/Msg/init/update are a direct
// PROJECTION off `state {}` + named `action`s (§2/§3b); the `view` rides the
// shared `walkBody` with `felizTarget` + the procedural Feliz pack (§4).
//
// v1 scope: a single-page app (the first example is Counter-class).  Routing
// across multiple pages is a follow-up; a >1-page ui emits every page's view
// but wires only the first into `Program` (with a visible TODO).

import type {
  DeployableIR,
  EnrichedBoundedContextIR,
  PageIR,
  SystemIR,
  UiIR,
} from "../../ir/types/loom-ir.js";
import { walkBody } from "../_walker/walker-core.js";
import { felizTarget } from "./feliz-target.js";
import { felizPack } from "./pack.js";
import { msgCase, renderInit, renderModel, renderMsg, renderUpdate } from "./update-emit.js";

export interface GenerateFelizOptions {
  apiBaseUrl?: string;
}

/** Indent every line of `block` by `n` spaces. */
function indentBlock(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

/** Emit the dispatch wrappers a page's view needs — one `let <action> … =
 *  dispatch <Msg>` per action USED by the body.  The effect body is projected
 *  into `update`; the view handler only dispatches. */
function dispatchWrappers(page: PageIR, used: ReadonlySet<string>): string[] {
  return page.actions
    .filter((a) => used.has(a.name))
    .map((a) => {
      const p = a.params[0]?.name;
      return p
        ? `    let ${a.name} ${p} = dispatch (${msgCase(a.name)} ${p})`
        : `    let ${a.name} () = dispatch ${msgCase(a.name)}`;
    });
}

/** Render one page's `view` function. */
function renderView(page: PageIR): string {
  if (!page.body) {
    return `let view (model: Model) (dispatch: Msg -> unit) =\n    Html.none`;
  }
  const stateNames = new Set(page.state.map((s) => s.name));
  const result = walkBody(page.body, felizTarget, felizPack(), new Set(), stateNames);
  const wrappers = dispatchWrappers(page, result.usedActions ?? new Set());
  const body = indentBlock(result.tsx, 4);
  const preamble = wrappers.length > 0 ? `${wrappers.join("\n")}\n` : "";
  return `let view (model: Model) (dispatch: Msg -> unit) =\n${preamble}${body}`;
}

/** Assemble the single `App.fs` module for a ui. */
function renderAppFs(ui: UiIR): string {
  const page = ui.pages[0];
  if (!page) {
    return `module App\n\nopen Feliz\n\n// ui '${ui.name}' declares no pages\n`;
  }
  const model = renderModel(page.state);
  const init = renderInit(page.state);
  const msg = renderMsg(page.actions);
  const update = renderUpdate(page.actions, page.state);
  const view = renderView(page);
  const multiPageNote =
    ui.pages.length > 1
      ? `\n// TODO(feliz): ui '${ui.name}' has ${ui.pages.length} pages; v1 wires only '${page.name}'. Routing is a follow-up.\n`
      : "";
  return [
    "module App",
    "",
    "open Feliz",
    "open Elmish",
    "open Elmish.React",
    multiPageNote,
    model,
    "",
    msg,
    "",
    init,
    "",
    update,
    "",
    view,
    "",
    "Program.mkProgram init update view",
    '|> Program.withReactSynchronous "root"',
    "|> Program.run",
    "",
  ].join("\n");
}

const FSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="src/App.fs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Fable.Core" Version="4.3.0" />
    <PackageReference Include="Feliz" Version="2.8.0" />
    <PackageReference Include="Fable.Elmish.React" Version="4.0.0" />
  </ItemGroup>
</Project>
`;

const DOTNET_TOOLS = `{
  "version": 1,
  "isRoot": true,
  "tools": {
    "fable": {
      "version": "4.29.0",
      "commands": ["fable"]
    }
  }
}
`;

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        fable: "dotnet tool restore && dotnet fable App.fsproj -o out --extension .js",
        build: "npm run fable && vite build",
        dev: "npm run fable && vite",
      },
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      devDependencies: { vite: "^5.4.0" },
    },
    null,
    2,
  )}\n`;

const VITE_CONFIG = `import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist" },
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Loom · Feliz</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/out/App.js"></script>
  </body>
</html>
`;

/** Generate a Fable/Feliz project for a frontend deployable. */
export function generateFelizForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateFelizOptions = {},
): Map<string, string> {
  void contexts;
  void options;
  const out = new Map<string, string>();
  if (!deployable.uiName) {
    throw new Error(
      `Feliz deployable '${deployable.name}' has no ui binding (uiName). A frontend deployable must target a ui.`,
    );
  }
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) {
    throw new Error(
      `Feliz deployable '${deployable.name}' references ui '${deployable.uiName}' but no such ui is declared.`,
    );
  }
  out.set("src/App.fs", renderAppFs(ui));
  out.set("App.fsproj", FSPROJ);
  out.set(".config/dotnet-tools.json", DOTNET_TOOLS);
  out.set("package.json", PACKAGE_JSON(`${deployable.name}-feliz`));
  out.set("vite.config.js", VITE_CONFIG);
  out.set("index.html", INDEX_HTML);
  return out;
}
