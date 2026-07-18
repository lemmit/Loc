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
import { walkBody } from "../_walker/walker-core.js";
import { renderDartModels } from "./dart-model-emit.js";
import { flutterTarget } from "./flutter-target.js";
import { flutterPack } from "./pack.js";

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
  }

  const src = `${lines(
    "import 'package:flutter/material.dart';",
    "",
    "import '../models.dart';",
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

  return { fileBase, className, routePath, source: src };
}

/** `main.dart` for a multi-page ui: a `MaterialApp` with named routes, the first
 *  page as `initialRoute`. */
function renderMainWithRoutes(title: string, pages: RenderedPage[]): string {
  const home = pages[0];
  return `${lines(
    "import 'package:flutter/material.dart';",
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
    "    return MaterialApp(",
    `      title: '${escapeDart(title)}',`,
    "      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),",
    `      initialRoute: '${home.routePath}',`,
    "      routes: {",
    pages.map((p) => `        '${p.routePath}': (context) => const ${p.className}(),`),
    "      },",
    "    );",
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

import 'pages/home_page.dart';

void main() {
  runApp(const App());
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${escapeDart(title)}',
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.indigo),
      home: const HomePage(),
    );
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

/** Re-indent a possibly-multiline widget expression so its continuation lines
 *  sit under the opening `child:` column. */
function indentContinuation(widget: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  const [first, ...rest] = widget.split("\n");
  if (rest.length === 0) return first;
  return [first, ...rest.map((line) => (line ? pad + line : line))].join("\n");
}
