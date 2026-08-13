// Flutter frontend generator — projects a Loom `ui` into a self-hosting
// Dart/Flutter (Material) app.  Flutter is NOT a vite static bundle; like the
// Feliz backend-clone frontend it owns its own build (`flutter build web` /
// native), so it dispatches straight through its own `emitProject` and is
// absent from `STATIC_BUNDLE_FRAMEWORKS`.
//
// Page bodies render through the shared `walkBody` engine with `flutterTarget`
// (the WalkerTarget seam) + the procedural `flutterMaterial` pack, exactly as
// Feliz drives `walkBody` with `felizTarget` + `felizPack()`.  The Dart
// wire-model classes come from `renderDartModels`.  The display path (List /
// Detail), forms (`CreateForm`/`OperationForm`/`WorkflowForm`/`DestroyForm`),
// `match await` async effects, Riverpod state/actions, and user components all
// emit; the remaining frontier (a handful of component variants, VO-array
// fields with non-scalar sub-fields, realtime, etc.) falls back to a diagnostic
// comment — never broken Dart.  The live gap list is `parity.ts`
// (`analyzeFlutterParity`) and `docs/generators.md` → "Flutter mobile"; the
// gap-fill plan is `docs/old/proposals/flutter-parity-and-native-gates.md`.
//
// BUILD SURFACES: one Dart source → web (served by the emitted nginx Dockerfile
// in compose), Android (`make apk`), iOS (`make ipa`).  No Dart is compiled
// locally (no Flutter SDK); `generated-flutter-build.yml` owns the "is the Dart
// real" gate — WEB ONLY, native isn't gated per-PR yet.

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
import { type PageNameCtx, pageEmitName } from "../../ir/util/page-kind.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { pageFileBase } from "../_frontend/page-identity.js";
import { storeMemberLocal } from "../_walker/js-target-helpers.js";
import type { ApiCallSite } from "../_walker/target.js";
import { type ApiHookUse, walkBody } from "../_walker/walker-core.js";
import { renderFlutterChartRuntime } from "./chart-runtime.js";
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
  formsUseFilePicker,
  renderFormsFile,
} from "./forms-emit.js";
import { flutterI18nEnabled, renderFlutterI18nModule } from "./i18n.js";
import { collectBoundInputFields, uiUsesFileUpload } from "./inputs-emit.js";
import { renderFlutterModalRuntime } from "./modal-runtime.js";
import { flutterPack, usesIntl, usesMath } from "./pack.js";
import { dartPackageName } from "./package-name.js";
import { collectFlutterReads, renderAppConfig, renderReadProviders } from "./reads-emit.js";
import { hasRiverpodState, renderRiverpod } from "./riverpod-emit.js";
import { renderFlutterStores } from "./store-builder.js";
import { storeProviderName } from "./store-names.js";

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

  // Not `snake(name)` directly — a deployable named `web` (or any other package
  // in the app's own dependency graph) would make `flutter pub get` fail before
  // the app is even compiled.  See `package-name.ts`.
  const pkg = dartPackageName(deployable.name);
  const title = upperFirst(deployable.uiName ?? deployable.name ?? sys.name);

  const ui = deployable.uiName ? sys.uis.find((u) => u.name === deployable.uiName) : undefined;

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

  // Wire-model classes for every aggregate/VO/event reachable through this
  // deployable's contexts (Track A).  One `lib/models.dart` the pages import.
  // The fixed `FileRef` class is added only when a `File` field maps to it (the
  // base render then references `FileRef`) or a `FileUpload` primitive / an
  // in-FORM `File` input is present — so File-free projects stay byte-identical.
  // An in-form File input pulls `file_picker` exactly as the standalone
  // primitive does (both run pick → multipart `POST /files` → `FileRef`).
  // The reads are collected FIRST because an entity-history read pulls the
  // `AuditEntry`/`AuditFieldChange` wire models into `lib/models.dart` (the
  // `auditEntry` flag riding the same opt-in rule); the providers file itself
  // is emitted further down, next to the other read wiring.
  const reads = collectFlutterReads(ui, contexts);
  const auditEntry = reads.some((r) => r.history === true);
  const usesFileUpload = uiUsesFileUpload(ui) || formsUseFilePicker(forms);
  const baseModels = renderDartModels(contexts, { auditEntry });
  const needsFileRef = usesFileUpload || baseModels.includes("FileRef");
  out.set(
    "lib/models.dart",
    needsFileRef ? renderDartModels(contexts, { fileRef: true, auditEntry }) : baseModels,
  );

  // Riverpod read providers — one `FutureProvider` per distinct QueryView read
  // a page issues (fetch over `package:http` + Track A `fromJson`; collected
  // above, ahead of the models emit).  Emitted only when the ui issues reads,
  // alongside the `AppConfig` api-base helper.
  if (reads.length > 0) {
    out.set("lib/reads.dart", renderReadProviders(reads));
  }

  // i18n (M-T1.11 Flutter runtime): when this ui has extractable user-visible
  // strings, every literal text slot in a page/component body emits
  // `t("<key>", "<default>")` (keyed identically to the catalog via the SHARED
  // walker seam) and the app ships `lib/i18n.dart` — the Dart-language sibling
  // of the JS frontends' `src/i18n.ts` shim.  Empty catalog → no file, the walks
  // pass no prefix, and every emitted widget is byte-identical to pre-i18n.
  const i18nEnabled = ui ? flutterI18nEnabled(ui) : false;
  if (ui && i18nEnabled) {
    out.set("lib/i18n.dart", renderFlutterI18nModule(ui));
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
    i18nEnabled,
  };
  const componentParams: ReadonlyMap<string, readonly ParamIR[]> = ui
    ? emittableComponentParams(ui.components, componentCtx)
    : new Map();

  // Which of each store's members are STATE and which are ACTIONS.  The walk
  // records only member NAMES (`usedStores`), and the two bind differently in a
  // `ConsumerWidget` — a field is a `ref.watch(…select…)`, an action a
  // `ref.read(….notifier).<action>` tear-off — so the shell needs the split.
  const storeMembers = new Map<string, { fields: Set<string>; actions: Set<string> }>(
    (ui?.stores ?? []).map((s) => [
      s.name,
      {
        fields: new Set(s.state.map((f) => f.name)),
        actions: new Set(s.actions.map((a) => a.name)),
      },
    ]),
  );

  const pages = ui?.pages ?? [];
  // Name-context for `pageEmitName` — the served declarations a role-named
  // scaffold page (`List` in `area Products`) classifies against.
  const nameCtx: PageNameCtx = {
    aggregateNames: [...aggregatesByName.keys()],
    workflowNames: [...workflowsByName.keys()],
  };
  const usedComponents = new Set<string>();
  const rendered = pages.map((page) => {
    const r = renderPage(page, ui as UiIR, contexts, aggregatesByName, bcByAggregate, {
      workflowsByName,
      bcByWorkflow,
      componentParams,
      i18nEnabled,
      storeMembers,
      nameCtx,
    });
    for (const name of r.usedComponents) usedComponents.add(name);
    return { page, ...r };
  });

  // Store modules (named-actions-and-stores.md §3, Stage 5) — one Riverpod
  // triad per `store Cart { … }` in `lib/stores.dart`.  Emitted whenever the ui
  // DECLARES a store, not only where one is used: an unused Dart top-level
  // declaration is inert (unlike an unused import), and the file is what the
  // page shells import.
  const storesFile = ui ? renderFlutterStores(ui.stores, contexts) : undefined;
  if (storesFile) out.set("lib/stores.dart", storesFile);

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
  // The controlled-Modal bridge — emitted only when a page opens one, matched to
  // the same marker the per-page import sniffs so neither can dangle.
  if (rendered.some((r) => r.source.includes("LoomModalHost("))) {
    out.set("lib/modal.dart", renderFlutterModalRuntime());
  }
  // The chart painter — same use-driven rule and the same marker discipline as
  // the modal bridge above, so the file and the per-page import cannot dangle.
  if (rendered.some((r) => r.source.includes("LoomChart("))) {
    out.set("lib/chart.dart", renderFlutterChartRuntime());
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

  out.set("pubspec.yaml", renderPubspec(pkg, deployable.name, usesFileUpload));
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
  out.set("Makefile", renderMakefile(pkg, usesFileUpload));
  out.set("README.md", renderReadme(title, pkg));
  // Runtime e2e (Phase 4) — a headless `flutter_test` widget smoke that boots
  // the real app and asserts it renders.  Unlike an `integration_test` (needs a
  // device/emulator) this runs under plain `flutter test` on any host, so it
  // gates "does the app actually RUN", not just compile.  Data reads fire on
  // mount and settle to their loading/error branch with no backend — the tree
  // still builds, which is exactly what the smoke proves.
  out.set("test/widget_test.dart", renderWidgetSmokeTest(pkg));
  // A11y runtime gate (accessibility.md; docs/audits/flutter-a11y-audit-2026-07.md
  // Phase C) — the Flutter analogue of the axe-core tripwire, which can't scan a
  // canvas-rendered Flutter build.  Boots the real app with the semantics tree
  // enabled and asserts Flutter's built-in WCAG guidelines on the first frame.
  // Runs under the same `flutter test` step (whole `test/` dir) as the smoke.
  out.set("test/a11y_test.dart", renderA11yTest(pkg));

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
    /** True when the ui has extractable user-visible strings (M-T1.11) — the
     *  walk then keys every literal text slot to the catalog and emits `t(…)`.
     *  False → no prefix, and the page is byte-identical to pre-i18n. */
    i18nEnabled: boolean;
    /** Per-store field / action name split, for the shell's store bindings. */
    storeMembers: ReadonlyMap<
      string,
      { fields: ReadonlySet<string>; actions: ReadonlySet<string> }
    >;
    /** Declaration names `pageEmitName` classifies the page against — the
     *  served aggregates + workflows.  Drives the widget class + file base. */
    nameCtx: PageNameCtx;
  },
): Omit<RenderedPage, "page"> {
  const { workflowsByName, bcByWorkflow, componentParams, i18nEnabled, storeMembers, nameCtx } =
    workflows;
  // Identity comes from the page's EMIT NAME, never its bare `page.name`.  The
  // scaffold names aggregate pages by ROLE (`List` inside `area Products`), so
  // `snake(page.name)` collapsed every aggregate's list onto ONE
  // `lib/pages/list_page.dart` + one `ListPage` class: `main.dart` imported the
  // same URI twice and routed BOTH `/products` and `/customers` to whichever
  // page was rendered last.  `flutter analyze` calls a duplicate import an
  // `info`, so the CI gate (`--no-fatal-infos`) stayed green on a frontend that
  // showed the wrong aggregate.
  const emitName = pageEmitName(page, nameCtx);
  const className = `${upperFirst(emitName)}Page`;
  const fileBase = `${pageFileBase(page, nameCtx)}_page`;
  // Fallback route for a page with no `route:` — area-qualified for the same
  // reason the file base is: two route-less same-named pages in sibling areas
  // otherwise claim ONE key in the routes map and the second is dropped.
  // Area-less pages keep `/<page-snake>`, unchanged.
  const routePath = page.route ?? `/${pageFileBase(page, nameCtx)}`;

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
  let usedStores = new Map<string, Set<string>>();
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
      new Map(), // paramTypes — Flutter resolves op instances through its own seams
      new Map(), // pageRoutes
      new Set(), // externFunctions
      new Set(), // derivedNames
      false, // authUi — the Flutter frontend has no `auth: ui` gate yet
      // i18n key prefix — `page.<Name>` matches the catalog (the scaffold's
      // role-scoped `page.name`, e.g. `List`, not the router emit name);
      // undefined when the ui has no extractable strings (byte-identical).
      i18nEnabled ? `page.${page.name}` : undefined,
    );
    bodyWidget = result.tsx.trim() || bodyWidget;
    usesState = result.usesState;
    usesRouteId = result.usesRouteId;
    usedApiHooks = result.usedApiHooks;
    usedStores = result.usedStores ?? usedStores;
    for (const a of result.usedActions ?? []) usedActions.add(a);
    for (const c of result.usedUserComponents) usedComponents.add(c);
  }

  // A page becomes a Riverpod `ConsumerWidget` (bound to `ref`) when it either
  // projects reactive state / actions (Track D) OR issues a QueryView read
  // (this slice — `ref.watch(<var>Provider)`).  Display-only pages with neither
  // stay plain `StatelessWidget`s (Track A/B/C skeleton).
  const stateful = hasRiverpodState(page) && (usesState || usedActions.size > 0);
  // A store read/call needs a `WidgetRef` too (`ref.watch(cartProvider…)`), so a
  // page whose only reactive input is a store is still a `ConsumerWidget` — the
  // StatelessWidget path has no `ref` to bind against.
  const consumer = stateful || usedApiHooks.size > 0 || usedStores.size > 0;
  const apiParamNames = new Map(ui.apiParams.map((p) => [p.name, p.apiName]));
  const usesComponent = usedComponents.size > 0;
  const source = consumer
    ? renderConsumerPage(
        page,
        className,
        {
          usesState,
          usedActions,
          usedApiHooks,
          usesRouteId,
          routeParams: [...paramNames],
          stateful,
          hostsForm,
          usesComponent,
          usedStores,
          storeMembers,
        },
        bodyWidget,
        contexts,
        apiParamNames,
        emitName,
      )
    : renderStatelessPage(page, className, bodyWidget, {
        usesRouteId,
        routeParams: [...paramNames],
        hostsForm,
        usesComponent,
      });

  return { fileBase, className, routePath, source, usedComponents };
}

/** Bindings for a page's ROUTE arguments.
 *
 *  Two sources, one shape.  The magic route `id` (`Order.byId(id)`) sets
 *  `usesRouteId`; a page that DECLARES route params (`page Detail { route:
 *  "/products/:id" }`) resolves those names as ordinary param refs during the
 *  walk, and the walker emits them verbatim — so a scaffolded detail page
 *  referenced `id` with nothing declaring it (`Undefined name 'id'`, and the
 *  page did not compile).  Both now bind here.
 *
 *  A single argument arrives as the bare `String` today; a Map is read
 *  by-name so a future multi-param route needs no new shape.  Deduped, since
 *  `usesRouteId` and a declared `id` param name the same local. */
function routeArgBindings(paramNames: readonly string[], needsId: boolean): string[] {
  const names = [...new Set([...(needsId ? ["id"] : []), ...paramNames])];
  if (names.length === 0) return [];
  const out = ["    final routeArgs = ModalRoute.of(context)?.settings.arguments;"];
  for (const n of names) {
    out.push(
      `    final ${n} = routeArgs is Map ? (routeArgs['${n}'] as String? ?? '') ` +
        `: (routeArgs as String? ?? '');`,
    );
  }
  return out;
}

/** What a `ConsumerWidget` page's `build` binds — reactive state/actions (Track
 *  D) and/or QueryView read hoists (this slice). */
interface ConsumerBindings {
  usesState: boolean;
  usedActions: ReadonlySet<string>;
  usedApiHooks: ReadonlyMap<string, ApiHookUse>;
  usesRouteId: boolean;
  /** Route params the page DECLARES (`route: "/products/:id"`), bound from the
   *  route arguments alongside the magic `id`. */
  routeParams: readonly string[];
  stateful: boolean;
  /** Page hosts a form widget → imports `../forms.dart`. */
  hostsForm: boolean;
  /** Page invokes a user component → imports `../components.dart`. */
  usesComponent: boolean;
  /** Stores this body touched, keyed to the member names used (Stage 5). */
  usedStores: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-store field / action split, so each used member binds the right way. */
  storeMembers: ReadonlyMap<string, { fields: ReadonlySet<string>; actions: ReadonlySet<string> }>;
}

/** Bind one local per used store member, matching the body's use site
 *  (`storeMemberLocal` — the SAME collision-resolved name walker-core gave it).
 *  A field binds a granular `.select` watch so the page rebuilds on that cell
 *  alone; an action binds the notifier method as a tear-off, so the body's
 *  `<local>(args)` call resolves.  A member the store doesn't declare as state
 *  is treated as an action — the validator has already rejected an unknown
 *  member, so the fallback can only be an action. */
function storeBindings(
  usedStores: ReadonlyMap<string, ReadonlySet<string>>,
  storeMembers: ReadonlyMap<string, { fields: ReadonlySet<string>; actions: ReadonlySet<string> }>,
  reserved: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const storeName of [...usedStores.keys()].sort()) {
    const provider = storeProviderName(storeName);
    const fields = storeMembers.get(storeName)?.fields ?? new Set<string>();
    for (const member of [...(usedStores.get(storeName) ?? [])].sort()) {
      const local = storeMemberLocal(storeName, member, reserved);
      out.push(
        fields.has(member)
          ? `    final ${local} = ref.watch(${provider}.select((s) => s.${member}));`
          : `    final ${local} = ref.read(${provider}.notifier).${member};`,
      );
    }
  }
  return out;
}

/** Display-only page → a plain `StatelessWidget`.  The body references no
 *  wire-model types, so it imports only material.dart — importing
 *  lib/models.dart here would be an `unused_import` under `flutter analyze`.
 *  Full parity (data-bound pages) adds the models import at the point a page
 *  actually references a model class.  A form-hosting page still stays a
 *  `StatelessWidget` (each form is its own `StatefulWidget`) — it imports
 *  `../forms.dart` and, when a form carries the route id (op / destroy), binds
 *  `id` from the route arguments in `build`. */
/** True when a rendered Dart fragment calls the generated translation runtime
 *  (M-T1.11) — the walker emits a bare `t("<key>", "<default>")`, so the page
 *  file needs `import '../i18n.dart';`.  The lookbehind keeps `Text(` /
 *  `DefaultTextStyle.merge(` and any other identifier ending in `t` from
 *  matching; only a standalone `t(` counts. */
function usesI18n(dart: string): boolean {
  return /(?<![A-Za-z0-9_$.])t\(/.test(dart);
}

function renderStatelessPage(
  page: PageIR,
  className: string,
  bodyWidget: string,
  opts: {
    usesRouteId: boolean;
    routeParams: readonly string[];
    hostsForm: boolean;
    usesComponent: boolean;
  },
): string {
  const imports = ["import 'package:flutter/material.dart';"];
  if (opts.hostsForm) imports.push("import '../forms.dart';");
  // The controlled-Modal bridge, imported only where a page actually opens one
  // (an unused Dart import is an analyzer warning, and `flutter analyze` is a
  // per-PR gate).  Same content-sniff as `apiUri(` below.
  if (bodyWidget.includes("LoomModalHost(")) imports.push("import '../modal.dart';");
  if (bodyWidget.includes("LoomChart(")) imports.push("import '../chart.dart';");
  if (opts.usesComponent) imports.push("import '../components.dart';");
  // An `Action(<instance>.<op>)` button POSTs inline via `apiUri(` — the only
  // page-body reference to it — so import http + the base-URL helper on demand.
  if (bodyWidget.includes("apiUri(")) {
    imports.push("import 'package:http/http.dart' as http;", "import '../config.dart';");
  }
  if (usesIntl(bodyWidget)) imports.push("import 'package:intl/intl.dart';");
  // The generated translation runtime (M-T1.11) — imported only when a text slot
  // in this page actually resolved to a `t(…)` call.
  if (usesI18n(bodyWidget)) imports.push("import '../i18n.dart';");
  // `min`/`max`/`round` scalar intrinsics route through `math.*` (`dart-expr.ts`).
  if (usesMath(bodyWidget)) imports.push("import 'dart:math' as math;");
  const idBinding = routeArgBindings(opts.routeParams, opts.usesRouteId);
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
  /** The page's emit name — see `renderRiverpod`'s `emitName` param. */
  emitName: string,
): string {
  // Project reactive state / actions first — its `asyncEffectActions` decide
  // whether the page needs the route `id` (an async-effect method takes it).
  let projSource = "";
  let providerName = "";
  let asyncEffectActions = new Set<string>();
  if (b.stateful) {
    const proj = renderRiverpod(page, contexts, apiParamNames, emitName);
    projSource = proj.source;
    providerName = proj.providerName;
    asyncEffectActions = proj.asyncEffectActions;
  }
  const usesAsyncEffect = [...b.usedActions].some((a) => asyncEffectActions.has(a));
  // A `match await` effect's Notifier method takes the route id, so bind it even
  // when no byId read did.
  const needsId = b.usesRouteId || usesAsyncEffect;

  const bindings: string[] = [];
  // Route args first — a byId read's `ref.watch(<var>Provider(id))`, an
  // async-effect closure and any declared route param all read them.
  bindings.push(...routeArgBindings(b.routeParams, needsId));
  // Page STATE before the read hoists — a server-paged read watches a family
  // keyed by `state.pageNum` / `state.sortKey`, so the binding it reads has to
  // exist first.  Dart is not hoisted: the reverse order is a hard
  // `referenced_before_declaration`, which is exactly how every scaffolded
  // Flutter list page failed to compile.
  if (b.stateful && b.usesState) {
    bindings.push(`    final state = ref.watch(${providerName});`);
  }
  // Store locals next — a store field can key a read the same way page state
  // can, and the body references the bare local either way.  Reserved against
  // the page's own bindings so a `Cart.items` read beside a `items` state cell
  // binds `cartItems`, exactly as walker-core resolved the use site.
  bindings.push(
    ...storeBindings(
      b.usedStores,
      b.storeMembers,
      new Set([
        ...page.state.map((s) => s.name),
        ...b.routeParams,
        ...page.derived.map((d) => d.name),
      ]),
    ),
  );
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
    // Controlled-input setter tear-offs — each bound input dispatches a bare
    // `set<Field>(v)` (or `set<Field>Text(v)` for NumberField), which resolves
    // to one of these page-shell locals.  Only the bound setters (an unused
    // `final` tear-off is a `flutter analyze` warning → CI red).
    const boundSetters = collectBoundInputFields(page.body, new Set(page.state.map((s) => s.name)));
    // A `Table`'s sort header / pager writes state directly through the
    // Notifier without being an action or a bound input, so neither set above
    // sees it — detect the reference in the rendered body, the same way the
    // `apiUri(` / `Intl` imports are decided.  Without this the controls emit
    // `notifier.setSortKey(…)` against nothing (`Undefined name 'notifier'`).
    const bodyWritesState = bodyWidget.includes("notifier.");
    if (b.usedActions.size > 0 || boundSetters.length > 0 || bodyWritesState) {
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
      for (const { setter } of boundSetters) {
        bindings.push(`    final ${setter} = notifier.${setter};`);
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
  if (b.usedStores.size > 0) imports.push("import '../stores.dart';");
  // The controlled-Modal bridge (the state-bearing page path — its stateless
  // sibling above sniffs the same marker).  A controlled Modal only exists on a
  // page WITH state, so this is the branch that actually fires.
  if (bodyWidget.includes("LoomModalHost(")) imports.push("import '../modal.dart';");
  if (bodyWidget.includes("LoomChart(")) imports.push("import '../chart.dart';");
  // Content scan over BOTH the Notifier projection AND the rendered body: a
  // `match await` method (projSource) decodes JSON + reifies wire models, and a
  // `FileUpload` (bodyWidget) does the same inline plus references `FileRef` in
  // the state class — so both positions can pull dart:convert / models / http /
  // config / file_picker.
  const scan = `${projSource}\n${bodyWidget}`;
  if (scan.includes("jsonDecode") || scan.includes("jsonEncode")) {
    imports.push("import 'dart:convert';");
  }
  // Wire-model reifications (`X.fromJson(`) and the `FileRef` state type both
  // live in `../models.dart`.
  if (scan.includes(".fromJson(") || scan.includes("FileRef")) {
    imports.push("import '../models.dart';");
  }
  // `Action(<instance>.<op>)` buttons, async-effect methods, and FileUpload POST
  // inline via `apiUri(` — import http + the base-URL helper when either does.
  if (scan.includes("apiUri(")) {
    imports.push("import 'package:http/http.dart' as http;", "import '../config.dart';");
  }
  if (usesIntl(bodyWidget) || usesIntl(projSource)) {
    imports.push("import 'package:intl/intl.dart';");
  }
  if (usesI18n(bodyWidget) || usesI18n(projSource)) {
    imports.push("import '../i18n.dart';");
  }
  // `min`/`max`/`round` scalar intrinsics route through `math.*` — over the
  // same `scan` (view body + Notifier source) the other content sniffs above use.
  if (usesMath(scan)) imports.push("import 'dart:math' as math;");
  // A FileUpload primitive picks a file via file_picker (the http / config /
  // models / dart:convert imports it also needs are added by the content scans
  // above — the widget emits `apiUri(` / `FileRef.fromJson` / `jsonDecode`).
  if (bodyWidget.includes("FilePicker.")) {
    imports.push("import 'package:file_picker/file_picker.dart';");
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

function renderPubspec(pkg: string, deployableName: string, usesFileUpload: boolean): string {
  // `file_picker` is only pulled when a FileUpload primitive is present, so a
  // File-free app's pubspec stays byte-identical.
  const filePicker = usesFileUpload ? "\n  file_picker: ^8.1.2" : "";
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
  intl: ^0.19.0${filePicker}

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
function renderMakefile(pkg: string, usesFileUpload: boolean): string {
  // A `FileUpload` primitive pulls the `file_picker` native plugin, whose
  // Android build needs compileSdk >= 36 (via `flutter_plugin_android_lifecycle`)
  // — newer than the `flutter create` template default.  A reliable auto-fix is
  // awkward (the app-level compileSdk doesn't reach plugin subprojects, and a
  // root `subprojects { afterEvaluate }` runs too late under modern Flutter's
  // Gradle ordering), so we note the one-line manual fix in a comment instead of
  // shipping a fragile override.  Omitted when no FileUpload is present.
  const filePickerNote = usesFileUpload
    ? "# NOTE: this app uses FileUpload -> the `file_picker` plugin, whose Android\n" +
      "# build needs compileSdk >= 36. If `make apk` fails on checkDebugAarMetadata,\n" +
      "# set `compileSdk = 36` in android/app/build.gradle.kts.\n"
    : "";
  return `# ${pkg} — Loom-generated Flutter app.
# One Dart source, three build surfaces.  Override the API base with
#   make apk API_BASE_URL=https://api.example.com/api
${filePickerNote}API_BASE_URL ?= /api
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
    // A page whose first frame renders a NetworkImage (Image/Avatar) hits an
    // HTTP 400 under flutter_test — drain that expected failure so it doesn't
    // fail the boot smoke.
    while (tester.takeException() != null) {}
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}
`;
}

/** `test/a11y_test.dart` — the runtime accessibility gate (Phase C of the
 *  Flutter a11y audit).  Flutter web renders to a canvas, so axe-core (the
 *  web frontends' a11y tripwire) can't traverse it; Flutter's own
 *  `flutter_test` `meetsGuideline(...)` matchers are the equivalent.  Enables
 *  the semantics tree, pumps the real `App` once (a single `pump`, not
 *  `pumpAndSettle` — reads never settle without a backend, see the smoke test),
 *  and asserts the built-in WCAG guidelines on the first frame:
 *   - tap-target size (Android 48dp / iOS 44pt),
 *   - every tappable node has a label (`labeledTapTargetGuideline`),
 *   - text meets WCAG-AA contrast (`textContrastGuideline`).
 *  Generated pages may reference `NetworkImage` sources; `flutter_test` blocks
 *  all real HTTP (status 400), which surfaces as an unrelated
 *  `NetworkImageLoadException` — drained via `takeException()` so it can't fail
 *  the a11y assertion. */
function renderA11yTest(pkg: string): string {
  return `import 'package:flutter_test/flutter_test.dart';
import 'package:${pkg}/main.dart';

void main() {
  testWidgets('boot frame meets WCAG accessibility guidelines', (WidgetTester tester) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await tester.pumpWidget(const App());
    await tester.pump();
    // Drain expected NetworkImage load failures (flutter_test returns HTTP 400
    // for every request) so they don't fail the guideline checks below.
    while (tester.takeException() != null) {}
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
    while (tester.takeException() != null) {}
    handle.dispose();
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
