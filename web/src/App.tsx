import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { EditorHandle } from "./editor/editor-handle";
// Type-only.  `lsp/client.ts` imports `monaco-languageclient` and
// `editor/loom-services`, i.e. Monaco — 9.56 MB and three worker realms.  The
// client is constructed through `await import(...)` below, and only on the
// desktop surface.  See M-T8.15.
import type { LoomLspClient } from "./lsp/client";
import type { Diagnostic } from "./lsp/protocol";
import { syncWorkspaceToLsp } from "./lsp/workspace-lsp-sync";
import { buildDiagnosticsToLsp } from "./lsp/build-diagnostics";
// `agent/demo`, `agent/live` and `agent/system-prompt` are imported TYPE-ONLY
// on purpose, and their functions are reached through `await import(...)` at
// the call sites below.  Each of them has a VALUE import of `src/tools`, which
// re-exports `src/api`, which pulls `src/language` + `src/ir` — i.e. Langium,
// chevrotain and the whole grammar.  A single static import here put the entire
// Loom compiler front-end into the eager entry chunk (`chevrotain` ×25 in the
// built `index-*.js`), on the main thread, for one `runAgentDemo` symbol —
// a THIRD resident copy alongside `build.worker` and `ddd-server.worker`.
//
// That matters beyond first paint: the playground boots Postgres-in-WASM, which
// demands a 128 MB contiguous heap, and on iOS the main thread and every worker
// share one process memory budget.  See M-T8.15.
import type { AgentMessage } from "./agent/demo";
// Type-only from `src/tools` too (`Complete` etc.) — no runtime edge; this
// module's own body is small and provider-shaped.
import { createOpenAiCompatibleComplete } from "./agent/openai-transport";
import {
  type AgentSettings,
  loadAgentSettings,
  presetById,
  saveAgentSettings,
  settingsReady,
} from "./agent/provider";
import type { Complete, Message as AgentTranscriptMessage } from "../../src/tools/index.js";
import { examples, defaultExample, type LoomExample } from "./examples";
import { LoomBuildClient } from "./build/client";
import type {
  EvolutionResult,
  GenerateOk,
  GenerateResult,
  SnapshotResult,
  VfsEntry,
  VirtualFile,
} from "./build/protocol";
import { inlineSourcemapArtifacts, overlaySourcemapArtifacts } from "./build/strip-sourcemap";
import type { BundleOk } from "./bundle/protocol";
import {
  engineRegistry,
  type RuntimeDispatcher,
  type RuntimeEngine,
  selectedEngineId,
} from "./engine";
import { emptyDependencySet } from "./engine";
import { recordAndGcOpfs } from "./engine/opfs-gc";
import type { QueryResult } from "./runtime/protocol";
import {
  CUSTOM_ENDPOINT,
  buildConcretePath,
  generateExampleBody,
  parseOpenApi,
  type ApiEndpoint,
  type OpenApiDoc,
} from "./backend/openapi";
import { buildTree } from "./preview/file-tree";
import { useWorkspace } from "./workspace/use-workspace";
import { useWorkspaceSources } from "./workspace/use-workspace-sources";
import { setCrashWorkspaceProvider } from "./util/crash-context";
import { SHOW_DIAGNOSTICS_EVENT } from "./LastCrashNotice";
import { filesDroppedByExample } from "./workspace/example-import";
import { NEW_FILE_SEED, pickInitialSource } from "./workspace/initial-source";
import type { WorkspaceSourcesController } from "./workspace/workspace-sources";
import { applyGeneratedTree, readGeneratedTree, startAutoCommit } from "./workspace/git";
import {
  buildShareUrl,
  readHash,
  writeHashProject,
  writeHashSource,
  type HashLoad,
} from "./util/share";
import { fnv1a32 } from "./util/hash";
import { downloadBytes, makeZip } from "./util/zip";
import { usePersistedState } from "./util/usePersistedState";
import { useStableFns } from "./util/useStableFns";
import { initialPipelineState, pipelineReducer } from "./pipeline/reducer";
import {
  bootError as selBootError,
  bootMigrated as selBootMigrated,
  bootPersistent as selBootPersistent,
  bootedDDL as selBootedDDL,
  generateOk as selGenerateOk,
  honoBundleOk as selHonoBundleOk,
  reactBundleOk as selReactBundleOk,
} from "./pipeline/state";
import { DesktopHeader, MobileHeader } from "./layout/HeaderBar";
import { DesktopShell } from "./layout/DesktopShell";
import { MobileShell } from "./layout/MobileShell";
import { FooterBar } from "./layout/FooterBar";
import {
  type AuthStubConfig,
  DEFAULT_AUTH_STUB,
  devClaimsHeader,
  formatUnsupportedDeployables,
  type DockTab,
  type LayoutCtx,
  type MobileCodeView,
  type MobileTab,
  type ReactBundleStatus,
  type UnsupportedDeployable,
  type UnsupportedPlatform,
} from "./layout/ctx";
import type { OutputStream } from "./layout/OutputPanel";
import { useGeneratedConflicts } from "./layout/use-generated-conflicts";
import type { TestResult } from "./testing/harness";
import type { LogLine } from "./util/log-line";
import { clearPhase, markPhase } from "./util/diagnostics";

// Cap on the live console buffers (Backend / App streams) so a chatty
// handler or render loop can't grow them without bound; we keep the
// most-recent lines.
const LOG_CAP = 1000;
const capLog = (lines: LogLine[]): LogLine[] =>
  lines.length > LOG_CAP ? lines.slice(-LOG_CAP) : lines;

/** Shared "no generated files yet" identity — see the `files` derivation. */
const EMPTY_FILES: VirtualFile[] = [];

/** Per-deployable summary derived from the generated file tree.
 *  The playground only knows how to bundle + boot Hono backends and
 *  React frontends in the browser; .NET (Program.cs/csproj) and
 *  Phoenix LiveView (mix.exs) deployables are surfaced separately so
 *  the UI can say "Files-only" instead of failing with a generic
 *  "no entry found" error. */
interface DeployableAnalysis {
  /** Hono entry path (single-context root or system-mode slug folder). */
  hono: string | null;
  /** React entry path (always under a system-mode slug folder). */
  react: string | null;
  /** Deployables the browser cannot bundle/boot — listed so the UI
   *  can name them in status messages.  Empty for Hono/React-only
   *  systems. */
  unsupported: UnsupportedDeployable[];
}

function analyzeDeployables(files: VirtualFile[]): DeployableAnalysis {
  // Legacy single-context mode dumps Hono at the root with no slug —
  // there are no .NET / Phoenix outputs in that mode, so the
  // unsupported list is always empty.
  if (files.some((f) => f.path === "http/index.ts")) {
    return { hono: "http/index.ts", react: null, unsupported: [] };
  }
  let hono: string | null = null;
  let react: string | null = null;
  const platformBySlug = new Map<string, UnsupportedPlatform>();
  const angularSlugs = new Set<string>();
  for (const f of files) {
    if (!hono && /^[^/]+\/http\/index\.ts$/.test(f.path)) hono = f.path;
    if (!react && /^[^/]+\/src\/main\.tsx$/.test(f.path)) react = f.path;
    const dotnet = f.path.match(/^([^/]+)\/Program\.cs$/);
    if (dotnet) platformBySlug.set(dotnet[1], "dotnet");
    const phoenix = f.path.match(/^([^/]+)\/mix\.exs$/);
    if (phoenix) platformBySlug.set(phoenix[1], "elixir");
    // Frontend SPAs the preview engine doesn't bundle in-browser yet:
    // SvelteKit (`svelte.config.js`; its `$app/*` client + file routing
    // aren't reproduced), Vue (`src/main.ts` — the `.ts` entry, vs
    // react's `src/main.tsx`; the `.vue` SFC pipeline isn't wired), and
    // Angular (`angular.json`; its AOT/`ng build` toolchain isn't run
    // in-browser).  Angular *also* emits `src/main.ts`, so `angular.json`
    // is the discriminator and takes precedence over the Vue match below
    // (applied after the loop, order-independent of file iteration).
    // Surfaced like the backend platforms so Preview explains the grey
    // rather than showing a silent blank — the full project is in Files.
    const svelte = f.path.match(/^([^/]+)\/svelte\.config\.js$/);
    if (svelte) platformBySlug.set(svelte[1], "svelte");
    const angular = f.path.match(/^([^/]+)\/angular\.json$/);
    if (angular) angularSlugs.add(angular[1]);
    const vue = f.path.match(/^([^/]+)\/src\/main\.ts$/);
    if (vue) platformBySlug.set(vue[1], "vue");
  }
  // Angular wins over the shared `src/main.ts` Vue heuristic.
  for (const slug of angularSlugs) platformBySlug.set(slug, "angular");
  const unsupported: UnsupportedDeployable[] = [...platformBySlug]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, platform]) => ({ slug, platform }));
  return { hono, react, unsupported };
}

/** Convert a workspace-absolute `files` map from a SharedProject
 *  into the workspace-relative shape `LoomExample.files` expects.
 *  `/workspace/shared/money.ddd` → `shared/money.ddd`.  The active
 *  file is dropped — it lives on `LoomExample.source` instead. */
function workspacePathsToRelative(
  files: Record<string, string>,
  activePath: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [abs, content] of Object.entries(files)) {
    if (abs === activePath) continue;
    if (abs.startsWith("/workspace/")) {
      const rel = abs.slice("/workspace/".length);
      if (rel) out[rel] = content;
    }
  }
  return out;
}

export default function App(): JSX.Element {
  // Read once on mount.  When the URL hash carries a shareable
  // payload — single-file `s=` (legacy) or multi-file `p=` — it's
  // imported into the active workspace on mount so a recipient lands
  // on the shared project (see the workspace-open effect below).
  const hashLoadOnMount = useMemo<HashLoad | null>(() => readHash(), []);
  // A shareable URL payload (single-file `s=` or multi-file `p=`),
  // normalised into an importable shape.  It's imported into the active
  // workspace once on mount (see the workspace-open effect below) so a
  // recipient lands on the shared project — there's no longer a synthetic
  // "Shared link" entry in the example picker.
  const sharedImport = useMemo<{ source: string; files?: Record<string, string> } | null>(() => {
    if (!hashLoadOnMount) return null;
    if (hashLoadOnMount.kind === "single") return { source: hashLoadOnMount.text };
    const { files, active } = hashLoadOnMount.project;
    const source = files[active] ?? files["/workspace/main.ddd"] ?? "";
    return { source, files: workspacePathsToRelative(files, active) };
  }, [hashLoadOnMount]);

  // Responsive layout switch.  Below the Mantine `sm` breakpoint
  // (768 px) we render `MobileShell` (bottom-tab nav, fullscreen
  // panes).  Default `true` keeps SSR + Playwright's 1280-px default
  // viewport on the desktop branch — no flicker for the e2e suite.
  const isDesktop = useMediaQuery("(min-width: 768px)", true) ?? true;

  const workspace = useWorkspace();
  // Phase 2b1 of the multi-file work — the controller / hook landed
  // in Phase 2a; this is the wire-through.  `sources.activePath` is
  // locked to `/workspace/main.ddd` for now (no UI to change it
  // yet), so the VFS / generate / write call sites get the exact
  // same path string they did before.  Phase 2b2 adds the Files
  // panel that flips the active path.
  const sources = useWorkspaceSources(workspace.store);
  // Live list of generated files left with unresolved regenerate-merge
  // conflict markers — surfaced in the Output "Conflicts" stream.
  const generatedConflicts = useGeneratedConflicts(workspace.store);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [buildClientReady, setBuildClientReady] = useState(false);
  const userPickedExampleRef = useRef(false);

  // The example picker now lists only the real examples; selecting one
  // *imports* it into the active workspace (see `importExample`).  There
  // are no synthetic "Workspace" / "Shared link" entries — persisted
  // content lives in the workspace itself, and a shared URL is imported
  // on mount.
  const augmentedExamplesList: LoomExample[] = examples;

  // The example whose content was last imported into the active
  // workspace — drives the picker's displayed value only.
  const [exampleId, setExampleIdRaw] = useState(defaultExample.id);
  // Selecting an example is an explicit import into the current workspace.
  const setExampleId = (v: string): void => {
    void importExample(v);
  };

  // Content of the currently-picked example.  Drives the editor's
  // initial value for `/workspace/main.ddd`; non-main files take
  // their content from `sources.files` (Phase 2b2).
  const exampleSource = useMemo(
    () =>
      augmentedExamplesList.find((e) => e.id === exampleId)?.source ??
      defaultExample.source,
    [exampleId, augmentedExamplesList],
  );

  // Editor's seed value for the active file — the precedence rule (and
  // why `persistedSource` may only be consulted pre-hydration) lives in
  // `workspace/initial-source.ts`.  The editor remounts via
  // `key={…activePath}:{sourceEpoch}` when either changes, picking up
  // this freshly-computed value each time.
  const initialSource = useMemo(
    () =>
      pickInitialSource({
        files: sources.files,
        activePath: sources.activePath,
        hydrated: sources.hydrated,
        persistedSource: workspace.persistedSource,
        exampleSource,
      }),
    [
      sources.files,
      sources.activePath,
      sources.hydrated,
      exampleSource,
      workspace.persistedSource,
    ],
  );

  const [pipeline, dispatch] = useReducer(pipelineReducer, initialPipelineState);

  const [lspDiagnostics, setLspDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reqMethod, setReqMethod] = useState<string>("GET");
  // Generated backends mount domain routes under `/api` (`app.route("/api/products", …)`),
  // matching the frontend client's `API_BASE_URL` (= `/api`).  The HTTP-console
  // default must include that prefix or the first dispatch 404s.
  const [reqPath, setReqPath] = useState<string>("/api/products");
  const [reqBody, setReqBody] = useState<string>("");
  const [openApiSpec, setOpenApiSpec] = useState<OpenApiDoc | null>(null);
  const [apiEndpoints, setApiEndpoints] = useState<ApiEndpoint[]>([]);
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);
  const [pathParamValues, setPathParamValues] = useState<Record<string, string>>({});
  const [queryParamValues, setQueryParamValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // Agent demo (the Agent dock tab) — the deterministic M-T8.3 wedge.
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const agentSignalRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  // Live agent chat (M-T8.3): BYOK provider settings (persisted) + the raw
  // Anthropic-shaped transcript carried across turns.  `agentMessages` above is
  // the shared DISPLAY list (the demo and the live chat both render into it).
  const [agentSettings, setAgentSettingsState] = useState<AgentSettings>(() => loadAgentSettings());
  const agentTranscriptRef = useRef<AgentTranscriptMessage[]>([]);
  // Evolution-lifecycle surfaces (the Migrations dock tab): the derived
  // migration + wire-contract delta between the last-committed baseline
  // and the live edit, and the on-demand provenance snapshot capture.
  const [evolution, setEvolution] = useState<EvolutionResult | null>(null);
  const [evolutionRunning, setEvolutionRunning] = useState(false);
  // Baseline ref the Migrations tab diffs against — shared (not panel-local)
  // so the History tab can pin a milestone as the baseline in one click.
  const [evolutionBaselineRef, setEvolutionBaselineRef] = useState("HEAD");
  const [snapshotResult, setSnapshotResult] = useState<SnapshotResult | null>(null);
  const [snapshotRunning, setSnapshotRunning] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const liveModeRef = useRef(liveMode);
  liveModeRef.current = liveMode;
  // Bottom-tab navigation state for the mobile shell — lifted here so
  // `runFull` can jump to Preview/Backend after a clean cascade.
  // Persisted across reloads so users land back on their last panel.
  // The slot is typed `MobileTab | "files"` so a value persisted before
  // the Files tab was folded into Code still type-checks; coerce it to
  // "code" before handing it to the shell (usePersistedState has no
  // validator, so the stale value would otherwise select a dead panel).
  const [activeTabRaw, setActiveTab] = usePersistedState<MobileTab | "files" | "problems">(
    "loom.mobile.activeTab",
    "code",
  );
  // Coerce values persisted before the layout changed: "files" predates
  // folding Files into Code; "problems" predates folding the Problems
  // tab into the consolidated Output panel.
  const activeTab: MobileTab =
    activeTabRaw === "files"
      ? "code"
      : activeTabRaw === "problems"
        ? "output"
        : activeTabRaw;

  // Desktop bottom-dock tab — lifted from DesktopShell so a panel inside
  // the dock (History) can reveal a sibling (Migrations) with a pinned
  // baseline.  Coerce values persisted before Problems/Generator/Bundler
  // were folded into the consolidated Output panel.
  const [dockTabRaw, setDockTabRaw] = usePersistedState<
    DockTab | "problems" | "generator" | "bundler"
  >("loom.desktop.dockTab", "output");
  const dockTab: DockTab =
    dockTabRaw === "problems" || dockTabRaw === "generator" || dockTabRaw === "bundler"
      ? "output"
      : dockTabRaw;
  const setDockTab = (t: DockTab): void => setDockTabRaw(t);

  // Sub-view of the consolidated Code tab — source / builder / model /
  // generated. Persisted so a reload lands back on the same view.
  const [codeViewRaw, setCodeViewRaw] = usePersistedState<MobileCodeView>(
    "loom.mobile.codeView",
    "source",
  );
  // Mobile crash-guard: the Builder / Model / Model v2 / Requirements
  // sub-views are heavy on mount (craft.js + a main-thread Langium parse,
  // or React Flow). Restoring one of them verbatim on a mobile reload mounts
  // that cost immediately — before the user does anything — which on a
  // memory-constrained device is a prime crash trigger when a tab is
  // refreshed mid-work. So until the user explicitly picks a sub-view, a
  // persisted heavy view renders as the lightweight Source editor on mobile;
  // the raw (persisted) value is untouched, so a later tap restores it and a
  // desktop reload is unaffected. Mirrors the `userPickedExampleRef` pattern.
  const userPickedCodeViewRef = useRef(false);
  const setCodeView = (v: MobileCodeView): void => {
    userPickedCodeViewRef.current = true;
    setCodeViewRaw(v);
  };
  const isHeavyCodeView = (v: MobileCodeView): boolean =>
    v === "builder" || v === "model" || v === "requirements";
  // A session persisted before the v1/v2 model panes were consolidated can
  // still hold the retired `"model-v2"` — read it as the surviving Model view
  // rather than rendering nothing.
  const persistedCodeView: MobileCodeView =
    (codeViewRaw as string) === "model-v2" ? "model" : codeViewRaw;
  const codeView: MobileCodeView =
    !isDesktop && !userPickedCodeViewRef.current && isHeavyCodeView(persistedCodeView)
      ? "source"
      : persistedCodeView;

  // Test runner results, lifted here so the Output panel's Tests stream
  // can read them independently of the (sometimes-unmounted) Tests tab.
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  // Which stream the consolidated Output panel shows.  Persisted across
  // reloads; both shells read it off the ctx.
  const [outputStream, setOutputStream] = usePersistedState<OutputStream>(
    "loom.outputStream",
    "problems",
  );

  // Playground auth stub (Phase 7) — claims injected into dispatched
  // requests so an `auth: required` system is explorable as different
  // users.  Read via a ref by the memoised authed dispatcher below so
  // editing it doesn't re-mount the preview iframe.
  const [authStub, setAuthStub] = usePersistedState<AuthStubConfig>(
    "loom.authStub",
    DEFAULT_AUTH_STUB,
  );
  const authStubRef = useRef(authStub);
  authStubRef.current = authStub;

  // Live console streams for the Output panel — the backend (Hono
  // runtime worker) console + stack traces, and the preview app's
  // console + uncaught errors.  Capped so a chatty handler / app can't
  // grow these without bound; cleared when the source changes.
  const [backendLog, setBackendLog] = useState<LogLine[]>([]);
  const [appLog, setAppLog] = useState<LogLine[]>([]);
  const appendAppLog = useCallback((line: LogLine): void => {
    setAppLog((prev) => capLog([...prev, line]));
  }, []);
  const clearBackendLog = useCallback(() => setBackendLog([]), []);
  const clearAppLog = useCallback(() => setAppLog([]), []);
  // Live mirror of appLog so the async UI-test runner can read the
  // current buffer (React state is stale inside that closure) and slice
  // the per-test app output for each TestResult.
  const appLogRef = useRef<LogLine[]>([]);
  useEffect(() => {
    appLogRef.current = appLog;
  }, [appLog]);
  const getAppLog = useCallback((): LogLine[] => appLogRef.current, []);

  const sourceRef = useRef<string>(initialSource);
  // Bumped on every editor-origin onSourceChange (the user typing).  The
  // page-builder subscribes to this for its debounced text→canvas live
  // re-seed; bumping on builder edits would echo-loop, so we don't.
  const [editorSourceTick, setEditorSourceTick] = useState(0);
  // `null` until an editor mounts.  A non-editor write in that window (a
  // Builder "Apply", an agent edit, a history restore) does NOT lose its text:
  // every such path writes the workspace store first and only then calls
  // `editorHandleRef.current?.setSource(...)` to sync the live model, and both
  // editors seed from `initialSource` — which follows the store — when they do
  // mount.  The window widened on desktop when the language client moved to
  // `await import(...)`, which is why this is worth stating rather than
  // assuming.  (`LoomEditor` additionally queues for its own "client ready but
  // Monaco not created yet" window, where the editor IS mounted and a frozen
  // seed would otherwise revert the write.)
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const buildClientRef = useRef<LoomBuildClient | null>(null);
  const engineRef = useRef<RuntimeEngine | null>(null);
  // Stable dispatcher handed to the preview: forwards to the live engine,
  // injecting the auth-stub claims header when enabled.  Memoised with no
  // deps (reads engine + stub via refs) so the preview iframe is not
  // re-mounted when the stub config changes.
  const authedRuntime = useMemo<RuntimeDispatcher>(
    () => ({
      dispatch: (req) => {
        const engine = engineRef.current;
        if (!engine) return Promise.reject(new Error("runtime not ready"));
        const claims = devClaimsHeader(authStubRef.current);
        const headers = claims
          ? { ...req.headers, "x-loom-dev-claims": claims }
          : req.headers;
        return engine.dispatch({ ...req, headers });
      },
    }),
    [],
  );
  // The language client is a DESKTOP-only facility.  Mobile edits in a
  // textarea and takes its diagnostics from `generate` (the build worker
  // already computes them), so it never constructs one — which is what keeps
  // Monaco, `monaco-languageclient` and the `ddd-server` worker off the phone
  // entirely.  `null` here is a supported state, not a transient one:
  // `EditorPane` renders `PlainEditor` when there is no client.
  const lspClientRef = useRef<LoomLspClient | null>(null);
  const [lspClient, setLspClient] = useState<LoomLspClient | null>(null);
  useEffect(() => {
    if (!isDesktop || lspClientRef.current) return;
    let disposed = false;
    void import("./lsp/client").then(({ LoomLspClient }) => {
      if (disposed) return;
      const client = new LoomLspClient();
      lspClientRef.current = client;
      setLspClient(client);
    });
    return () => {
      disposed = true;
    };
  }, [isDesktop]);

  // Resident `VfsEntry[]` projection of `/workspace`, kept fresh from
  // the async git store.  The build-worker seed callback is sync (it
  // fires on worker spawn/respawn over `postMessage`), so it reads this
  // precomputed snapshot rather than awaiting git — the RPC boundary
  // collapses the async store into a sync payload.  This is a derived
  // projection, not a second source of truth.
  const seedEntriesRef = useRef<VfsEntry[]>([]);
  useEffect(() => {
    const store = workspace.store;
    if (!store) {
      seedEntriesRef.current = [];
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void store.snapshotEntries("/workspace").then((entries) => {
        if (!cancelled) seedEntriesRef.current = entries;
      });
    };
    refresh();
    const unsubscribe = store.subscribe("/workspace", refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspace.store]);

  // Debounced commit-on-save: turn working-tree writes (source edits, pack
  // imports, generated-tree merges) into git history once the editing
  // settles, so the "versioned workspace" is real.  Serialised inside the
  // store so it can't race an intentional regenerate commit.
  useEffect(() => {
    const store = workspace.store;
    // A read-only tab (another tab owns the writer lock) must not autosave:
    // its LightningFS view can be a whole git sequence behind the owner's, so
    // a commit from here would stage a stale tree over live work.
    if (!store || !workspace.writable) return;
    return startAutoCommit(store);
  }, [workspace.store, workspace.writable]);

  // Push every workspace `.ddd` source into the LSP worker as a Monaco
  // model. Without this, only the currently-edited file reaches the LSP via
  // Monaco's documentSelector, and any `import "./shared/x.ddd"` in main.ddd
  // fails to resolve because the LSP never sees x.ddd. The sync runs once
  // after the controller + LSP client are both available; the controller's
  // own VFS subscription drives subsequent updates.
  const activePathRef = useRef(sources.activePath);
  activePathRef.current = sources.activePath;
  useEffect(() => {
    // No language client (mobile) → no Monaco models to sync into.  The host
    // is imported dynamically because it is the module that touches
    // `monaco-editor` directly.
    if (!lspClient) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void import("./lsp/model-host").then(({ monacoModelHost }) => {
      if (cancelled) return;
      dispose = syncWorkspaceToLsp(sources.controller, {
        getActivePath: () => activePathRef.current,
        host: monacoModelHost,
      });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [sources.controller, lspClient]);

  // Crash reports carry the workspace as a FINGERPRINT (path + byte length +
  // truncated hash), never as content — see `util/crash-report.ts`.  The
  // report builders render above `App` (the root boundary replaces it), so
  // they reach the workspace through this registration rather than a prop.
  useEffect(() => {
    const ctrl = sources.controller;
    setCrashWorkspaceProvider(() =>
      [...ctrl.snapshot().files].map(([path, content]) => ({ path, content })),
    );
    return () => setCrashWorkspaceProvider(null);
  }, [sources.controller]);

  // "View diagnostics" on the crashed-last-session notice — that banner
  // renders outside `App`, so it asks for the stream switch by event.
  useEffect(() => {
    const onShow = (): void => setOutputStream("diag");
    window.addEventListener(SHOW_DIAGNOSTICS_EVENT, onShow);
    return () => window.removeEventListener(SHOW_DIAGNOSTICS_EVENT, onShow);
  }, [setOutputStream]);

  useEffect(() => {
    const build = new LoomBuildClient({
      // Sync seed: replay the resident `/workspace` projection into the
      // freshly-spawned worker.  Tagged entries preserve empty dir
      // entries (created via `mkdir`) across a respawn.
      seedWorkspace: () => seedEntriesRef.current,
    });
    // The runtime engine encapsulates the bundle + runtime workers
    // behind the RuntimeEngine seam.  `onLost` maps 1:1 to the old
    // `LoomRuntimeClient.onRespawn`: when App's visibilitychange
    // handler respawns the runtime after a background-kill, the
    // booted PGlite is gone — drop the pipeline back to "needs Boot"
    // with an explanatory message instead of leaving a green
    // "booted" badge while every dispatch hangs.  `dispatch` from
    // `useReducer` is stable, so closing over it here is safe.
    const engine = engineRegistry.create(selectedEngineId(), {
      onLost: () => dispatch({ type: "RUNTIME_LOST" }),
      // Backend (Hono runtime) console + stack traces, captured per RPC
      // in the worker — feeds the Output panel's "Backend" stream.
      onLog: (lines) => setBackendLog((prev) => capLog([...prev, ...lines])),
    });
    buildClientRef.current = build;
    engineRef.current = engine;
    setBuildClientReady(true);
    return () => {
      buildClientRef.current = null;
      engineRef.current = null;
      setBuildClientReady(false);
      build.dispose();
      engine.dispose();
      lspClientRef.current?.dispose();
      lspClientRef.current = null;
      setLspClient(null);
    };
  }, []);

  // Worker-rehydrate on tab background-kill.  Mobile Safari (and
  // some desktop browsers under memory pressure) terminate
  // backgrounded workers — without intervention, the next
  // `generateFromPath` lands on a worker whose VFS is empty AND
  // the next `dispatch()` against a killed runtime worker hangs
  // forever instead of failing fast.  Respawn both proactively.
  //
  // The build worker's respawn is correctness-preserving (the
  // `seedWorkspace` callback replays VFS state into the fresh
  // worker).  The runtime worker's respawn is NOT — PGlite +
  // imported bundle modules can't be re-created without re-booting
  // — so `LoomRuntimeClient.onRespawn` dispatches RUNTIME_LOST and
  // the Backend panel shows "click Boot again".
  useEffect(() => {
    let hiddenAt: number | null = null;
    const HIDDEN_RESPAWN_MS = 30_000;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (document.visibilityState === "visible" && hiddenAt != null) {
        const elapsed = Date.now() - hiddenAt;
        hiddenAt = null;
        if (elapsed > HIDDEN_RESPAWN_MS) {
          buildClientRef.current?.respawn();
          // Only act on the runtime if it was actually booted —
          // an unbooted client has nothing to recover and would
          // just emit a spurious "click Boot again" the user never
          // engaged with.  `pipeline.boot.kind === "ok"` is the same
          // guard the Backend panel uses for its action buttons.
          if (pipeline.boot.kind === "ok") {
            // Try to transparently recover: re-boot the retained
            // bundle into a fresh worker — OPFS-backed PGlite data
            // reattaches via the same dataDir, so the user keeps
            // their booted state instead of being told to re-Boot.
            // Only fall back to respawn() → onLost → RUNTIME_LOST
            // when recovery isn't possible (nothing booted to
            // snapshot) or fails (e.g. in-memory/non-persistent DB).
            void (async () => {
              const engine = engineRef.current;
              if (!engine) return;
              const snap = await engine.snapshot();
              if (snap && (await engine.restore(snap))) return;
              engine.respawn();
            })();
          }
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // Re-bind the listener whenever boot state transitions in or
    // out of "ok" so the guard above always reads fresh state.
  }, [pipeline.boot.kind]);

  // Replay any persisted custom packs into the build worker once
  // both the IDB-backed workspace VFS and the build client are ready.
  useEffect(() => {
    if (!workspace.loaded || !buildClientReady) return;
    const store = workspace.store;
    const client = buildClientRef.current;
    if (!store || !client) return;
    let cancelled = false;
    void (async () => {
      const designPaths = await store.list("/workspace/design/");
      if (designPaths.length === 0 || cancelled) return;
      // Use tagged VfsEntry shape — `list` is files-only so every
      // path here is a file, but the wire protocol expects the
      // discriminated union.
      const entries: VfsEntry[] = [];
      for (const path of designPaths) {
        const content = await store.readFile(path);
        if (content != null) entries.push({ kind: "file", path, content });
      }
      if (!cancelled && entries.length > 0) await client.vfsWrite(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.loaded, workspace.store, buildClientReady]);

  // Sync `sourceRef` whenever the active file's initial content
  // changes — happens both on example switch AND on multi-file tab
  // switch (Phase 2b2).  Handlers reading `sourceRef.current` see
  // the active file's content.  Keep this effect cheap; the heavy
  // "new project" reset below is gated on exampleId only.
  useEffect(() => {
    // Keep handlers that read `sourceRef.current` in sync with the active
    // file's content.  Regeneration is kicked explicitly by the edit /
    // import / workspace-switch paths (not here), so a tab switch or an
    // async content load no longer schedules a redundant rebuild.
    sourceRef.current = initialSource;
  }, [initialSource]);

  // Reset every downstream slot for a "new project" transition (example
  // import or workspace switch) and bump the generation epoch so any
  // generate still in flight for the previous project can't land its
  // result into this one's file view.
  function resetProject(): void {
    generationEpochRef.current++;
    dispatch({ type: "RESET" });
    lastBundleReadyRef.current = null;
    setLspDiagnostics([]);
    setSelectedPath(null);
    setPreviewBundle(null);
    setPreviewBooted(false);
    setBackendLog([]);
    setAppLog([]);
    void engineRef.current?.reset();
  }

  /** Publish the file set a Bundle click would use.
   *
   *  This ref has to AGREE with `pipeline.generate`, because the Bundle
   *  button is enabled off that state while `runBundle` reads this — and for
   *  a long time the two were written at different moments by different
   *  rules, which produced both halves of a nasty race:
   *
   *   - `GENERATE_DONE` (which paints "generated N file(s)" and enables the
   *     button) is dispatched BEFORE `runGenerateStep`'s second,
   *     sourcemap-carrying generate; the ref was assigned only after that
   *     returned.  On a 145-file system that is a ~0.7s window on an idle
   *     machine and multiple seconds on a loaded CI runner, during which a
   *     click did NOTHING AT ALL — no state change, no diagnostic, no
   *     network.  That is what hung every `heavy-preview` Playwright spec for
   *     its full 600s ceiling.
   *   - conversely, a generate for a project the user had already left could
   *     land its write AFTER `resetProject()` cleared the ref, leaving the
   *     PREVIOUS project's tree as the thing the next Bundle click would
   *     build.
   *
   *  So: write it exactly where and when the dispatch is written — under the
   *  same epoch guard — and treat `null` as "superseded, not mine to write"
   *  rather than as "there is nothing to bundle".  See
   *  `e2e/bundle-starts.spec.ts`. */
  function publishBundleInput(epoch: number, gen: GenerateResult | null): void {
    if (epoch !== generationEpochRef.current) return;
    if (gen === null) return;
    lastBundleReadyRef.current = gen;
  }

  // Write a project's main + companion `.ddd` files into the workspace
  // and land the editor on main.ddd.  Awaiting the controller writes is
  // deliberate: the resident sources snapshot must reflect the new
  // content BEFORE the editor remounts, otherwise it would seed from the
  // previous project's still-current snapshot (the stale-editor bug).
  async function seedProject(
    ctrl: WorkspaceSourcesController,
    source: string,
    files?: Record<string, string>,
  ): Promise<void> {
    await ctrl.write("/workspace/main.ddd", source);
    if (files) {
      for (const [rel, content] of Object.entries(files)) {
        const clean = rel.replace(/^\/+/, "");
        if (clean.endsWith(".ddd")) await ctrl.write(`/workspace/${clean}`, content);
      }
    }
    ctrl.setActivePath("/workspace/main.ddd");
  }

  // Import an example into the active workspace (the new meaning of
  // picking from the example dropdown): overwrite its sources, drop any
  // companion files the example doesn't include, reset downstream state,
  // and regenerate promptly.
  async function importExample(id: string): Promise<void> {
    const ex = examples.find((e) => e.id === id) ?? defaultExample;
    const ctrl = sourcesRef.current.controller;
    // Importing overwrites the workspace with the example's file set, so any
    // other source file is deleted.  Confirm ONLY when that would actually
    // lose something — a switch between two single-file examples drops
    // nothing and must not prompt.  Same idiom as the other destructive file
    // actions (SourceFilesTree deletes, workspace delete): `window.confirm`.
    const dropped = filesDroppedByExample(sourcesRef.current.files.keys(), ex.files);
    if (dropped.length > 0 && typeof window !== "undefined") {
      const list = dropped.map((p) => `  ${p.replace("/workspace/", "")}`).join("\n");
      const ok = window.confirm(
        `Loading "${ex.label}" replaces this workspace's files.\n\n` +
          `${dropped.length} file${dropped.length === 1 ? "" : "s"} will be deleted:\n${list}\n\n` +
          `Continue?`,
      );
      if (!ok) return;
    }
    userPickedExampleRef.current = true;
    for (const path of dropped) await ctrl.delete(path);
    await seedProject(ctrl, ex.source, ex.files);
    sourceRef.current = ex.source;
    writeHashSource(ex.source);
    resetProject();
    setExampleIdRaw(id);
    scheduleAutoGenerate(50);
  }

  // Create a NEW workspace seeded from an example (the non-destructive
  // "pick a starting point" flow).  The example is stashed in a ref the
  // workspace-open effect consumes once the new store has opened — that
  // sidesteps the async gap between switching the registry and the new
  // sources controller becoming live.
  function createWorkspaceFromExample(name: string, exampleId: string): void {
    pendingSeedExampleRef.current = exampleId;
    workspace.createWorkspace(name);
  }

  // Open / switch / create transition for the active workspace.  Each
  // distinct store is handled exactly once: the initial open seeds a
  // brand-new (or shared-link) workspace and kicks the first generate; a
  // later switch resets downstream state, reseats the build worker on the
  // new workspace, and regenerates.  An existing workspace keeps its
  // persisted content untouched.
  const handledStoreRef = useRef<unknown>("init");
  // Tracks an in-flight seed of a brand-new workspace.  Multi-file
  // examples (Acme ERP — 12 companion files) write each `.ddd` to
  // IndexedDB sequentially, which can outrun the auto-generate
  // debounce; a manual Generate click during the seed window would
  // run against the partial VFS and fail on the first unresolved
  // `import "./shared/money.ddd"`.  `runGenerateStep` awaits this
  // before reading `sourcesRef.current.files`.
  const pendingSeedRef = useRef<Promise<void> | null>(null);
  // Example a freshly-created workspace should be seeded from (set by
  // `createWorkspaceFromExample` just before the new store opens).  Null
  // → seed the default example so a new workspace is never blank.
  const pendingSeedExampleRef = useRef<string | null>(null);
  useEffect(() => {
    if (!workspace.loaded) return; // wait for the open-or-fail decision
    if (handledStoreRef.current === workspace.store) return; // already handled
    const initial = handledStoreRef.current === "init";
    handledStoreRef.current = workspace.store;
    const ctrl = sourcesRef.current.controller;

    if (initial && sharedImport) {
      // Shared-link payload — import it, then flip the picker to the
      // non-example "shared" sentinel so the editor remounts and reseeds
      // from the freshly-written content (the editor mounted on the
      // default example before this async seed lands).
      const seed = (async (): Promise<void> => {
        await seedProject(ctrl, sharedImport.source, sharedImport.files);
        sourceRef.current = sharedImport.source;
        writeHashSource(sharedImport.source);
        setExampleIdRaw("shared");
      })();
      pendingSeedRef.current = seed.finally(() => {
        if (pendingSeedRef.current === seed) pendingSeedRef.current = null;
      });
    } else if (workspace.persistedSource === null) {
      // Brand-new (or hostile-storage) workspace — seed from the example
      // chosen at creation, else the default so it's never blank.
      const pendId = pendingSeedExampleRef.current;
      pendingSeedExampleRef.current = null;
      const ex = (pendId && examples.find((e) => e.id === pendId)) || defaultExample;
      sourceRef.current = ex.source;
      setExampleIdRaw(ex.id);
      const seed = seedProject(ctrl, ex.source, ex.files);
      pendingSeedRef.current = seed.finally(() => {
        if (pendingSeedRef.current === seed) pendingSeedRef.current = null;
      });
    } else {
      sourceRef.current = workspace.persistedSource;
    }

    if (!initial) {
      // A genuine switch — reseat the build worker on the new workspace's
      // VFS so the previous workspace's files can't leak into generation.
      buildClientRef.current?.respawn();
    }
    resetProject();
    // Give the new store's sources controller (and the respawned worker)
    // a moment to settle, then regenerate.  A switch needs a touch longer
    // than the initial open / same-store seed.  `runGenerateStep` awaits
    // `pendingSeedRef` for the multi-file-example case where the seed's
    // sequential IndexedDB writes can outrun this debounce.
    scheduleAutoGenerate(initial ? 80 : 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.store, workspace.loaded]);

  const hashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHashSync = (text: string): void => {
    if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
    hashTimerRef.current = setTimeout(() => writeHashSource(text), 300);
  };

  // Map-carrying (sourcemap-on) counterpart of `generateSuccess` — the
  // reducer's `generate` slot holds the flag-OFF result (Files pane must
  // never show `.ts.map`/`.loom/sourcemap.json`; see `runGenerateStep`),
  // so the standalone "Bundle" button (used whenever Live mode is off —
  // the desktop default) can't read maps off pipeline state.
  // `runGenerate`/`runFull` set this to whatever they'd have bundled
  // themselves (the mapped generate directly, or the sourcemap-overlaid
  // merged tree when persisted) so a later manual `runBundle()` bundles
  // the same map-carrying set the auto-cascade would have. See
  // `persistGeneratedTree` / `strip-sourcemap.ts`.
  const lastBundleReadyRef = useRef<GenerateResult | null>(null);
  const autoGenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorCountRef = useRef(0);
  const generatingRef = useRef(false);
  generatingRef.current = pipeline.generating;
  const runGenerateRef = useRef<() => Promise<void> | void>(() => {});
  // Flipped on the first user-origin source change.  On mobile we use it to
  // skip the *unprompted* auto-generate that the initial-mount / example-pick
  // effects schedule: firing the esbuild build worker 5s after a reload —
  // during the fragile post-reload startup window (Monaco + LSP + build
  // workers + WASM all coming up at once) — is a needless load spike on a
  // memory-constrained device, and mobile already drives the pipeline through
  // the explicit "Run" button.  Once the user actually edits, auto-generate
  // resumes on mobile too.  Desktop is unaffected.
  const hasUserEditedRef = useRef(false);
  // Monotonic generation epoch.  Bumped whenever the project identity
  // changes (example import / workspace switch / reset).  Each
  // `runGenerateStep` captures the epoch at kick time; a result that
  // resolves after the epoch moved belongs to a project the user has
  // since navigated away from and is discarded — without this, an
  // in-flight generate from the previous example lands its files into
  // the current file view ("generate ran on the previous files").
  const generationEpochRef = useRef(0);
  const scheduleAutoGenerate = (delayMs = 5000): void => {
    if (!isDesktop && !hasUserEditedRef.current) return;
    if (autoGenTimerRef.current) clearTimeout(autoGenTimerRef.current);
    autoGenTimerRef.current = setTimeout(() => {
      if (errorCountRef.current === 0 && !generatingRef.current) {
        void runGenerateRef.current();
      }
      // Default 5s (was 800ms): the preview now refreshes in place, so
      // the debounce is the throttle on how often a background refresh
      // fires — long enough to coalesce a burst of keystrokes into one
      // rebuild after the user pauses.  A project switch passes a short
      // delay so the file view repopulates promptly instead of sitting
      // blank until the keystroke debounce elapses.
    }, delayMs);
  };
  useEffect(() => {
    return () => {
      if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
      if (autoGenTimerRef.current) clearTimeout(autoGenTimerRef.current);
    };
  }, []);

  async function copyShareLink(): Promise<void> {
    try {
      // Build the smallest legal URL for the current workspace:
      // single-file (`s=`, byte-compatible with pre-Stage-3 shared
      // links) when only main.ddd is present, multi-file (`p=`) when
      // the user has added other `.ddd` files via the tabs strip.
      const s = sourcesRef.current;
      const onlyMain =
        s.files.size === 0 ||
        (s.files.size === 1 && s.files.has("/workspace/main.ddd"));
      const url = onlyMain
        ? buildShareUrl(sourceRef.current)
        : buildShareUrl({
            files: Object.fromEntries(s.files),
            active: s.activePath,
          });
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied — the address bar still has it.
    }
  }

  const generateResult = pipeline.generate.kind === "result" ? pipeline.generate.result : null;

  // Where Problems gets its content.  Desktop: the live language client, via
  // Monaco markers.  Mobile: `generate` — same compiler, same validators, same
  // `file:line`, just reported when you Run instead of as you type.  Mobile
  // has no LSP at all (M-T8.15), so without this the panel would be silently
  // empty rather than late.
  const diagnostics = isDesktop
    ? lspDiagnostics
    : buildDiagnosticsToLsp(generateResult?.diagnostics ?? []);
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  errorCountRef.current = errorCount;

  const generateSuccess = selGenerateOk(pipeline);
  const honoBundleResult = pipeline.bundle.kind === "result" ? pipeline.bundle.hono : null;
  const reactBundleResult = pipeline.bundle.kind === "result" ? pipeline.bundle.react : null;
  const honoBundle = selHonoBundleOk(pipeline);
  const reactBundle = selReactBundleOk(pipeline);
  const ddl = selBootedDDL(pipeline);
  const persistent = selBootPersistent(pipeline);
  const migrated = selBootMigrated(pipeline);
  const bootErrorMessage = selBootError(pipeline);
  const dispatchSlot = pipeline.dispatch.kind === "result" ? pipeline.dispatch.result : null;

  // Memoised: this is a fresh object per render otherwise, which would make
  // the `ctx` memo below miss on every single render.
  const reactBundleStatus = useMemo<ReactBundleStatus>(() => {
    if (pipeline.bundle.kind !== "result") return { kind: "pending" };
    const r = pipeline.bundle.react;
    if (r === null) {
      // The React half is skipped when the Hono half fails, so a null react
      // result after a failed Hono bundle is a FAILURE, not "no React
      // deployable" — reporting it as absent told the user their system had
      // no frontend when the real problem was a bundle error.
      const hono = pipeline.bundle.hono;
      if (hono && !hono.ok) return { kind: "fail", result: hono };
      return { kind: "absent" };
    }
    return r.ok ? { kind: "ok", result: r } : { kind: "fail", result: r };
  }, [pipeline.bundle]);

  // Last-good preview retention.  The preview now refreshes in place,
  // so it must stay mounted across the live-mode regenerate cascade —
  // but GENERATE_START clears the boot slot (so `ddl` blinks null mid-
  // rebuild) and a failed rebuild yields no react bundle.  Holding the
  // last successful bundle + a "booted at least once" flag lets the
  // iframe persist; the new bundle is hot-swapped only when generate +
  // bundle actually succeed.  A failed rebuild leaves the previous app
  // on screen and only flips `previewProblem` for a non-blocking badge.
  const [previewBundle, setPreviewBundle] = useState<BundleOk | null>(null);
  const [previewBooted, setPreviewBooted] = useState(false);
  useEffect(() => {
    if (reactBundle) setPreviewBundle(reactBundle);
  }, [reactBundle]);
  useEffect(() => {
    if (ddl) setPreviewBooted(true);
  }, [ddl]);
  const previewProblem =
    previewBundle != null &&
    (reactBundleStatus.kind === "fail" ||
      (generateResult != null && !generateResult.ok));

  // The pipeline steps are split into composable `*Step` workers that
  // accept their inputs as parameters and return the freshly computed
  // result — that way the cascade (live mode auto-chain, or the
  // mobile "Run" button's runFull) doesn't depend on React state
  // having re-rendered with the new pipeline slot.  Reading
  // `generateSuccess` / `honoBundle` from the render closure was
  // racey: the dispatch that produces them and the synchronous
  // follow-up call execute in the same microtask, so the follow-up
  // saw the *previous* render's stale value and bailed out.

  /** The generate currently in flight, INCLUDING its sourcemap pass.
   *
   *  `runGenerateStep` does two generates: the flag-off one that drives the
   *  UI (and dispatches `GENERATE_DONE`), then a map-carrying one that only
   *  the boot bundle consumes.  A manual Bundle click can land between them,
   *  and the two ways that used to go wrong are the same race seen from
   *  either side: read `lastBundleReadyRef` too early and it was `null` (the
   *  click did NOTHING — the 600s `waitForBundle` hangs), or read the
   *  provisional value published at `GENERATE_DONE` and the boot bundle
   *  carries no `.ddd` mapping (`devtools-sourcemap.spec.ts` fails with
   *  "a .ddd entry in map.sources … Received: -1").
   *
   *  Both close the same way: a click waits out the pass that is already
   *  running, so it always bundles the BEST available input instead of
   *  whichever one happened to be published when it arrived. */
  const generateInFlightRef = useRef<Promise<unknown> | null>(null);

  /** Register `p` as the generate CYCLE currently in flight.
   *
   *  The scope matters and I got it wrong once: tracking `runGenerateStep`
   *  alone is not enough.  `btn-generate` runs `runGenerate(true)`, and the
   *  map-carrying tree a boot bundle needs is only assembled AFTER that step
   *  resolves — `persistGeneratedTree` merges the workspace and
   *  `overlaySourcemapArtifacts` re-attaches the `.ts.map` sidecars, then
   *  `publishBundleInput` records the result.  Awaiting the step stops one
   *  stage early and hands `runBundle` the un-overlaid tree every time, which
   *  turned `devtools-sourcemap`'s "-1" from intermittent into certain. */
  function trackGenerate<T>(p: Promise<T>): Promise<T> {
    const tracked = p.finally(() => {
      if (generateInFlightRef.current === tracked) generateInFlightRef.current = null;
    });
    generateInFlightRef.current = tracked;
    return tracked;
  }

  /** What one generate CYCLE produced: the flag-off tree that drives the file
   *  view, plus that same cycle's map-carrying tree (or `null` when its
   *  sourcemap pass didn't land).
   *
   *  `mapped` is returned rather than stashed in a ref on purpose.  It used to
   *  live in `lastMappedGenerateRef` — one shared mutable slot for a value
   *  that is per-cycle — and the comment on its reader even called it "this
   *  cycle's separate sourcemap generate", which is only true while no two
   *  cycles overlap.  They do overlap: `selectExample` schedules an
   *  auto-generate and the user (or a spec) can click Generate on top of it.
   *  Then this interleaving loses the maps entirely:
   *
   *    B: sourcemap pass resolves  → ref = mapped_B ; step returns
   *    A: flag-off resolves (late) → ref = null        ← wipes B's
   *    B: persistGeneratedTree reads ref → null → merged tree, NO overlay
   *
   *  and the boot bundle's map then stops at the generated `.ts` instead of
   *  reaching `.ddd` — `devtools-sourcemap.spec.ts`'s "Received: -1".  An
   *  epoch guard cannot fix that: both cycles share an epoch when no reset
   *  happened between them.  Threading the value removes the shared slot, so
   *  no cycle can observe or clobber another's. */
  interface GenerateCycle {
    result: GenerateResult;
    mapped: GenerateOk | null;
  }

  async function runGenerateStep(): Promise<GenerateCycle | null> {
    const client = buildClientRef.current;
    if (!client) return null;
    // Wait out any in-flight workspace seed so the multi-file example's
    // companion .ddd writes have all landed in the controller's snapshot
    // before we read it.  Without this, an early click (or the auto-
    // generate firing mid-seed) reads a partial VFS and the project-
    // loader throws on the first unresolved `import "./shared/…"`.
    if (pendingSeedRef.current) await pendingSeedRef.current;
    // Capture the epoch this run belongs to; if it moves while we await
    // the worker, the result is for a project the user has left.
    const epoch = generationEpochRef.current;
    dispatch({ type: "GENERATE_START" });
    // Read the controller's OWN synchronous snapshot, not `sourcesRef.current`
    // (a React-state mirror updated via emit→re-render).  Even after
    // `pendingSeedRef` resolves — which guarantees every companion `.ddd`
    // has landed in the controller — the React mirror can still lag a tick,
    // so a multi-file example's first auto-generate would otherwise run
    // against a PARTIAL file set / stale active path: the project loader
    // then throws on the not-yet-mirrored `import "./governance/…"`, and a
    // retry against an inconsistent state surfaces as unresolved cross-file
    // references.  The controller snapshot is authoritative the instant the
    // seed completes (this is why manually picking main.ddd, by which point
    // the mirror has caught up, makes generation succeed).
    const s = sourcesRef.current.controller.snapshot();
    const entryPath = s.activePath;
    // Push every workspace `.ddd` source, not just the active file, so a
    // multi-file example's imports resolve against fresh content in the
    // worker's VFS.  The active file is written last with the editor's
    // live text (which may be ahead of the controller snapshot).
    const entries: VfsEntry[] = [];
    for (const [path, content] of s.files) {
      if (path === entryPath) continue;
      entries.push({ kind: "file", path, content });
    }
    entries.push({ kind: "file", path: entryPath, content: sourceRef.current });
    await client.vfsWrite(entries);
    // The flag-OFF generate — unchanged from before this feature existed,
    // so it's what drives the Files pane / persist, and byte-identical
    // output falls out of that by construction rather than needing a
    // strip step to reproduce it.  See `strip-sourcemap.ts`'s module doc
    // for why a single-generate-then-strip design was rejected.
    const result = await client.generateFromPath(entryPath);
    // Superseded by a newer project — drop the result so it neither
    // repaints the file view nor drives the live-mode bundle/boot cascade.
    if (epoch !== generationEpochRef.current) return null;
    dispatch({ type: "GENERATE_DONE", result });
    // A FLOOR, not the intended input: the flag-off tree, published in the
    // same turn as the dispatch that enables the Bundle button.  `runBundle`
    // awaits the whole cycle before reading the ref, so it normally sees the
    // mapped / merged set `runGenerate` publishes below and never this.  What
    // this covers is the cycle that never gets there — a build-worker respawn
    // rejects it — where the choice is bundling without `.ddd` maps or a
    // click that does nothing at all.  The former is recoverable and visible;
    // the latter is the 600s hang this whole change exists to remove.
    publishBundleInput(epoch, result);
    if (result.ok && result.files.length > 0) {
      // Preserve the user's selection only when that exact path still
      // exists in the freshly generated tree; otherwise fall back to the
      // first file.  This is what makes the file view actually refresh on
      // a project change instead of sticking on a now-absent path.
      setSelectedPath((prev) =>
        prev && result.files.some((f) => f.path === prev) ? prev : result.files[0].path,
      );
    } else {
      setSelectedPath(null);
    }
    // Second, map-carrying generate of the SAME source — feeds ONLY the
    // boot bundle (`runBundleStep` / `persistGeneratedTree`'s overlay),
    // never the view/persist.  Best-effort: on failure the bundle just
    // falls back to the (still fully functional, just not `.ddd`-
    // debuggable) flag-off files — see `GenerateCycle`.
    let mappedForCycle: GenerateOk | null = null;
    if (result.ok) {
      try {
        const mapped = await client.generateFromPath(entryPath, { sourcemap: true });
        if (epoch === generationEpochRef.current && mapped.ok) {
          // Inline the `.ts → .ddd` sidecar maps into the `.ts` files: the
          // in-browser bundler is esbuild-WASM, which can't read `.ts.map`
          // sidecars (no filesystem), so without this the boot bundle's map
          // stops at the generated `.ts` and never reaches `.ddd`. See
          // `inlineSourcemapArtifacts` + `web/e2e/devtools-sourcemap.spec.ts`.
          mappedForCycle = {
            ...mapped,
            files: inlineSourcemapArtifacts(mapped.files),
          };
        }
      } catch {
        /* best-effort — see comment above */
      }
    }
    return { result, mapped: mappedForCycle };
  }

  interface BundleStepResult {
    hono: BundleOk | { ok: false };
    react: BundleOk | { ok: false } | null;
  }

  async function runBundleStep(gen: GenerateOk): Promise<BundleStepResult | null> {
    markPhase("bundle");
    const engine = engineRef.current;
    if (!engine) return null;
    const entries = analyzeDeployables(gen.files);
    if (!entries.hono) {
      // The playground's runtime is Hono + React only.  Spell out
      // why bundling can't proceed: either nothing recognisable was
      // emitted, or the system only declares deployables the
      // browser can't run (.NET, Phoenix LiveView, or the non-React
      // frontends — SvelteKit, Vue, Angular).
      const message =
        entries.unsupported.length > 0
          ? `Nothing to bundle in the browser — this system only declares ${formatUnsupportedDeployables(entries.unsupported)}, which run outside the playground.  Generated files are visible in the Files pane.`
          : "No bundlable backend in generated output (looked for http/index.ts).";
      const failed = {
        ok: false as const,
        diagnostics: [{ severity: "error" as const, message }],
      };
      dispatch({ type: "BUNDLE_DONE", hono: failed, react: null });
      return { hono: failed, react: null };
    }
    dispatch({ type: "BUNDLE_START" });
    // `gen.files` carries the `.ts.map` sidecars (either straight from
    // `runGenerateStep`'s raw result, or re-attached by
    // `persistGeneratedTree`'s overlay) — `sourcemap: true` tells the
    // engine to inline them into the Hono boot bundle so DevTools can
    // chain a breakpoint back to `.ddd`.  Backend-only; the React run
    // never sets this (see `PrepareInput.sourcemap`).
    const { hono: honoRes, react: reactRes } = await engine.prepare({
      files: gen.files,
      dependencies: emptyDependencySet(),
      honoEntry: entries.hono,
      reactEntry: entries.react ?? undefined,
      sourcemap: true,
    });
    dispatch({ type: "BUNDLE_DONE", hono: honoRes, react: reactRes });
    return { hono: honoRes, react: reactRes };
  }

  // Best-effort: fetch the booted backend's OpenAPI document and turn it
  // into the endpoint list that drives the Backend console's picker.  On
  // any failure we clear the spec so the panel falls back to manual mode.
  async function loadOpenApiSpec(engine: RuntimeEngine): Promise<void> {
    try {
      const res = await engine.dispatch({
        url: "http://localhost/openapi.json",
        method: "GET",
        headers: {},
        body: null,
      });
      if (res.ok && res.response.status < 400 && res.response.body) {
        const doc = JSON.parse(res.response.body) as OpenApiDoc;
        setOpenApiSpec(doc);
        setApiEndpoints(parseOpenApi(doc));
        return;
      }
    } catch {
      // fall through to manual mode
    }
    setOpenApiSpec(null);
    setApiEndpoints([]);
  }

  async function runBootStep(
    hono: BundleOk,
    opts?: { fresh?: boolean },
  ): Promise<boolean> {
    const engine = engineRef.current;
    if (!engine) return false;
    markPhase("boot:start");
    dispatch({ type: "BOOT_START" });
    // Reset spec-driven state — a fresh boot may serve a different
    // contract, and a failed (re)boot shouldn't leave stale endpoints.
    setSelectedOpId(null);
    setPathParamValues({});
    setQueryParamValues({});
    setApiEndpoints([]);
    setOpenApiSpec(null);
    try {
      const sourceHash = fnv1a32(sourceRef.current);
      // MOBILE: in-memory, not OPFS.
      //
      // Two field reports in a row died at `boot:ddl-meta` — PGlite's real
      // startup, which is deferred to its first SQL statement (constructor
      // 0.7 ms vs 5469 ms for that exec).  The SQL itself is 9 statements /
      // 1 KB, so the cost is Postgres coming up, and freeing the bundler's
      // ~8.8k-file VFS first (#2420) did not bring it under iOS's budget.
      //
      // `opfs-ahp://` adds an Access Handle Pool on top of that: a set of
      // sync file handles opened up front, each holding resources, which is
      // comparatively expensive on WebKit.  `:memory:` seeds the same
      // pre-baked cluster from `pglite.data` into memfs and skips the pool
      // entirely — strictly less startup work, which is the only budget
      // under pressure here.
      //
      // The cost is real: no persistence across reloads on mobile, so rows
      // don't survive a refresh.  A database that starts and forgets beats
      // one that never starts, and the badge already reports `persistent`
      // honestly rather than claiming persistence it doesn't have.
      //
      // DEAD END, recorded so it isn't retried: PGlite exposes an
      // `initialMemory` option and defaults to 128 MB, which looks like the
      // obvious knob.  It only goes UP.  `pglite.wasm` DECLARES an initial
      // memory of 2048 pages, so anything smaller fails to link outright:
      //   LinkError: memory import has 512 pages which is smaller than the
      //   declared initial of 2048
      // A 128 MB contiguous WASM heap is therefore structural at this
      // version, not a setting — which is also why freeing memory elsewhere
      // (#2420) could not buy enough headroom.
      const dataDir = isDesktop ? `opfs-ahp://loom-${sourceHash}` : ":memory:";
      const res = await engine.boot(hono.code, dataDir, { fresh: opts?.fresh });
      if (res.ok) {
        dispatch({
          type: "BOOT_OK",
          ddl: res.ddl,
          persistent: res.persistent,
          migrated: res.migrated,
        });
        // House-keep OPFS: this boot's island is now most-recently-used;
        // drop stale islands from sources the user has moved on from so
        // they don't accumulate toward the storage quota.  Only when the
        // boot is actually OPFS-backed, and never blocking the boot.
        if (res.persistent) void recordAndGcOpfs(sourceHash);
        clearPhase();
        await loadOpenApiSpec(engine);
        return true;
      }
      dispatch({ type: "BOOT_FAIL", message: res.message });
      clearPhase();
      return false;
    } catch (err) {
      dispatch({
        type: "BOOT_FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
      clearPhase();
      return false;
    }
  }

  // Single-step entry points — Desktop's individual Generate / Bundle
  // / Boot buttons still call these.  Live-mode cascade is now driven
  // from inside `runGenerate` by passing the fresh result to the next
  // step explicitly (no ref ping-pong).
  // Version generated output into the git-backed workspace as a per-file
  // 3-way merge ("scaffold then own").  Only the *intentional* generate
  // paths (the Generate / Run buttons) persist — the 5s auto-generate
  // keeps the in-memory preview behaviour so typing doesn't spawn commits
  // or churn the workspace tree.  Best-effort: a failure here never
  // breaks the generate itself.
  // Version the generated tree and return the merged result as the file
  // set to bundle — so the preview reflects hand edits to generated code
  // ("scaffold then own").  Returns null (→ caller bundles the in-memory
  // output) when there's no store, nothing generated, or the merged read
  // came back empty.  Best-effort: a failure never breaks generate.
  async function persistGeneratedTree(
    result: GenerateResult | null,
    mapped: GenerateOk | null,
  ): Promise<VirtualFile[] | null> {
    const store = workspace.store;
    if (!store || !result?.ok || result.files.length === 0) return null;
    // Read-only tab: regenerate still runs, its output just stays in memory
    // (the preview is a pure client-side derive).  Nothing reaches the shared
    // IndexedDB tree — that is the other tab's to own.
    if (!store.writable) return null;
    try {
      // `result` is always the flag-OFF generate (see `runGenerateStep`) —
      // the git-backed workspace only ever sees exactly what it would
      // without this feature.  No strip needed; there's nothing to strip.
      await applyGeneratedTree(store, result.files);
      const merged = await readGeneratedTree(store);
      if (merged.length === 0) return null;
      const mergedFiles: VirtualFile[] = merged.map((f) => ({
        path: f.path,
        content: f.content,
        size: f.content.length,
      }));
      // Overlay the map-carrying delta (this cycle's separate sourcemap
      // generate, if it landed) onto the merged tree so the boot bundle
      // built off it can still chain to `.ddd` — in-memory only, never
      // persisted.  See `overlaySourcemapArtifacts` for the hand-edit
      // limitation; falls back to the plain merged tree (no maps, still
      // functionally correct) when the mapped generate isn't available.
      return mapped ? overlaySourcemapArtifacts(mergedFiles, result.files, mapped.files) : mergedFiles;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("failed to version generated output:", err);
      return null;
    }
  }

  function runGenerate(persist = false): Promise<void> {
    return trackGenerate(runGenerateInner(persist));
  }

  async function runGenerateInner(persist = false): Promise<void> {
    const epoch = generationEpochRef.current;
    const cycle = await runGenerateStep();
    const result = cycle?.result ?? null;
    let bundleGen: GenerateResult | null = result;
    if (persist && result?.ok) {
      const merged = await persistGeneratedTree(result, cycle?.mapped ?? null);
      if (merged) bundleGen = { ...result, files: merged };
    } else if (result?.ok && cycle?.mapped) {
      // Live-auto (no persist): bundle the map-carrying generate of this
      // same source directly, so the boot bundle can still chain to
      // `.ddd`.  Falls back to the flag-off `result` above when the
      // mapped generate hasn't landed (best-effort, see `runGenerateStep`).
      bundleGen = cycle.mapped;
    }
    // Upgrade the provisional set published at GENERATE_DONE to the
    // map-carrying / merged one, so a later manual "Bundle" click (Live mode
    // off — the desktop default) still gets sourcemaps even though this
    // generate didn't cascade.
    publishBundleInput(epoch, bundleGen);
    if (
      liveModeRef.current &&
      bundleGen?.ok &&
      bundleGen.files.length > 0
    ) {
      const bundleRes = await runBundleStep(bundleGen);
      if (bundleRes?.hono.ok) {
        await runBootStep(bundleRes.hono);
      }
    }
  }
  runGenerateRef.current = () => runGenerate();

  async function runBundle(): Promise<void> {
    // Wait out the generate CYCLE that is still running, so the boot bundle
    // is built from the map-carrying tree that cycle is about to publish
    // rather than from whatever happened to be in the ref when the click
    // arrived.  `GENERATE_DONE` — which paints "generated N file(s)" and
    // enables this button — lands well before the cycle finishes: it is
    // followed by a second, sourcemap-carrying generate and (on the persist
    // path) `persistGeneratedTree`'s merge + overlay.  Measured at ~0.7s on
    // an idle machine and seconds on a loaded CI runner; a click inside that
    // window used to read `null` and do NOTHING AT ALL, which is what hung
    // every `heavy-preview` spec for its full 600s ceiling.
    //
    // Deliberately NO fallback to `generateSuccess` if the ref is still
    // empty: that is the flag-off tree with no inline `.ddd` maps, so
    // bundling it yields a boot bundle whose map stops at the generated
    // `.ts` — `devtools-sourcemap.spec.ts`'s "-1".  Substituting a worse
    // input for a wait we have already done buys nothing.
    const inFlight = generateInFlightRef.current;
    if (inFlight) await inFlight.catch(() => undefined);
    const gen = lastBundleReadyRef.current;
    if (!gen?.ok || gen.files.length === 0) return;
    const result = await runBundleStep(gen);
    if (liveModeRef.current && result?.hono.ok) {
      await runBootStep(result.hono);
    }
  }

  async function runBoot(): Promise<void> {
    if (!honoBundle) return;
    await runBootStep(honoBundle);
  }

  // Recovery for a boot that keeps failing on stale persisted data:
  // re-boot with `fresh`, which drops the OPFS island's schemas before
  // applying DDL.  The normal Reset can't help here — it needs a booted
  // instance, which the failing boot never produces.
  async function runResetData(): Promise<void> {
    if (!honoBundle) return;
    await runBootStep(honoBundle, { fresh: true });
  }

  // Full cascade — the mobile "Run" primary action.  Generates,
  // bundles, boots, and on success jumps the bottom-tab nav to
  // Preview (or Backend when there's no React deployable to render).
  // On any failure the user is left on their current tab; the
  // Problems tab carries a red-dot indicator for errors.
  function runFull(): Promise<void> {
    return trackGenerate(runFullInner());
  }

  async function runFullInner(): Promise<void> {
    // Phase markers bracket the whole cascade.  They are the ONLY record that
    // survives a renderer kill — no error fires, no `pagehide`, so the ring's
    // async capture never runs.  `runBundleStep`/`runBootStep` narrow the
    // marker as they go, and the runtime worker narrows it further still
    // (see runtime/client.ts).  Whatever is left in localStorage after the
    // page reloads names the step that killed it.
    markPhase("generate");
    const epoch = generationEpochRef.current;
    const cycle = await runGenerateStep();
    const gen = cycle?.result;
    if (!gen?.ok || gen.files.length === 0) return;
    // Intentional run → version the output and bundle the merged tree
    // (reflects hand edits to generated code).
    let bundleGen: GenerateOk = gen;
    const merged = await persistGeneratedTree(gen, cycle?.mapped ?? null);
    if (merged) bundleGen = { ...gen, files: merged };
    publishBundleInput(epoch, bundleGen);
    const bundleRes = await runBundleStep(bundleGen);
    if (!bundleRes?.hono.ok) return;
    // MOBILE: hand the memory back before booting.  The bundler worker has
    // done its job for this Run and is still holding an esbuild context plus
    // the whole installed npm VFS (~8.8k files); PGlite's real startup —
    // deferred to its first SQL statement, ~5.5s of WASM instantiation and
    // initdb — is the peak of the whole cascade, and it is where iOS has been
    // killing the tab (`died-in-phase: boot:ddl`).  Desktop keeps the warm
    // context: it has the headroom, and rebuild speed is worth more there.
    // Costs the next mobile bundle a cold start, largely served by the IDB
    // install cache.  A slower second Run beats a first Run that never ends.
    if (!isDesktop) engineRef.current?.releaseBundler?.();
    const booted = await runBootStep(bundleRes.hono);
    if (!booted) return;
    // React frontend present and successfully bundled → Preview is
    // the natural destination.  Otherwise the user gets the Backend
    // tab so they can poke endpoints against the live runtime.
    setActiveTab(bundleRes.react?.ok ? "preview" : "backend");
    clearPhase();
  }

  async function runWipe(): Promise<void> {
    const engine = engineRef.current;
    if (!engine || ddl === null) return;
    await engine.wipe();
    dispatch({ type: "DISPATCH_CLEAR" });
  }

  async function runDispatch(): Promise<void> {
    const engine = engineRef.current;
    if (!engine || ddl === null) return;
    dispatch({ type: "DISPATCH_START" });
    try {
      const url = reqPath.startsWith("http")
        ? reqPath
        : `http://localhost${reqPath.startsWith("/") ? "" : "/"}${reqPath}`;
      const headers: Record<string, string> = {};
      const body =
        reqMethod === "GET" || reqMethod === "DELETE" || reqMethod === "HEAD"
          ? null
          : reqBody;
      if (body !== null && body.length > 0) {
        headers["content-type"] = "application/json";
      }
      // Playground auth stub — inject the configured identity so a
      // `requires`-gated route can be exercised as different users.
      const claims = devClaimsHeader(authStub);
      if (claims) headers["x-loom-dev-claims"] = claims;
      const result = await engine.dispatch({ url, method: reqMethod, headers, body });
      dispatch({ type: "DISPATCH_DONE", result });
    } catch (err) {
      dispatch({
        type: "DISPATCH_DONE",
        result: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Spec-driven endpoint console handlers.  Selecting an endpoint pre-fills
  // the method, the concrete path, and (for write verbs) an example body
  // sampled from the schema.  Param edits keep `reqPath` in sync so
  // `runDispatch` stays unchanged — it always sends the concrete `reqPath`.
  const selectedEndpoint: ApiEndpoint | null =
    selectedOpId && selectedOpId !== CUSTOM_ENDPOINT
      ? apiEndpoints.find((e) => e.operationId === selectedOpId) ?? null
      : null;

  function runSelectEndpoint(opId: string): void {
    setSelectedOpId(opId);
    if (opId === CUSTOM_ENDPOINT) return;
    const ep = apiEndpoints.find((e) => e.operationId === opId);
    if (!ep) return;
    const freshPath: Record<string, string> = {};
    const freshQuery: Record<string, string> = {};
    setPathParamValues(freshPath);
    setQueryParamValues(freshQuery);
    setReqMethod(ep.method);
    setReqPath(buildConcretePath(ep, freshPath, freshQuery));
    setReqBody(ep.hasBody && openApiSpec ? generateExampleBody(ep.requestSchema, openApiSpec) : "");
  }

  function setPathParam(name: string, value: string): void {
    if (!selectedEndpoint) return;
    const next = { ...pathParamValues, [name]: value };
    setPathParamValues(next);
    setReqPath(buildConcretePath(selectedEndpoint, next, queryParamValues));
  }

  function setQueryParam(name: string, value: string): void {
    if (!selectedEndpoint) return;
    const next = { ...queryParamValues, [name]: value };
    setQueryParamValues(next);
    setReqPath(buildConcretePath(selectedEndpoint, pathParamValues, next));
  }

  function runGenerateExample(): void {
    if (!selectedEndpoint || !openApiSpec) return;
    setReqBody(generateExampleBody(selectedEndpoint.requestSchema, openApiSpec));
  }

  async function runQuery(sql: string): Promise<QueryResult> {
    const engine = engineRef.current;
    if (!engine || ddl === null) {
      return { ok: false, message: "Runtime not booted — boot first." };
    }
    return engine.query(sql);
  }

  // Rename a `.ddd` source: write the new path with the old content,
  // drop the old, and follow the active file across the rename.  Awaits
  // the controller so the tree + editor see a consistent snapshot.
  async function renameSourceFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const s = sourcesRef.current;
    const ctrl = s.controller;
    const content = s.files.get(oldPath) ?? "";
    const wasActive = s.activePath === oldPath;
    // Callers invoke this without awaiting, so a rejection here would be an
    // unhandled one.  The controller has already put it on its error channel
    // (the tree renders it); swallow and leave the workspace as-is.
    try {
      await ctrl.write(newPath, content);
      await ctrl.delete(oldPath);
    } catch {
      return;
    }
    if (wasActive) ctrl.setActivePath(newPath);
    scheduleAutoGenerate();
  }

  // Delete a folder and every `.ddd` file beneath it, then drop the
  // (now-empty) folder entry.  `folderRel` is workspace-relative.
  function deleteSourceFolder(folderRel: string): void {
    const clean = folderRel.replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean === "") return;
    const prefix = `/workspace/${clean}/`;
    const ctrl = sourcesRef.current.controller;
    void (async () => {
      try {
        for (const path of [...sourcesRef.current.files.keys()]) {
          if (path.startsWith(prefix)) await ctrl.delete(path);
        }
      } catch {
        // On the controller's error channel already; stop rather than
        // carry on rmdir-ing a folder whose files are still there.
        return;
      }
      try {
        await ctrl.deleteEmptyFolder(clean);
      } catch {
        // An implicit folder vanishes with its last file, so rmdir on it
        // legitimately fails here — clear the error the controller just
        // recorded rather than showing the user a failure that isn't one.
        ctrl.clearError();
      }
      scheduleAutoGenerate();
    })();
  }

  // `?? EMPTY_FILES` (module-level), not `?? []`: a fresh array literal per
  // render made the three memos below — and the `ctx` memo — miss every render
  // for the entire pre-generate lifetime of the app.
  const files: VirtualFile[] = generateSuccess?.files ?? EMPTY_FILES;
  const tree = useMemo(() => buildTree(files), [files]);
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  // Per-deployable platform analysis — used by FooterBar/PreviewPane
  // to tell the user which deployables can't run in the browser.
  const deployableAnalysis = useMemo(
    () => analyzeDeployables(files),
    [files],
  );

  // Derive the migration + wire-contract delta the live edit implies vs the
  // last-committed baseline.  The heavy lowering of BOTH source trees happens
  // in the build worker; here we assemble the two trees — the live workspace
  // sources (active file carrying the editor's un-persisted text) and the
  // baseline tree read from git at `ref` — and hand them over.  Multi-file /
  // import projects resolve because the whole `.ddd` tree is shipped, not a
  // single file (M-T8.11).
  async function runEvolutionDiff(ref = "HEAD"): Promise<void> {
    const client = buildClientRef.current;
    if (!client) return;
    setEvolutionRunning(true);
    try {
      // Current tree = every workspace `.ddd` source from the controller
      // snapshot, with the active file overridden by the editor's live text
      // (which may be ahead of the persisted mirror).  Mirrors the generate
      // flow's VFS seed (all files, active last) so the diff sees exactly
      // what a generate would.
      const s = sourcesRef.current.controller.snapshot();
      const entryPath = s.activePath;
      const currentFiles: VfsEntry[] = [];
      for (const [path, content] of s.files) {
        if (path === entryPath) continue;
        currentFiles.push({ kind: "file", path, content });
      }
      currentFiles.push({ kind: "file", path: entryPath, content: sourceRef.current });

      // Baseline = the whole `/workspace` `.ddd` tree at `ref` — `HEAD` (last
      // save) by default, or any commit pinned from the picker / History.
      // Absent store (ephemeral session) or no commit at that ref ⇒ `null`
      // baseline, which the worker reads as "no previous version" (Initial).
      const baselineFiles =
        (await workspace.store?.readTreeAtRef("/workspace", ref)) ?? [];
      const baseline =
        baselineFiles.length > 0 ? { entryPath, files: baselineFiles } : null;

      const result = await client.evolution({
        baseline,
        current: { entryPath, files: currentFiles },
      });
      setEvolution(result);
    } catch (err) {
      setEvolution({
        ok: false,
        diagnostics: [
          {
            severity: "error",
            message: `Evolution diff failed: ${err instanceof Error ? err.message : String(err)}`,
            source: "loom-evolve",
          },
        ],
      });
    } finally {
      setEvolutionRunning(false);
    }
  }

  // Pin `ref` as the evolution baseline, reveal the Migrations dock tab, and
  // run the diff — the one-click "diff against this milestone" wired from the
  // History tab (and the Migrations tab's own baseline picker).  Desktop-only
  // navigation (the Migrations tab lives in the desktop dock); on mobile the
  // baseline still pins and the diff still runs.
  function pinEvolutionBaseline(ref: string): void {
    setEvolutionBaselineRef(ref);
    setDockTab("migrations");
    void runEvolutionDiff(ref);
  }

  // Download the generated project tree as a single .zip — the bridge out of
  // the browser for the backends/frontends the preview can't boot (.NET,
  // Phoenix, Java, Python, Vue, Svelte).  The files are already in memory
  // (the flag-off generate, byte-identical to `ddd generate system`), so this
  // is a pure client-side archive + download — no worker round-trip.
  function runDownloadZip(): void {
    const genFiles = generateSuccess?.files ?? [];
    if (genFiles.length === 0) return;
    const entries = genFiles.map((f) => ({ path: f.path, content: f.content }));
    const base =
      workspace.activeName.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
      "loom-project";
    downloadBytes(makeZip(entries), `${base}.zip`);
  }

  // Capture immutable provenance rule snapshots — the playground's `ddd
  // snapshot`.  Deliberate (like `ef migrations add`): the user clicks, we
  // don't auto-run it.  The returned files are timestamped+GUID and shown
  // in the Migrations tab's Snapshots section.
  async function runCaptureSnapshot(): Promise<void> {
    const client = buildClientRef.current;
    if (!client) return;
    setSnapshotRunning(true);
    try {
      setSnapshotResult(await client.snapshot(sourceRef.current));
    } catch (err) {
      setSnapshotResult({
        ok: false,
        diagnostics: [
          {
            severity: "error",
            message: `Snapshot capture failed: ${err instanceof Error ? err.message : String(err)}`,
            source: "loom-snapshot",
          },
        ],
      });
    } finally {
      setSnapshotRunning(false);
    }
  }

  // Push an agent-authored `.ddd` into the editor + LSP + workspace — the same
  // path a Builder "Apply" takes (`onSourceChange(..., "builder")`): Monaco's
  // model is set (which re-runs the LSP) but its onChange is suppressed, so we
  // mirror the workspace-write side-effects here.
  function applyAgentSource(text: string): void {
    sourceRef.current = text;
    hasUserEditedRef.current = true;
    const s = sourcesRef.current;
    if (s.activePath === "/workspace/main.ddd") scheduleHashSync(text);
    s.write(s.activePath, text);
    editorHandleRef.current?.setSource(text);
  }

  // Play the deterministic prose → `.ddd` → generate → green demo (the Agent
  // dock tab).  The scripted driver runs the real browser-safe `loom_*` tools;
  // here we just wire it to the editor sink + the real generate.
  async function runAgentDemo(): Promise<void> {
    if (agentRunning) return;
    agentSignalRef.current = { cancelled: false };
    setAgentRunning(true);
    try {
      const { runAgentDemo: playAgentDemo } = await import("./agent/demo");
      await playAgentDemo({
        setMessages: setAgentMessages,
        applySource: applyAgentSource,
        triggerGenerate: () => void runGenerate(true),
        signal: agentSignalRef.current,
      });
    } finally {
      setAgentRunning(false);
    }
  }

  // Persist BYOK settings whenever they change.
  function setAgentSettings(s: AgentSettings): void {
    setAgentSettingsState(s);
    saveAgentSettings(s);
  }

  // Send one live-chat turn: build the transport from the BYOK settings, run
  // the real agent loop over the accumulated transcript, stream the folded
  // display, reflect the agent's source edits into the editor, and generate.
  async function sendAgentMessage(text: string): Promise<void> {
    // Automation seam (mirrors `__loomSetSource`): an e2e/manual harness can
    // inject a scripted transport, driving the live loop deterministically
    // without a real provider key.
    const injected = (window as unknown as { __loomAgentComplete?: Complete }).__loomAgentComplete;
    if (agentRunning || !text.trim()) return;
    if (!injected && !settingsReady(agentSettings)) return;
    agentSignalRef.current = { cancelled: false };
    setAgentRunning(true);
    const preset = presetById(agentSettings.providerId);
    const headers: Record<string, string> =
      preset.id === "openrouter"
        ? { "HTTP-Referer": "https://loom.build", "X-Title": "Loom playground" }
        : {};
    const complete =
      injected ??
      createOpenAiCompatibleComplete({
        baseUrl: agentSettings.baseUrl,
        apiKey: agentSettings.apiKey,
        model: agentSettings.model,
        headers,
        stream: true,
      });
    try {
      const [{ runLiveAgent }, { buildSystemPrompt }] = await Promise.all([
        import("./agent/live"),
        import("./agent/system-prompt"),
      ]);
      agentTranscriptRef.current = await runLiveAgent({
        complete,
        prompt: text,
        currentSource: sourceRef.current,
        history: agentTranscriptRef.current,
        system: buildSystemPrompt(),
        setMessages: setAgentMessages,
        applySource: applyAgentSource,
        triggerGenerate: () => void runGenerate(true),
        signal: agentSignalRef.current,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAgentMessages((prev) => [
        ...prev,
        { id: `err${prev.length}`, role: "assistant", text: `⚠️ ${message}` },
      ]);
    } finally {
      setAgentRunning(false);
    }
  }

  // Reset the live chat (clears the display + the raw transcript so the next
  // send starts a fresh conversation).
  function clearAgentChat(): void {
    agentSignalRef.current.cancelled = true;
    agentTranscriptRef.current = [];
    setAgentMessages([]);
  }

  // ---------------------------------------------------------------------
  // ctx — the state + actions bundle the shell and its panes consume.
  //
  // Identity matters here.  `ctx` used to be a fresh object literal on every
  // App render, and three heavy panes (the v1 / v2 system builders and the
  // requirements pane) keyed their derivations off that identity — so ANY app
  // state tick (a pipeline step, a diagnostic arriving, an agent token
  // streaming, a test result landing) re-ran a main-thread Langium parse, a
  // graph rebuild and a React Flow reflow.  On a memory-constrained phone that
  // churn is the OOM feeder.
  //
  // Two halves make the memo below actually hit:
  //   * every CALLBACK goes through `useStableFns`, which hands back wrappers
  //     with a fixed identity that forward to the newest render's closure (so
  //     nothing is frozen on a stale snapshot — the failure mode a hand-written
  //     `useCallback` dep list invites), and
  //   * every VALUE is listed in the dep array below, in field order.
  //
  // The three `*Ref.current` reads are deliberate deps: they mutate without a
  // render, and listing them reproduces exactly the old behaviour (ctx picks
  // the latest ref value up on whatever render happens next).
  // ---------------------------------------------------------------------
  const ctxFns = useStableFns({
    setExampleId,
    createWorkspaceFromExample,
    getSource: (): string => sourceRef.current,
    setActiveSourcePath: sources.setActivePath,
    // New-file: seed the VFS with a stub body, and only once that write
    // has LANDED flip the active path + schedule a regenerate (matching
    // rename / delete-folder).  This used to be fire-and-forget — an
    // unawaited `write` plus an immediate `setActivePath` and no
    // regenerate — so a failed or ephemeral-mode create left a phantom
    // tree row that evaporated on the next refresh, and a successful one
    // never reached the generator.  `createFile` reports both failure
    // modes on the controller's error channel, which the tree renders.
    createSourceFile: (path: string): void => {
      void (async () => {
        if (await sourcesRef.current.controller.createFile(path, NEW_FILE_SEED)) {
          scheduleAutoGenerate();
        }
      })();
    },
    deleteSourceFile: sources.delete,
    renameSourceFile,
    deleteSourceFolder,
    createEmptySourceFolder: sources.createEmptyFolder,
    deleteEmptySourceFolder: sources.deleteEmptyFolder,
    clearSourceError: sources.clearError,
    setAuthStub,
    onSourceChange: (text: string, origin?: "editor" | "builder"): void => {
      sourceRef.current = text;
      // A real source change (typing in Monaco or a Builder Apply) — from
      // here on, mobile auto-generate is allowed (see hasUserEditedRef).
      hasUserEditedRef.current = true;
      // Bump the live-sync tick **only** for editor-origin edits (the user
      // typing in Monaco).  Builder Apply also flows through here with
      // origin "builder" — bumping for those would re-seed the canvas
      // from the just-applied source and clobber the user's craft
      // selection mid-edit (echo loop).
      if (origin === "editor") setEditorSourceTick((n) => n + 1);
      const s = sourcesRef.current;
      // URL hash is single-file by design (Stage 3 would generalise
      // it).  Only sync when editing main.ddd so the hash doesn't
      // silently flip to a non-main file's content on a tab edit.
      if (s.activePath === "/workspace/main.ddd") {
        scheduleHashSync(text);
      }
      scheduleAutoGenerate();
      // Route the persisted write through the multi-file controller
      // so the workspace-sources state stays in sync.  Read through
      // the ref so the active path reflects the latest hook snapshot
      // if a Phase-2b2 tab switch lands mid-typing.
      s.write(s.activePath, text);
      // Builder (and any non-editor) edits don't flow through Monaco's own
      // change path, so push them into the live model — which also re-runs the
      // LSP — keeping the source tab and Problems panel in sync.
      if (origin !== "editor") editorHandleRef.current?.setSource(text);
    },
    onDiagnosticsChange: setLspDiagnostics,
    scheduleAutoGenerate,
    setSelectedPath,
    setReqMethod,
    setReqPath,
    setReqBody,
    runSelectEndpoint,
    setPathParam,
    setQueryParam,
    runGenerateExample,
    runQuery,
    setLiveMode,
    setActiveTab,
    setDockTab,
    setCodeView,
    setTestResults,
    setOutputStream,
    appendAppLog,
    getAppLog,
    clearBackendLog,
    clearAppLog,
    copyShareLink,
    runAgentDemo: (): void => void runAgentDemo(),
    setAgentSettings,
    sendAgentMessage: (text: string): void => void sendAgentMessage(text),
    clearAgentChat,
    runGenerate: (): void => void runGenerate(true),
    runBundle: (): void => void runBundle(),
    runBoot: (): void => void runBoot(),
    runResetData: (): void => void runResetData(),
    runWipe: (): void => void runWipe(),
    runDispatch: (): void => void runDispatch(),
    runFull: (): void => void runFull(),
    runEvolutionDiff: (ref?: string): void => void runEvolutionDiff(ref),
    pinEvolutionBaseline,
    runCaptureSnapshot: (): void => void runCaptureSnapshot(),
    runDownloadZip,
  });

  const buildClient = buildClientRef.current;
  const engine = engineRef.current;
  const unsupportedDeployables = deployableAnalysis.unsupported;
  const activeSourcePath = sources.activePath;
  const sourceFiles = sources.files;
  const sourceEpoch = sources.epoch;
  const emptySourceFolders = sources.emptyFolders;
  const sourcesWritable = sources.writable;
  const sourcesReadOnlyReason = sources.readOnlyReason;
  const sourceError = sources.lastError;

  const ctx: LayoutCtx = useMemo(
    () => ({
      isDesktop,
      exampleId,
      augmentedExamplesList,
      initialSource,
      workspace,
      activeSourcePath,
      sourceFiles,
      sourceEpoch,
      emptySourceFolders,
      sourcesWritable,
      sourcesReadOnlyReason,
      sourceError,
      lspClient,
      buildClient,
      engine,
      authedRuntime,
      authStub,
      editorSourceTick,
      editorHandleRef,
      diagnostics,
      errorCount,
      generatedConflicts,
      warningCount,
      pipeline,
      generateResult,
      generateSuccess,
      honoBundleResult,
      reactBundleResult,
      reactBundleStatus,
      honoBundle,
      reactBundle,
      previewBundle,
      previewBooted,
      previewProblem,
      ddl,
      persistent,
      migrated,
      bootErrorMessage,
      dispatchSlot,
      files,
      tree,
      selectedFile,
      selectedPath,
      unsupportedDeployables,
      reqMethod,
      reqPath,
      reqBody,
      apiEndpoints,
      selectedOpId,
      selectedEndpoint,
      pathParamValues,
      queryParamValues,
      liveMode,
      activeTab,
      dockTab,
      codeView,
      testResults,
      outputStream,
      backendLog,
      appLog,
      copied,
      agentMessages,
      agentRunning,
      agentSettings,
      evolution,
      evolutionRunning,
      evolutionBaselineRef,
      snapshotResult,
      snapshotRunning,
      ...ctxFns,
    }),
    // Exhaustive over every VALUE field above, in the same order.  `ctxFns`
    // and `editorHandleRef` are identity-stable by construction.
    [
      ctxFns,
      isDesktop,
      exampleId,
      augmentedExamplesList,
      initialSource,
      workspace,
      activeSourcePath,
      sourceFiles,
      sourceEpoch,
      emptySourceFolders,
      sourcesWritable,
      sourcesReadOnlyReason,
      sourceError,
      lspClient,
      buildClient,
      engine,
      authedRuntime,
      authStub,
      editorSourceTick,
      diagnostics,
      errorCount,
      generatedConflicts,
      warningCount,
      pipeline,
      generateResult,
      generateSuccess,
      honoBundleResult,
      reactBundleResult,
      reactBundleStatus,
      honoBundle,
      reactBundle,
      previewBundle,
      previewBooted,
      previewProblem,
      ddl,
      persistent,
      migrated,
      bootErrorMessage,
      dispatchSlot,
      files,
      tree,
      selectedFile,
      selectedPath,
      unsupportedDeployables,
      reqMethod,
      reqPath,
      reqBody,
      apiEndpoints,
      selectedOpId,
      selectedEndpoint,
      pathParamValues,
      queryParamValues,
      liveMode,
      activeTab,
      dockTab,
      codeView,
      testResults,
      outputStream,
      backendLog,
      appLog,
      copied,
      agentMessages,
      agentRunning,
      agentSettings,
      evolution,
      evolutionRunning,
      evolutionBaselineRef,
      snapshotResult,
      snapshotRunning,
    ],
  );

  return (
    <AppShell
      // The desktop toolbar wraps onto a second row below ~1200 px (a
      // common laptop width); a fixed 48 px header then paints that row
      // over the Explorer / editor.  Give the wrapped layout its own
      // height instead of clipping it.
      // Mobile: the 48 px row plus the pipeline dots under it.
      header={{ height: isDesktop ? { base: 88, lg: 48 } : 74 }}
      footer={{ height: isDesktop ? 28 : 0 }}
      padding={0}
    >
      <AppShell.Header>
        {isDesktop ? <DesktopHeader ctx={ctx} /> : <MobileHeader ctx={ctx} />}
      </AppShell.Header>
      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          height:
            "calc(100dvh - var(--app-shell-header-height, 48px) - var(--app-shell-footer-height, 0px))",
        }}
      >
        {isDesktop ? <DesktopShell ctx={ctx} /> : <MobileShell ctx={ctx} />}
      </AppShell.Main>
      {isDesktop && (
        <AppShell.Footer>
          <FooterBar ctx={ctx} />
        </AppShell.Footer>
      )}
    </AppShell>
  );
}
