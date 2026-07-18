// Flutter frontend generator — projects a Loom `ui` into a self-hosting
// Dart/Flutter (Material) app.  Flutter is NOT a vite static bundle; like the
// Feliz backend-clone frontend it owns its own build (`flutter build web` /
// native), so it dispatches straight through its own `emitProject` and is
// absent from `STATIC_BUNDLE_FRAMEWORKS`.
//
// PHASE 0 STATUS: this emits a MINIMAL but coherent Flutter project skeleton —
// `pubspec.yaml`, `lib/main.dart` (a trivial `MaterialApp`), and one placeholder
// home page.  It does NOT yet render real page bodies through `walkBody` /
// `flutterTarget`; the Phase 1 fan-out tracks (Dart wire model, the walker seam
// object, the Material pack, the Riverpod projector) fill that in place.

import type { DeployableIR, EnrichedBoundedContextIR, SystemIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

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
  // The aggregates reachable through this deployable's contexts — surfaced as
  // placeholder list tiles so the skeleton reflects the model (Phase 1 replaces
  // this with real per-page widget trees walked from the `ui`).
  const aggregates = contexts.flatMap((c) => c.aggregates.map((a) => a.name));

  out.set("pubspec.yaml", renderPubspec(pkg, deployable.name));
  out.set("lib/main.dart", renderMain(title));
  out.set("lib/pages/home_page.dart", renderHomePage(title, aggregates));

  return out;
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
      title: '${title}',
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
      appBar: AppBar(title: const Text('${title}')),
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
