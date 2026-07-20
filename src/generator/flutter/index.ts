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
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  PageIR,
  ParamIR,
  SystemIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import type { ApiCallSite } from "../_walker/target.js";
import { type ApiHookUse, walkBody } from "../_walker/walker-core.js";
import {
  type ComponentWalkCtx,
  emittableComponentParams,
  renderComponentsFile,
} from "./component-emit.js";
import { renderDartModels } from "./dart-model-emit.js";
import { flutterTarget } from "./flutter-target.js";
import {
  collectFlutterForms,
  collectFlutterWorkflowForms,
  collectPageForms,
  collectPageWorkflowForms,
  renderFormsFile,
} from "./forms-emit.js";
import { flutterPack, usesIntl } from "./pack.js";
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

  // Aggregate + owning-bounded-context lookups, built once — threaded into the
  // walker (form seams resolve the aggregate's create-input / op params + the
  // BC's enums / value objects) and the form projector.
  const aggregatesByName = new Map<string, EnrichedAggregateIR>();
  const bcByAggregate = new Map<string, EnrichedBoundedContextIR>();
  const workflowsByName = new Map<string, WorkflowIR>();
  const bcByWorkflow = new Map<string, EnrichedBoundedContextIR>();
  for (const c of contexts) {
    for (const a of c.aggregates) {
      aggregatesByName.set(a.name, a);
      bcByAggregate.set(a.name, c);
    }
    for (const w of c.workflows) {
      workflowsByName.set(w.name, w);
      bcByWorkflow.set(w.name, c);
    }
  }

  // Form widgets — one self-contained `StatefulWidget` per CreateForm /
  // OperationForm / DestroyForm a page hosts (POST/DELETE over package:http),
  // plus one per WorkflowForm(runs:) (POST the workflow params to /workflows/<wf>).
  const forms = [
    ...collectFlutterForms(ui, aggregatesByName, bcByAggregate),
    ...collectFlutterWorkflowForms(ui, workflowsByName, bcByWorkflow, aggregatesByName),
  ];

  // Riverpod read providers — one `FutureProvider` per distinct QueryView read
  // a page issues (fetch over `package:http` + Track A `fromJson`).  Emitted
  // only when the ui issues reads, alongside the `AppConfig` api-base helper.
  const reads = collectFlutterReads(ui, contexts);
  if (reads.length > 0) {
    out.set("lib/reads.dart", renderReadProviders(reads));
  }
  if (forms.length > 0) {
    out.set("lib/forms.dart", renderFormsFile(forms));
  }

  // The aggregates reachable through this deployable — used for the fallback
  // home page when the ui declares no pages of its own.
  const aggregates = contexts.flatMap((c) => c.aggregates.map((a) => a.name));

  // Emittable user components (stateless, value-param, no-read) → threaded into
  // the page walker so a `Foo(...)` invocation resolves to the generated widget.
  const componentCtx: ComponentWalkCtx = {
    apiParams: ui?.apiParams ?? [],
    aggregatesByName,
    bcByAggregate,
  };
  const componentParams: ReadonlyMap<string, readonly ParamIR[]> = ui
    ? emittableComponentParams(ui.components, componentCtx)
    : new Map();

  const pages = ui?.pages ?? [];
  const usedComponents = new Set<string>();
  const rendered = pages.map((page) => {
    const r = renderPage(page, ui as UiIR, contexts, aggregatesByName, bcByAggregate, {
      workflowsByName,
      bcByWorkflow,
      componentParams,
    });
    for (const name of r.usedComponents) usedComponents.add(name);
    return { page, ...r };
  });

  if (ui && usedComponents.size > 0) {
    const componentsFile = renderComponentsFile(
      ui.components,
      usedComponents,
      componentParams,
      componentCtx,
    );
    if (componentsFile) out.set("lib/components.dart", componentsFile);
  }

  // `AppConfig`/`apiUri` is shared by the read providers, the form widgets, AND
  // `Action(<instance>.<op>)` buttons (which POST inline via `apiUri(`).  Emit it
  // when any of the three is present, so no page's import dangles.
  const usesActionHttp = rendered.some((r) => r.source.includes("apiUri("));
  if (reads.length > 0 || forms.length > 0 || usesActionHttp) {
    out.set("lib/config.dart", renderAppConfig());
  }

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
  // Native mobile surface (Phase 3).  The emitted project is a plain Flutter app
  // — it builds for web (served by the Dockerfile above) AND, with the platform
  // folders materialised, for Android/iOS.  We deliberately do NOT vendor the
  // large `android/`/`ios/` scaffolds (Gradle wrappers, manifests, Xcode
  // projects — boilerplate the Flutter SDK owns); the Makefile prepares them on
  // demand via `flutter create --platforms=…` (Flutter's supported "add a
  // platform to an existing project" flow), keeping the generated tree lean and
  // the native capability a pure function of the SDK.  Web-vs-native is a build
  // target, not a modelling mode — both are always available.
  out.set("Makefile", renderMakefile(pkg));
  out.set("README.md", renderReadme(title, pkg));
  // Runtime e2e (Phase 4) — a headless `flutter_test` widget smoke that boots
  // the real app and asserts it renders.  Unlike an `integration_test` (needs a
  // device/emulator) this runs under plain `flutter test` on any host, so it
  // gates "does the app actually RUN", not just compile.  Data reads fire on
  // mount and settle to their loading/error branch with no backend — the tree
  // still builds, which is exactly what the smoke proves.
  out.set("test/widget_test.dart", renderWidgetSmokeTest(pkg));

  return out;
}

interface RenderedPage {
  page: PageIR;
  fileBase: string;
  className: string;
  routePath: string;
  source: string;
  /** User components this page invokes — collected so the ui emits their
   *  widgets into `lib/components.dart`. */
  usedComponents: ReadonlySet<string>;
}

/** Render one `ui` page into a Flutter `StatelessWidget` whose `build` returns
 *  the widget tree the shared walker produced from the page body. */
function renderPage(
  page: PageIR,
  ui: UiIR,
  contexts: EnrichedBoundedContextIR[],
  aggregatesByName: ReadonlyMap<string, EnrichedAggregateIR>,
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR>,
  workflows: {
    workflowsByName: ReadonlyMap<string, WorkflowIR>;
    bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR>;
    componentParams: ReadonlyMap<string, readonly ParamIR[]>;
  },
): Omit<RenderedPage, "page"> {
  const { workflowsByName, bcByWorkflow, componentParams } = workflows;
  const className = `${upperFirst(page.name)}Page`;
  const fileBase = `${snake(page.name)}_page`;
  const routePath = page.route ?? `/${snake(page.name)}`;

  const paramNames = new Set(page.params.map((p) => p.name));
  const stateNames = new Set(page.state.map((s) => s.name));

  // Does this page host a form widget?  Its build references the generated
  // widget class (`CreateAggForm()` / `DeleteAggForm(id: id)` / `<Wf>WorkflowForm()`),
  // so the page imports `../forms.dart`.
  const hostsForm =
    collectPageForms(page.body, aggregatesByName, bcByAggregate).length > 0 ||
    collectPageWorkflowForms(page.body, workflowsByName, bcByWorkflow, aggregatesByName).length > 0;

  let bodyWidget = "const Center(child: Text('Empty page'))";
  let usesState = false;
  let usesRouteId = false;
  const usedActions = new Set<string>();
  let usedApiHooks = new Map<string, ApiHookUse>();
  const usedComponents = new Set<string>();
  if (page.body) {
    const result = walkBody(
      page.body,
      flutterTarget,
      flutterPack(),
      paramNames,
      stateNames,
      componentParams, // userComponents — a Foo(...) call resolves to the widget
      ui.apiParams,
      aggregatesByName,
      bcByAggregate, // form seams resolve enum / value-object types here
      workflowsByName, // WorkflowForm(runs:) resolves the workflow's params here
      bcByWorkflow, // …and its owning BC for enum / value-object resolution
    );
    bodyWidget = result.tsx.trim() || bodyWidget;
    usesState = result.usesState;
    usesRouteId = result.usesRouteId;
    usedApiHooks = result.usedApiHooks;
    for (const a of result.usedActions ?? []) usedActions.add(a);
    for (const c of result.usedUserComponents) usedComponents.add(c);
  }

  // A page becomes a Riverpod `ConsumerWidget` (bound to `ref`) when it either
  // projects reactive state / actions (Track D) OR issues a QueryView read
  // (this slice — `ref.watch(<var>Provider)`).  Display-only pages with neither
  // stay plain `StatelessWidget`s (Track A/B/C skeleton).
  const stateful = hasRiverpodState(page) && (usesState || usedActions.size > 0);
  const consumer = stateful || usedApiHooks.size > 0;
  const apiParamNames = new Map(ui.apiParams.map((p) => [p.name, p.apiName]));
  const usesComponent = usedComponents.size > 0;
  const source = consumer
    ? renderConsumerPage(
        page,
        className,
        { usesState, usedActions, usedApiHooks, usesRouteId, stateful, hostsForm, usesComponent },
        bodyWidget,
        contexts,
        apiParamNames,
      )
    : renderStatelessPage(page, className, bodyWidget, { usesRouteId, hostsForm, usesComponent });

  return { fileBase, className, routePath, source, usedComponents };
}

/** What a `ConsumerWidget` page's `build` binds — reactive state/actions (Track
 *  D) and/or QueryView read hoists (this slice). */
interface ConsumerBindings {
  usesState: boolean;
  usedActions: ReadonlySet<string>;
  usedApiHooks: ReadonlyMap<string, ApiHookUse>;
  usesRouteId: boolean;
  stateful: boolean;
  /** Page hosts a form widget → imports `../forms.dart`. */
  hostsForm: boolean;
  /** Page invokes a user component → imports `../components.dart`. */
  usesComponent: boolean;
}

/** Display-only page → a plain `StatelessWidget`.  The body references no
 *  wire-model types, so it imports only material.dart — importing
 *  lib/models.dart here would be an `unused_import` under `flutter analyze`.
 *  Full parity (data-bound pages) adds the models import at the point a page
 *  actually references a model class.  A form-hosting page still stays a
 *  `StatelessWidget` (each form is its own `StatefulWidget`) — it imports
 *  `../forms.dart` and, when a form carries the route id (op / destroy), binds
 *  `id` from the route arguments in `build`. */
function renderStatelessPage(
  page: PageIR,
  className: string,
  bodyWidget: string,
  opts: { usesRouteId: boolean; hostsForm: boolean; usesComponent: boolean },
): string {
  const imports = ["import 'package:flutter/material.dart';"];
  if (opts.hostsForm) imports.push("import '../forms.dart';");
  if (opts.usesComponent) imports.push("import '../components.dart';");
  // An `Action(<instance>.<op>)` button POSTs inline via `apiUri(` — the only
  // page-body reference to it — so import http + the base-URL helper on demand.
  if (bodyWidget.includes("apiUri(")) {
    imports.push("import 'package:http/http.dart' as http;", "import '../config.dart';");
  }
  if (usesIntl(bodyWidget)) imports.push("import 'package:intl/intl.dart';");
  const idBinding = opts.usesRouteId
    ? ["    final id = (ModalRoute.of(context)?.settings.arguments as String?) ?? '';"]
    : [];
  return `${lines(
    ...imports,
    "",
    `class ${className} extends StatelessWidget {`,
    `  const ${className}({super.key});`,
    "",
    "  @override",
    "  Widget build(BuildContext context) {",
    ...idBinding,
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
  apiParamNames: ReadonlyMap<string, string>,
): string {
  // Project reactive state / actions first — its `asyncEffectActions` decide
  // whether the page needs the route `id` (an async-effect method takes it).
  let projSource = "";
  let providerName = "";
  let asyncEffectActions = new Set<string>();
  if (b.stateful) {
    const proj = renderRiverpod(page, contexts, apiParamNames);
    projSource = proj.source;
    providerName = proj.providerName;
    asyncEffectActions = proj.asyncEffectActions;
  }
  const usesAsyncEffect = [...b.usedActions].some((a) => asyncEffectActions.has(a));
  // A `match await` effect's Notifier method takes the route id, so bind it even
  // when no byId read did.
  const needsId = b.usesRouteId || usesAsyncEffect;

  const bindings: string[] = [];
  // Route `id` first — a byId read's `ref.watch(<var>Provider(id))` and an
  // async-effect closure both read it.
  if (needsId) {
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
  if (b.stateful) {
    if (b.usesState) bindings.push(`    final state = ref.watch(${providerName});`);
    if (b.usedActions.size > 0) {
      bindings.push(`    final notifier = ref.read(${providerName}.notifier);`);
      for (const a of [...b.usedActions].sort()) {
        // An async-effect action's method takes the route id; bind it as an
        // id-capturing closure so the button's `<a>()` call stays unchanged.
        bindings.push(
          asyncEffectActions.has(a)
            ? `    final ${a} = () => notifier.${a}(id);`
            : `    final ${a} = notifier.${a};`,
        );
      }
    }
  }
  const imports = [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
  ];
  if (b.usedApiHooks.size > 0) imports.push("import '../reads.dart';");
  if (b.hostsForm) imports.push("import '../forms.dart';");
  if (b.usesComponent) imports.push("import '../components.dart';");
  // A `match await` Notifier method decodes JSON, POSTs via `apiUri`, and reifies
  // wire models — so the file needs dart:convert + http + config + models when the
  // projection uses them.
  if (projSource.includes("jsonDecode") || projSource.includes("jsonEncode")) {
    imports.push("import 'dart:convert';");
  }
  if (projSource.includes(".fromJson(")) imports.push("import '../models.dart';");
  // `Action(<instance>.<op>)` buttons and async-effect methods POST inline via
  // `apiUri(` — import http + the base-URL helper when either references it.
  if (bodyWidget.includes("apiUri(") || projSource.includes("apiUri(")) {
    imports.push("import 'package:http/http.dart' as http;", "import '../config.dart';");
  }
  if (usesIntl(bodyWidget) || usesIntl(projSource)) {
    imports.push("import 'package:intl/intl.dart';");
  }
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
  intl: ^0.19.0

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

/** `Makefile` — the build entry points for every surface.  `prepare`
 *  materialises the native platform folders on demand (they aren't vendored —
 *  see the emission note); `web` / `apk` / `ipa` build each surface from the one
 *  shared Dart source.  `API_BASE_URL` threads through as a `--dart-define`
 *  (mirrors the compose env the Dockerfile injects). */
function renderMakefile(pkg: string): string {
  return `# ${pkg} — Loom-generated Flutter app.
# One Dart source, three build surfaces.  Override the API base with
#   make apk API_BASE_URL=https://api.example.com/api
API_BASE_URL ?= /api
DEFINE = --dart-define=API_BASE_URL=$(API_BASE_URL)

.PHONY: prepare web apk ipa analyze clean

# Materialise the android/ + ios/ platform folders (owned by the Flutter SDK,
# not vendored here).  Idempotent — re-running only fills what's missing.
prepare:
	flutter create --platforms=android,ios .

web:
	flutter build web --release $(DEFINE)

apk: prepare
	flutter build apk --release $(DEFINE)

ipa: prepare
	flutter build ipa --release $(DEFINE)

analyze:
	flutter analyze

clean:
	flutter clean
`;
}

/** `test/widget_test.dart` — headless runtime smoke.  Pumps the real `App`
 *  (which roots its own `ProviderScope`) once and asserts a `MaterialApp`
 *  mounted.  A single `pump()` (not `pumpAndSettle`) is deliberate: reads fire
 *  a `FutureProvider` on mount whose future never completes without a backend,
 *  so settling would hang — the first frame already proves the app boots. */
function renderWidgetSmokeTest(pkg: string): string {
  return `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:${pkg}/main.dart';

void main() {
  testWidgets('app boots and renders a MaterialApp', (WidgetTester tester) async {
    await tester.pumpWidget(const App());
    await tester.pump();
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
`;
}

/** `README.md` — how to run and build the generated app, per surface. */
function renderReadme(title: string, pkg: string): string {
  return `# ${title}

A Loom-generated Flutter (Material 3) app on Riverpod — \`${pkg}\`.

One Dart source builds three surfaces from the same UI:

| Surface | Command | Notes |
|---|---|---|
| Web | \`make web\` | Served by the included \`Dockerfile\` in the compose stack. |
| Android | \`make apk\` | Runs \`flutter create --platforms=android,ios .\` first (materialises the native folders the SDK owns), then \`flutter build apk\`. Needs the Android SDK. |
| iOS | \`make ipa\` | Same prepare step; needs Xcode / a macOS host. |

The API base URL is a build-time define (default \`/api\`):

\`\`\`sh
make apk API_BASE_URL=https://api.example.com/api
\`\`\`

> Native platform folders (\`android/\`, \`ios/\`) are **not** vendored — they're
> boilerplate the Flutter SDK owns, so \`make prepare\` generates them on demand.
> Web-vs-native is a build target, not a modelling mode: both are always
> available from the one \`ui\`.
`;
}

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
