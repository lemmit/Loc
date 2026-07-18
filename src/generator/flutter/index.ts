// Flutter frontend generator — projects a Loom `ui` into a self-hosting
// Dart/Flutter (Material) app.  Flutter is NOT a vite static bundle; like the
// Feliz backend-clone frontend it owns its own build (`flutter build web` /
// native), so it dispatches straight through its own `emitProject` and is
// absent from `STATIC_BUNDLE_FRAMEWORKS`.
//
// WALKING SKELETON: page bodies render through the shared `walkBody` engine with
// `flutterTarget` (the WalkerTarget seam) + the procedural `flutterMaterial`
// pack, exactly as Feliz drives `walkBody` with `felizTarget` + `felizPack()`.
// The Dart wire-model classes come from `renderDartModels`.  Forms / workflows /
// match-await and the native (non-web) surface are deferred to full parity — the
// display path (List / Detail) is what the skeleton proves end-to-end.  No Dart
// is compiled locally (no Flutter SDK); `generated-flutter-build.yml` owns the
// "is the Dart real" gate.

import type {
  DeployableIR,
  EnrichedBoundedContextIR,
  PageIR,
  SystemIR,
  UiIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import type { ApiCallSite } from "../_walker/target.js";
import { type ApiHookUse, walkBody } from "../_walker/walker-core.js";
import { renderDartModels } from "./dart-model-emit.js";
import { flutterTarget } from "./flutter-target.js";
import { flutterPack } from "./pack.js";
import { collectFlutterReads, renderAppConfig, renderReadProviders } from "./reads-emit.js";
import { hasRiverpodState, renderRiverpod } from "./riverpod-emit.js";

export interface GenerateFlutterOptions {
  apiBaseUrl?: string;
}

/** Emit the file map for one `platform: flutter` deployable, paths relative to
 *  the deployable's folder under `<outdir>/`.  Mirrors the shape of
 *  `generateFelizForContexts` so the platform surface can call it uniformly. */
export function generateFlutterForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateFlutterOptions = {},
): Map<string, string> {
  void options;
  const out = new Map<string, string>();

  const pkg = snake(deployable.name) || "loom_app";
  const title = upperFirst(deployable.uiName ?? deployable.name ?? sys.name);

  const ui = deployable.uiName ? sys.uis.find((u) => u.name === deployable.uiName) : undefined;

  // Wire-model classes for every aggregate/VO/event reachable through this
  // deployable's contexts (Track A).  One `lib/models.dart` the pages import.
  out.set("lib/models.dart", renderDartModels(contexts));

  // Riverpod read providers — one `FutureProvider` per distinct QueryView read
  // a page issues (fetch over `package:http` + Track A `fromJson`).  Emitted
  // only when the ui issues reads, alongside the `AppConfig` api-base helper.
  const reads = collectFlutterReads(ui, contexts);
  if (reads.length > 0) {
    out.set("lib/reads.dart", renderReadProviders(reads));
    out.set("lib/config.dart", renderAppConfig());
  }

  // The aggregates reachable through this deployable — used for the fallback
  // home page when the ui declares no pages of its own.
  const aggregates = contexts.flatMap((c) => c.aggregates.map((a) => a.name));

  const pages = ui?.pages ?? [];
  const rendered = pages.map((page) => ({ page, ...renderPage(page, ui as UiIR, contexts) }));

  if (rendered.length > 0) {
    for (const r of rendered) {
      out.set(`lib/pages/${r.fileBase}.dart`, r.source);
    }
    out.set("lib/main.dart", renderMainWithRoutes(title, rendered));
  } else {
    out.set("lib/main.dart", renderMain(title));
    out.set("lib/pages/home_page.dart", renderHomePage(title, aggregates));
  }

  out.set("pubspec.yaml", renderPubspec(pkg, deployable.name));
  out.set("analysis_options.yaml", ANALYSIS_OPTIONS);
  // Web platform scaffold — `flutter build web` refuses a project with no
  // `web/index.html` ("This project is not configured for the web").  Emit the
  // minimal loader shell + PWA manifest (no icon refs → no dangling assets).
  out.set("web/index.html", renderWebIndexHtml(title));
  out.set("web/manifest.json", renderWebManifest(pkg, title));
  out.set("Dockerfile", DOCKERFILE);

  return out;
}

interface RenderedPage {
  page: PageIR;
  fileBase: string;
  className: string;
  routePath: string;
  source: string;
}

/** Render one `ui` page into a Flutter `StatelessWidget` whose `build` returns
 *  the widget tree the shared walker produced from the page body. */
function renderPage(
  page: PageIR,
  ui: UiIR,
  contexts: EnrichedBoundedContextIR[],
): Omit<RenderedPage, "page"> {
  const className = `${upperFirst(page.name)}Page`;
  const fileBase = `${snake(page.name)}_page`;
  const routePath = page.route ?? `/${snake(page.name)}`;

  const aggregatesByName = new Map(contexts.flatMap((c) => c.aggregates.map((a) => [a.name, a])));
  const paramNames = new Set(page.params.map((p) => p.name));
  const stateNames = new Set(page.state.map((s) => s.name));

  let bodyWidget = "const Center(child: Text('Empty page'))";
  let usesState = false;
  let usesRouteId = false;
  const usedActions = new Set<string>();
  let usedApiHooks = new Map<string, ApiHookUse>();
  if (page.body) {
    const result = walkBody(
      page.body,
      flutterTarget,
      flutterPack(),
      paramNames,
      stateNames,
      new Map(), // userComponents
      ui.apiParams,
      aggregatesByName,
    );
    bodyWidget = result.tsx.trim() || bodyWidget;
    usesState = result.usesState;
    usesRouteId = result.usesRouteId;
    usedApiHooks = result.usedApiHooks;
    for (const a of result.usedActions ?? []) usedActions.add(a);
  }

  // A page becomes a Riverpod `ConsumerWidget` (bound to `ref`) when it either
  // projects reactive state / actions (Track D) OR issues a QueryView read
  // (this slice — `ref.watch(<var>Provider)`).  Display-only pages with neither
  // stay plain `StatelessWidget`s (Track A/B/C skeleton).
  const stateful = hasRiverpodState(page) && (usesState || usedActions.size > 0);
  const consumer = stateful || usedApiHooks.size > 0;
  const source = consumer
    ? renderConsumerPage(
        page,
        className,
        { usesState, usedActions, usedApiHooks, usesRouteId, stateful },
        bodyWidget,
        contexts,
      )
    : renderStatelessPage(page, className, bodyWidget);

  return { fileBase, className, routePath, source };
}

/** What a `ConsumerWidget` page's `build` binds — reactive state/actions (Track
 *  D) and/or QueryView read hoists (this slice). */
interface ConsumerBindings {
  usesState: boolean;
  usedActions: ReadonlySet<string>;
  usedApiHooks: ReadonlyMap<string, ApiHookUse>;
  usesRouteId: boolean;
  stateful: boolean;
}

/** Display-only page → a plain `StatelessWidget`.  The body references no
 *  wire-model types, so it imports only material.dart — importing
 *  lib/models.dart here would be an `unused_import` under `flutter analyze`.
 *  Full parity (data-bound pages) adds the models import at the point a page
 *  actually references a model class. */
function renderStatelessPage(page: PageIR, className: string, bodyWidget: string): string {
  return `${lines(
    "import 'package:flutter/material.dart';",
    "",
    `class ${className} extends StatelessWidget {`,
    `  const ${className}({super.key});`,
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    "    return Scaffold(",
    `      appBar: AppBar(title: const Text('${escapeDart(page.name)}')),`,
    "      body: SingleChildScrollView(",
    `        child: ${indentContinuation(bodyWidget, 8)},`,
    "      ),",
    "    );",
    "  }",
    "}",
  )}\n`;
}

/** ConsumerWidget page → a Riverpod-bound widget.  The build binds, in order:
 *  the route `id` (a byId read's family key, from the route arguments); one
 *  `AsyncValue` per QueryView read (`ref.watch(<var>Provider)`, consumed by the
 *  QueryView pack's `.when`); and — for a stateful page — the projected state
 *  class + Notifier (preceding the widget in the same file), the watched
 *  `state`, the `notifier`, and one tear-off per referenced action.  Each
 *  binding + import is emitted only when USED, so an unused local / import never
 *  trips `flutter analyze`. */
function renderConsumerPage(
  page: PageIR,
  className: string,
  b: ConsumerBindings,
  bodyWidget: string,
  contexts: EnrichedBoundedContextIR[],
): string {
  const bindings: string[] = [];
  // Route `id` first — a byId read's `ref.watch(<var>Provider(id))` reads it.
  if (b.usesRouteId) {
    bindings.push("    final id = (ModalRoute.of(context)?.settings.arguments as String?) ?? '';");
  }
  // QueryView read hoists (`final <var> = ref.watch(<var>Provider…);`).
  if (b.usedApiHooks.size > 0) {
    const uses: ApiCallSite[] = [...b.usedApiHooks.values()].map((h) => ({
      apiHandle: "",
      aggregateName: "",
      operation: "",
      kind: "query",
      args: [],
      varName: h.varName,
      argsRendered: h.argsRendered,
    }));
    bindings.push(...flutterTarget.renderApiHoisting(uses));
  }
  // Reactive state / actions — only when the page projects them.
  let projSource = "";
  if (b.stateful) {
    const proj = renderRiverpod(page, contexts);
    projSource = proj.source;
    if (b.usesState) bindings.push(`    final state = ref.watch(${proj.providerName});`);
    if (b.usedActions.size > 0) {
      bindings.push(`    final notifier = ref.read(${proj.providerName}.notifier);`);
      for (const a of [...b.usedActions].sort()) {
        bindings.push(`    final ${a} = notifier.${a};`);
      }
    }
  }
  const imports = [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
  ];
  if (b.usedApiHooks.size > 0) imports.push("import '../reads.dart';");
  return `${lines(
    ...imports,
    "",
    ...(projSource ? [projSource, ""] : []),
    `class ${className} extends ConsumerWidget {`,
    `  const ${className}({super.key});`,
    "",
    "  @override",
    "  Widget build(BuildContext context, WidgetRef ref) {",
    bindings,
    "    return Scaffold(",
    `      appBar: AppBar(title: const Text('${escapeDart(page.name)}')),`,
    "      body: SingleChildScrollView(",
    `        child: ${indentContinuation(bodyWidget, 8)},`,
    "      ),",
    "    );",
    "  }",
    "}",
  )}\n`;
}

/** `main.dart` for a multi-page ui: a `MaterialApp` with named routes, the first
 *  page as `initialRoute`. */
function renderMainWithRoutes(title: string, pages: RenderedPage[]): string {
  const home = pages[0];
  return `${lines(
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
    "",
    pages.map((p) => `import 'pages/${p.fileBase}.dart';`),
    "",
    "void main() {",
    "  runApp(const App());",
    "}",
    "",
    "class App extends StatelessWidget {",
    "  const App({super.key});",
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    // ProviderScope roots the Riverpod container for every stateful page's
    // Notifier; nested in App.build (not around runApp) so `runApp(const App())`
    // stays const-clean.
    "    return ProviderScope(child: MaterialApp(",
    `      title: '${escapeDart(title)}',`,
    "      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),",
    `      initialRoute: '${home.routePath}',`,
    "      routes: {",
    pages.map((p) => `        '${p.routePath}': (context) => const ${p.className}(),`),
    "      },",
    "    ));",
    "  }",
    "}",
  )}\n`;
}

function renderPubspec(pkg: string, deployableName: string): string {
  return `name: ${pkg}
description: "Generated Flutter app for ${deployableName} (Loom)."
publish_to: "none"
version: 0.1.0

environment:
  sdk: ">=3.4.0 <4.0.0"

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  flutter_riverpod: ^2.5.1

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`;
}

const ANALYSIS_OPTIONS = `include: package:flutter_lints/flutter.yaml
`;

/** `web/index.html` — the loader shell `flutter build web` requires.  `base
 *  href` is the `$FLUTTER_BASE_HREF` placeholder the build rewrites; the app
 *  boots via `flutter_bootstrap.js` (injected at build time).  No favicon/icon
 *  links (those assets aren't emitted) so there are no dangling references. */
function renderWebIndexHtml(title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <base href="$FLUTTER_BASE_HREF">
  <meta charset="UTF-8">
  <meta content="IE=Edge" http-equiv="X-UA-Compatible">
  <meta name="description" content="Generated Flutter app (Loom).">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="${escapeHtml(title)}">
  <title>${escapeHtml(title)}</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
`;
}

/** `web/manifest.json` — the PWA manifest.  No `icons` array (no icon assets
 *  are emitted), so nothing dangles. */
function renderWebManifest(pkg: string, title: string): string {
  return `${JSON.stringify(
    {
      name: title,
      short_name: title,
      start_url: ".",
      display: "standalone",
      background_color: "#0175C2",
      theme_color: "#0175C2",
      description: `Generated Flutter app: ${pkg} (Loom).`,
      orientation: "portrait-primary",
      prefer_related_applications: false,
    },
    null,
    2,
  )}\n`;
}

// Self-hosting web build — mirrors the Feliz Dockerfile shape (SDK build stage →
// nginx runtime serving the static bundle on :3000 with SPA fallback).  The
// compose service references \`build: ./\`, so the Flutter bundle is produced at
// image-build time, not fetched.
const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM ghcr.io/cirruslabs/flutter:stable AS build
WORKDIR /app
COPY pubspec.yaml ./
RUN flutter pub get
COPY . .
RUN flutter build web --release

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/build/web /usr/share/nginx/html
RUN printf 'server { listen 3000; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' \\
  > /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
`;

// --- Fallback (no ui pages) skeleton widgets --------------------------------

function renderMain(title: string): string {
  return `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'pages/home_page.dart';

void main() {
  runApp(const App());
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return ProviderScope(child: MaterialApp(
      title: '${escapeDart(title)}',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
      home: const HomePage(),
    ));
  }
}
`;
}

function renderHomePage(title: string, aggregates: readonly string[]): string {
  const tiles =
    aggregates.length > 0
      ? aggregates.map((a) => `          const ListTile(title: Text('${a}')),`).join("\n")
      : "          const ListTile(title: Text('Loom Flutter skeleton')),";
  return `import 'package:flutter/material.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${escapeDart(title)}')),
      body: ListView(
        children: [
${tiles}
        ],
      ),
    );
  }
}
`;
}

/** Escape a bare identifier/title for embedding in a single-quoted Dart string. */
function escapeDart(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$");
}

/** Escape a title for HTML text/attribute context (web/index.html). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Re-indent a possibly-multiline widget expression so its continuation lines
 *  sit under the opening `child:` column. */
function indentContinuation(widget: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  const [first, ...rest] = widget.split("\n");
  if (rest.length === 0) return first;
  return [first, ...rest.map((line) => (line ? pad + line : line))].join("\n");
}
