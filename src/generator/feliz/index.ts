// Feliz frontend generator — projects a Loom `ui` into a Fable/Feliz/Elmish
// (MVU) F# app (fable-elmish-frontend.md).  Model/Msg/init/update are a direct
// PROJECTION off `state {}` + named `action`s (§2/§3b); the `view` rides the
// shared `walkBody` with `felizTarget` + the procedural Feliz pack (§4).
//
// v1 scope: a single-page app (the first example is Counter-class).  Routing
// across multiple pages is a follow-up; a >1-page ui emits every page's view
// but wires only the first into `Program` (with a visible TODO).

import type {
  AggregateIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  PageIR,
  SystemIR,
  UiIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { walkBody } from "../_walker/walker-core.js";
import { felizTarget } from "./feliz-target.js";
import { felizPack } from "./pack.js";
import { msgCase, renderInit, renderModel, renderMsg, renderUpdate } from "./update-emit.js";
import { collectPageReads, type FelizRead, renderApiModule, renderWireTypes } from "./wire.js";

/** The `Remote<'T>` envelope every read's Model field carries — the MVU
 *  analogue of TanStack's `{ isLoading, isError, data }` (§2.3). */
const REMOTE_TYPE = `type Remote<'T> =
  | Loading
  | LoadError of string
  | Loaded of 'T`;

/** The `View` helper module — a `Remote<'T list>` → element matcher.  A helper
 *  CALL is offside-safe inside a Feliz children `[ … ]` list where a raw
 *  multi-line `match` is not, so the QueryView pack renderer emits a call to
 *  this rather than an inline match (see `pack.ts` primitiveQueryView). */
const VIEW_MODULE = `module View =
  let remoteList (r: Remote<'T list>) (loading: ReactElement) (error: ReactElement) (empty: ReactElement) (render: 'T list -> ReactElement) : ReactElement =
    match r with
    | Loading -> loading
    | LoadError _ -> error
    | Loaded [] -> empty
    | Loaded items -> render items`;

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

/** Render one page's `view` function.  Threads the ui's api params + reachable
 *  aggregates so the shared walker's api-hook detection fires on
 *  `<param>.<agg>.all` reads (the Feliz seams project them to Model reads). */
function renderView(
  page: PageIR,
  ui: UiIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
): string {
  if (!page.body) {
    return `let view (model: Model) (dispatch: Msg -> unit) =\n    Html.none`;
  }
  const stateNames = new Set(page.state.map((s) => s.name));
  const result = walkBody(
    page.body,
    felizTarget,
    felizPack(),
    new Set(),
    stateNames,
    new Map(), // userComponents
    ui.apiParams,
    aggregatesByName,
  );
  const wrappers = dispatchWrappers(page, result.usedActions ?? new Set());
  const body = indentBlock(result.tsx, 4);
  const preamble = wrappers.length > 0 ? `${wrappers.join("\n")}\n` : "";
  return `let view (model: Model) (dispatch: Msg -> unit) =\n${preamble}${body}`;
}

/** The api reads the ui's wired page (`pages[0]`) issues — the single source
 *  both `App.fs` (wire layer + MVU) and `App.fsproj` (package refs) read. */
function readsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizRead[] {
  const page = ui.pages[0];
  if (!page) return [];
  const aggregateNames = new Set<string>();
  for (const c of contexts) for (const a of c.aggregates) aggregateNames.add(a.name);
  return collectPageReads(page, new Set(ui.apiParams.map((p) => p.name)), aggregateNames);
}

/** Assemble the single `App.fs` module for a ui.  When the wired page issues
 *  api reads, the file also carries the wire layer (Thoth decoders + a
 *  `Cmd`-based `Api` module + the `Remote`/`View` helpers) ahead of the MVU
 *  triple; a read-free page (Counter-class) stays byte-for-byte as before. */
function renderAppFs(ui: UiIR, contexts: EnrichedBoundedContextIR[]): string {
  const page = ui.pages[0];
  if (!page) {
    return `module App\n\nopen Feliz\n\n// ui '${ui.name}' declares no pages\n`;
  }
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const reads: FelizRead[] = readsForUi(ui, contexts);
  const hasReads = reads.length > 0;

  const model = renderModel(page.state, reads);
  const init = renderInit(page.state, reads);
  const msg = renderMsg(page.actions, reads);
  const update = renderUpdate(page.actions, page.state, reads);
  const view = renderView(page, ui, aggregatesByName);
  const wire = hasReads ? renderWireTypes(reads, contexts) : { domain: "", decoders: "" };
  const api = hasReads ? renderApiModule(reads) : "";

  const multiPageNote =
    ui.pages.length > 1
      ? `\n// TODO(feliz): ui '${ui.name}' has ${ui.pages.length} pages; v1 wires only '${page.name}'. Routing is a follow-up.\n`
      : undefined;

  return lines(
    "module App",
    "",
    "open Feliz",
    "open Elmish",
    "open Elmish.React",
    hasReads && "open Thoth.Json",
    hasReads && "open Fable.SimpleHttp",
    multiPageNote,
    // Wire layer (reads only) — records → Remote → decoders → api → View helper.
    hasReads && "",
    hasReads && wire.domain,
    hasReads && "",
    hasReads && REMOTE_TYPE,
    hasReads && "",
    hasReads && wire.decoders,
    hasReads && "",
    hasReads && api,
    hasReads && "",
    hasReads && VIEW_MODULE,
    "",
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
  );
}

// The wire layer pulls in two more packages (proposal §10 known-good pins):
// Fable.SimpleHttp for the fetch, Thoth.Json for the decoders.  A read-free
// (Counter-class) app omits them so its project stays minimal.
function fsproj(hasReads: boolean): string {
  const wireRefs = hasReads
    ? `
    <PackageReference Include="Fable.SimpleHttp" Version="3.6.0" />
    <PackageReference Include="Thoth.Json" Version="10.2.0" />`
    : "";
  return `<Project Sdk="Microsoft.NET.Sdk">
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
    <PackageReference Include="Fable.Elmish.React" Version="4.0.0" />${wireRefs}
  </ItemGroup>
</Project>
`;
}

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

// Multi-stage build — the Fable step (F# → JS) needs the .NET SDK, the bundle
// step needs Node, so the build stage carries both; the runtime stage serves
// the static bundle.  (Compose-boot verification is a follow-up slice; this
// makes the emitted tree structurally buildable.)
const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /app
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
  && apt-get install -y --no-install-recommends nodejs \\
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN dotnet tool restore
RUN npm install
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf 'server { listen 3000; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' \\
  > /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
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
    <!-- Fable mirrors the fsproj source layout: src/App.fs → out/src/App.js.
         Relative (not root-absolute) so Vite/Rollup resolves it at build. -->
    <script type="module" src="./out/src/App.js"></script>
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
  out.set("src/App.fs", renderAppFs(ui, contexts));
  out.set("App.fsproj", fsproj(readsForUi(ui, contexts).length > 0));
  out.set(".config/dotnet-tools.json", DOTNET_TOOLS);
  out.set("package.json", PACKAGE_JSON(`${deployable.name}-feliz`));
  out.set("vite.config.js", VITE_CONFIG);
  out.set("index.html", INDEX_HTML);
  out.set("Dockerfile", DOCKERFILE);
  return out;
}
