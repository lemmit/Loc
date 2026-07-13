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
import { lowerFirst, upperFirst } from "../../util/naming.js";
import { walkBody } from "../_walker/walker-core.js";
import { felizTarget } from "./feliz-target.js";
import { felizPack } from "./pack.js";
import {
  msgCase,
  renderInit,
  renderModel,
  renderMsg,
  renderPageCmd,
  renderUpdate,
} from "./update-emit.js";
import {
  collectPageForms,
  collectPageMutations,
  collectPageOperationForms,
  collectPageReads,
  type FelizForm,
  type FelizMutation,
  type FelizOperationForm,
  type FelizRead,
  renderApiModule,
  renderEncoders,
  renderFormTypes,
  renderViewModule,
  renderWireTypes,
} from "./wire.js";

/** The `Remote<'T>` envelope every read's Model field carries — the MVU
 *  analogue of TanStack's `{ isLoading, isError, data }` (§2.3). */
const REMOTE_TYPE = `type Remote<'T> =
  | Loading
  | LoadError of string
  | Loaded of 'T`;

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

/** Render one page's view function under `fnName` (`view` for a single-page
 *  ui, `<pageCamel>View` under routing).  Threads the ui's api params +
 *  reachable aggregates so the shared walker's api-hook detection fires on
 *  `<param>.<agg>.all` reads (the Feliz seams project them to Model reads). */
function renderPageView(
  page: PageIR,
  ui: UiIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  fnName: string,
  takesRouteId = false,
): string {
  // A detail page's view takes the route `id` (bound by its `Page` case); the
  // body's `byId(id)` renders through the `renderRouteId` seam to this local.
  const idParam = takesRouteId ? " (id: string)" : "";
  const head = `let ${fnName} (model: Model) (dispatch: Msg -> unit)${idParam} =`;
  if (!page.body) return `${head}\n    Html.none`;
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
  return `${head}\n${preamble}${body}`;
}

// --- Multi-page routing helpers (Feliz.Router) ----------------------------

/** F# `Page` union case for a page (`page Products` → `Products`). */
function pageCase(page: PageIR): string {
  return upperFirst(page.name);
}
/** Per-page view function name (`page Products` → `productsView`). */
function pageViewFn(page: PageIR): string {
  return `${lowerFirst(page.name)}View`;
}
/** A page carries a route param when its `route:` has a `:param` segment
 *  (`/products/:id`) — a detail page.  v1 binds only the FIRST such param, as
 *  the magic route `id`. */
function hasRouteParam(page: PageIR): boolean {
  return (page.route ?? "/").split("/").some((s) => s.startsWith(":"));
}
/** URL segments of a page's `route:` as an F# list pattern.  `/` → `[]`;
 *  `/orders/:id` → `[ "orders"; id ]` (the first `:param` binds the local `id`,
 *  further params match as `_` — single-param detail routes are the v1 shape). */
function routePattern(route: string | undefined): string {
  const segs = (route ?? "/").split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return "[]";
  let bound = false;
  const pats = segs.map((s) => {
    if (!s.startsWith(":")) return `"${s}"`;
    if (bound) return "_";
    bound = true;
    return "id";
  });
  return `[ ${pats.join("; ")} ]`;
}

/** The `Page` union + `parseUrl` — URL segments → the active `Page`.  A detail
 *  page's case carries its route param (`| ProductDetail of string`); `parseUrl`
 *  binds the segment.  Arms are emitted in page order; the first page is the
 *  catch-all fallback (paramless, so a valid fallback ctor). */
function renderRouting(pages: readonly PageIR[]): string {
  const caseDecl = (p: PageIR): string =>
    hasRouteParam(p) ? `  | ${pageCase(p)} of string` : `  | ${pageCase(p)}`;
  const ctor = (p: PageIR): string => (hasRouteParam(p) ? `${pageCase(p)} id` : pageCase(p));
  const union = `type Page =\n${pages.map(caseDecl).join("\n")}`;
  const arms = pages.map((p) => `  | ${routePattern(p.route)} -> ${ctor(p)}`);
  const parse =
    `let parseUrl (segments: string list) : Page =\n  match segments with\n` +
    `${arms.join("\n")}\n  | _ -> ${pageCase(pages[0]!)}`;
  return `${union}\n\n${parse}`;
}

/** The root `view` — a `React.router` that dispatches `UrlChanged` and renders
 *  the active page's view function (threading the route `id` to detail pages). */
function renderRootView(pages: readonly PageIR[]): string {
  const arms = pages.map((p) =>
    hasRouteParam(p)
      ? `      | ${pageCase(p)} id -> ${pageViewFn(p)} model dispatch id`
      : `      | ${pageCase(p)} -> ${pageViewFn(p)} model dispatch`,
  );
  return [
    "let view (model: Model) (dispatch: Msg -> unit) =",
    "  React.router [",
    "    router.onUrlChanged (UrlChanged >> dispatch)",
    "    router.children [",
    "      match model.CurrentPage with",
    ...arms,
    "    ]",
    "  ]",
  ].join("\n");
}

/** The api reads a ui issues, across ALL its pages (deduped by Model field) —
 *  the single source both `App.fs` (wire layer + MVU) and `App.fsproj` (package
 *  refs) read. */
function readsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizRead[] {
  const aggregateNames = new Set<string>();
  for (const c of contexts) for (const a of c.aggregates) aggregateNames.add(a.name);
  const apiParamNames = new Set(ui.apiParams.map((p) => p.name));
  const seen = new Set<string>();
  const out: FelizRead[] = [];
  for (const page of ui.pages) {
    for (const r of collectPageReads(page, apiParamNames, aggregateNames)) {
      if (seen.has(r.field)) continue;
      seen.add(r.field);
      out.push(r);
    }
  }
  return out;
}

/** The mutations a ui issues, across ALL its pages (deduped by aggregate) —
 *  v1 covers `DestroyForm(of: X)` deletes. */
function mutationsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizMutation[] {
  const aggregateNames = new Set<string>();
  for (const c of contexts) for (const a of c.aggregates) aggregateNames.add(a.name);
  const seen = new Set<string>();
  const out: FelizMutation[] = [];
  for (const page of ui.pages) {
    for (const m of collectPageMutations(page, aggregateNames)) {
      if (seen.has(m.aggregate)) continue;
      seen.add(m.aggregate);
      out.push(m);
    }
  }
  return out;
}

/** The create forms a ui hosts, across ALL its pages (deduped by aggregate) —
 *  `CreateForm(of: X)`. */
function formsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizForm[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const seen = new Set<string>();
  const out: FelizForm[] = [];
  for (const page of ui.pages) {
    for (const f of collectPageForms(page, aggregatesByName)) {
      if (seen.has(f.aggregate)) continue;
      seen.add(f.aggregate);
      out.push(f);
    }
  }
  return out;
}

/** The operation forms a ui hosts, across ALL its pages (deduped by form type) —
 *  `OperationForm(of: X, op: Y)`. */
function operationFormsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizOperationForm[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const seen = new Set<string>();
  const out: FelizOperationForm[] = [];
  for (const page of ui.pages) {
    for (const f of collectPageOperationForms(page, aggregatesByName)) {
      if (seen.has(f.formType)) continue;
      seen.add(f.formType);
      out.push(f);
    }
  }
  return out;
}

/** A ui's `state {}` fields across ALL pages, deduped by name (multi-page uis
 *  share one flat Model; distinct pages should use distinct field names). */
function combinedState(ui: UiIR): PageIR["state"][number][] {
  const seen = new Set<string>();
  const out: PageIR["state"][number][] = [];
  for (const page of ui.pages)
    for (const f of page.state)
      if (!seen.has(f.name)) {
        seen.add(f.name);
        out.push(f);
      }
  return out;
}

/** A ui's named `action`s across ALL pages, deduped by name. */
function combinedActions(ui: UiIR): PageIR["actions"][number][] {
  const seen = new Set<string>();
  const out: PageIR["actions"][number][] = [];
  for (const page of ui.pages)
    for (const a of page.actions)
      if (!seen.has(a.name)) {
        seen.add(a.name);
        out.push(a);
      }
  return out;
}

/** Assemble the single `App.fs` module for a ui.  A ui with >1 page emits a
 *  `Page` union + `parseUrl` + a `React.router` root over a combined Model
 *  (`Feliz.Router`); a single-page ui stays byte-for-byte as before.  When any
 *  page issues api reads the file also carries the wire layer (Thoth decoders +
 *  a `Cmd`-based `Api` module + the `Remote`/`View` helpers). */
function renderAppFs(ui: UiIR, contexts: EnrichedBoundedContextIR[]): string {
  const pages = ui.pages;
  if (pages.length === 0) {
    return `module App\n\nopen Feliz\n\n// ui '${ui.name}' declares no pages\n`;
  }
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const reads: FelizRead[] = readsForUi(ui, contexts);
  const mutations: FelizMutation[] = mutationsForUi(ui, contexts);
  const forms: FelizForm[] = formsForUi(ui, contexts);
  const operationForms: FelizOperationForm[] = operationFormsForUi(ui, contexts);
  const formRecords = [...forms, ...operationForms]; // shared record/encoder/type wiring
  const hasReads = reads.length > 0;
  const hasForms = formRecords.length > 0;
  // Http/Api are needed for reads, mutations AND forms (POST); the Thoth
  // decoder/Remote/View layer only for reads; form types + encoders only for forms.
  const hasHttp = hasReads || mutations.length > 0 || hasForms;
  // A ui is routed when it has >1 page OR any page carries a route param (a lone
  // detail page still needs a router to bind its `:id`).
  const routed = pages.length > 1 || pages.some(hasRouteParam);
  const pageCmd = renderPageCmd(reads); // "" unless byId reads exist

  // MVU triple is built from the COMBINED (all-page, deduped) state + actions;
  // a single-page ui's combined lists are exactly its one page's.
  const state = combinedState(ui);
  const actions = combinedActions(ui);
  const model = renderModel(state, reads, routed, formRecords);
  const init = renderInit(state, reads, routed, formRecords);
  const msg = renderMsg(actions, reads, routed, mutations, forms, operationForms);
  const update = renderUpdate(actions, state, reads, routed, mutations, forms, operationForms);
  const wire = hasReads ? renderWireTypes(reads, contexts) : { domain: "", decoders: "" };
  const api = hasHttp ? renderApiModule(reads, mutations, forms, operationForms) : "";
  const formTypes = hasForms ? renderFormTypes(formRecords) : "";
  const encoders = hasForms ? renderEncoders(formRecords) : "";

  // Views: one root `view` (single-page) OR per-page `<page>View` functions +
  // a `React.router` root that switches on `CurrentPage`.  Detail pages take
  // the route `id`.
  const views = routed
    ? [
        ...pages.map((p) =>
          renderPageView(p, ui, aggregatesByName, pageViewFn(p), hasRouteParam(p)),
        ),
        "",
        renderRootView(pages),
      ]
    : [renderPageView(pages[0]!, ui, aggregatesByName, "view")];

  return lines(
    "module App",
    "",
    "open Feliz",
    routed && "open Feliz.Router",
    "open Elmish",
    "open Elmish.React",
    // Thoth is needed for decoders (reads) AND encoders (create forms).
    (hasReads || hasForms) && "open Thoth.Json",
    hasHttp && "open Fable.SimpleHttp",
    // Read wire layer (reads only) — records → Remote → decoders.
    hasReads && "",
    hasReads && wire.domain,
    hasReads && "",
    hasReads && REMOTE_TYPE,
    hasReads && "",
    hasReads && wire.decoders,
    // Create-form state (form record types + empty values) → encoders (write dir).
    hasForms && "",
    hasForms && formTypes,
    hasForms && "",
    hasForms && encoders,
    // Api module — reads (fetch + decode), mutations (verb request), creates (POST).
    hasHttp && "",
    hasHttp && api,
    // View helpers (reads only) — Remote matchers the QueryView renderer calls.
    hasReads && "",
    hasReads && renderViewModule(reads),
    // Routing table (multi-page only) — Page union + parseUrl, ahead of Model.
    routed && "",
    routed && renderRouting(pages),
    "",
    model,
    "",
    msg,
    // `pageCmd` (byId reads only) fires a detail read on entry; sits after Msg
    // (it references the read's `Loaded` case) and before init (which feeds it).
    pageCmd ? "" : false,
    pageCmd || undefined,
    "",
    init,
    "",
    update,
    "",
    views.join("\n"),
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
// A multi-page ui additionally pulls in Feliz.Router for URL routing.
function fsproj(hasHttp: boolean, routed: boolean): string {
  const wireRefs = hasHttp
    ? `
    <PackageReference Include="Fable.SimpleHttp" Version="3.6.0" />
    <PackageReference Include="Thoth.Json" Version="10.2.0" />`
    : "";
  const routerRef = routed
    ? `
    <PackageReference Include="Feliz.Router" Version="4.0.0" />`
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
    <PackageReference Include="Fable.Elmish.React" Version="4.0.0" />${routerRef}${wireRefs}
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
  // fsproj package refs must match what `renderAppFs` emits: SimpleHttp/Thoth
  // when there's any Http (reads or mutations), Feliz.Router when routed (>1
  // page OR a lone detail page carrying a `:id` route param).
  const hasHttp =
    readsForUi(ui, contexts).length > 0 ||
    mutationsForUi(ui, contexts).length > 0 ||
    formsForUi(ui, contexts).length > 0 ||
    operationFormsForUi(ui, contexts).length > 0;
  const routed = ui.pages.length > 1 || ui.pages.some(hasRouteParam);
  out.set("src/App.fs", renderAppFs(ui, contexts));
  out.set("App.fsproj", fsproj(hasHttp, routed));
  out.set(".config/dotnet-tools.json", DOTNET_TOOLS);
  out.set("package.json", PACKAGE_JSON(`${deployable.name}-feliz`));
  out.set("vite.config.js", VITE_CONFIG);
  out.set("index.html", INDEX_HTML);
  out.set("Dockerfile", DOCKERFILE);
  return out;
}
