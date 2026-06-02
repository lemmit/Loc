import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { EditorHandle } from "./editor/LoomEditor";
import { LoomLspClient } from "./lsp/client";
import type { Diagnostic } from "./lsp/protocol";
import { syncWorkspaceToLsp } from "./lsp/workspace-lsp-sync";
import { examples, defaultExample, type LoomExample } from "./examples";
import { LoomBuildClient } from "./build/client";
import type { GenerateOk, GenerateResult, VfsEntry, VirtualFile } from "./build/protocol";
import type { BundleOk } from "./bundle/protocol";
import { engineRegistry, selectedEngineId, type RuntimeEngine } from "./engine";
import { emptyDependencySet } from "./engine";
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
import { applyGeneratedTree, readGeneratedTree, startAutoCommit } from "./workspace/git";
import {
  buildShareUrl,
  readHash,
  readHashSource,
  writeHashProject,
  writeHashSource,
  type HashLoad,
} from "./util/share";
import { fnv1a32 } from "./util/hash";
import { usePersistedState } from "./util/usePersistedState";
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
  formatUnsupportedDeployables,
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

// Cap on the live console buffers (Backend / App streams) so a chatty
// handler or render loop can't grow them without bound; we keep the
// most-recent lines.
const LOG_CAP = 1000;
const capLog = (lines: LogLine[]): LogLine[] =>
  lines.length > LOG_CAP ? lines.slice(-LOG_CAP) : lines;

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
  for (const f of files) {
    if (!hono && /^[^/]+\/http\/index\.ts$/.test(f.path)) hono = f.path;
    if (!react && /^[^/]+\/src\/main\.tsx$/.test(f.path)) react = f.path;
    const dotnet = f.path.match(/^([^/]+)\/Program\.cs$/);
    if (dotnet) platformBySlug.set(dotnet[1], "dotnet");
    const phoenix = f.path.match(/^([^/]+)\/mix\.exs$/);
    if (phoenix) platformBySlug.set(phoenix[1], "phoenixLiveView");
  }
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
  // payload — single-file `s=` (legacy) or multi-file `p=` (Stage
  // 3) — we synthesise a "Shared link" entry at the top of the
  // dropdown so a recipient lands on the shared project even before
  // they touch the picker.
  const hashLoadOnMount = useMemo<HashLoad | null>(() => readHash(), []);
  // Legacy single-file snapshot — `null` when the URL hash isn't a source / is
  // empty. Callers that need the project state use `hashLoadOnMount` instead.
  const hashSourceOnMount = useMemo<string | null>(() => readHashSource(), []);
  // Convenience accessor: the source the "Shared link" entry's
  // editor should open with — i.e. the active file's content for a
  // project payload, or the raw text for a single-file payload.
  const hashEntrySource = useMemo<string | null>(() => {
    if (!hashLoadOnMount) return null;
    if (hashLoadOnMount.kind === "single") return hashLoadOnMount.text;
    const { files, active } = hashLoadOnMount.project;
    return files[active] ?? files["/workspace/main.ddd"] ?? null;
  }, [hashLoadOnMount]);
  const examplesList = useMemo<LoomExample[]>(() => {
    if (hashEntrySource === null) return examples;
    // For a multi-file hash we hand the example its full `files`
    // record (workspace-relative paths) so the example-pick effect
    // below writes every file into the VFS.  The legacy single-
    // file form stays single-file (no `files` key).
    const shared: LoomExample = {
      id: "shared",
      label: "Shared link (from URL)",
      source: hashEntrySource,
      blurb:
        "Loaded from the URL hash — your edits update the URL so it stays shareable.",
      ...(hashLoadOnMount?.kind === "project"
        ? {
            files: workspacePathsToRelative(
              hashLoadOnMount.project.files,
              hashLoadOnMount.project.active,
            ),
          }
        : {}),
    };
    return [shared, ...examples];
  }, [hashEntrySource, hashLoadOnMount]);

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

  const augmentedExamplesList = useMemo<LoomExample[]>(() => {
    if (workspace.persistedSource === null || hashSourceOnMount !== null) {
      return examplesList;
    }
    return [
      {
        id: "workspace",
        label: "Workspace (autosaved)",
        source: workspace.persistedSource,
        blurb:
          "Restored from this browser's autosave.  Edits flow back to local IndexedDB so reloads keep your work.",
      },
      ...examplesList,
    ];
  }, [examplesList, workspace.persistedSource, hashSourceOnMount]);

  const [exampleId, setExampleIdRaw] = useState(() =>
    hashSourceOnMount !== null ? "shared" : defaultExample.id,
  );
  // Wrapper so any consumer that picks an example also flips the
  // "user-picked" flag — that flag guards the workspace-autoswitch
  // effect below.  Used by both shell headers.
  const setExampleId = (v: string): void => {
    userPickedExampleRef.current = true;
    setExampleIdRaw(v);
  };

  useEffect(() => {
    if (
      workspace.persistedSource !== null &&
      !userPickedExampleRef.current &&
      exampleId === defaultExample.id
    ) {
      setExampleIdRaw("workspace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.persistedSource]);

  // Content of the currently-picked example.  Drives the editor's
  // initial value for `/workspace/main.ddd`; non-main files take
  // their content from `sources.files` (Phase 2b2).
  const exampleSource = useMemo(
    () =>
      augmentedExamplesList.find((e) => e.id === exampleId)?.source ??
      defaultExample.source,
    [exampleId, augmentedExamplesList],
  );

  // Editor's seed value for the active file.  Precedence:
  //   1. Persisted VFS content for this path (multi-file files
  //      survive tab switches and reloads via IDB).
  //   2. Chosen example (main.ddd only — examples are single-file).
  //   3. Empty body with a stub comment (newly-created non-main
  //      file before the user types anything).
  // The editor remounts via `key={…activePath}` when the active
  // path changes, picking up this freshly-computed value each time.
  const initialSource = useMemo(() => {
    const persisted = sources.files.get(sources.activePath);
    if (persisted !== undefined) return persisted;
    if (sources.activePath === "/workspace/main.ddd") return exampleSource;
    return "// New file — declare a context, valueobject, or enum here.\n";
  }, [sources.files, sources.activePath, exampleSource]);

  const [pipeline, dispatch] = useReducer(pipelineReducer, initialPipelineState);

  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reqMethod, setReqMethod] = useState<string>("GET");
  const [reqPath, setReqPath] = useState<string>("/products");
  const [reqBody, setReqBody] = useState<string>("");
  const [openApiSpec, setOpenApiSpec] = useState<OpenApiDoc | null>(null);
  const [apiEndpoints, setApiEndpoints] = useState<ApiEndpoint[]>([]);
  const [selectedOpId, setSelectedOpId] = useState<string | null>(null);
  const [pathParamValues, setPathParamValues] = useState<Record<string, string>>({});
  const [queryParamValues, setQueryParamValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
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

  // Sub-view of the consolidated Code tab — source / builder / model /
  // generated. Persisted so a reload lands back on the same view.
  const [codeView, setCodeView] = usePersistedState<MobileCodeView>(
    "loom.mobile.codeView",
    "source",
  );

  // Test runner results, lifted here so the Output panel's Tests stream
  // can read them independently of the (sometimes-unmounted) Tests tab.
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  // Which stream the consolidated Output panel shows.  Persisted across
  // reloads; both shells read it off the ctx.
  const [outputStream, setOutputStream] = usePersistedState<OutputStream>(
    "loom.outputStream",
    "problems",
  );

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
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const buildClientRef = useRef<LoomBuildClient | null>(null);
  const engineRef = useRef<RuntimeEngine | null>(null);
  const lspClientRef = useRef<LoomLspClient | null>(null);
  if (lspClientRef.current === null) {
    lspClientRef.current = new LoomLspClient();
  }

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
    if (!store) return;
    return startAutoCommit(store);
  }, [workspace.store]);

  // Push every workspace `.ddd` source into the LSP worker as a Monaco
  // model. Without this, only the currently-edited file reaches the LSP via
  // Monaco's documentSelector, and any `import "./shared/x.ddd"` in main.ddd
  // fails to resolve because the LSP never sees x.ddd. The sync runs once
  // after the controller + LSP client are both available; the controller's
  // own VFS subscription drives subsequent updates.
  const activePathRef = useRef(sources.activePath);
  activePathRef.current = sources.activePath;
  useEffect(() => {
    const dispose = syncWorkspaceToLsp(sources.controller, {
      getActivePath: () => activePathRef.current,
    });
    return dispose;
  }, [sources.controller]);

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
    sourceRef.current = initialSource;
    scheduleAutoGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSource]);

  // Heavy reset — pipeline state, diagnostics, preview, logs,
  // runtime engine — fires only on a genuine "new project" picker
  // change (the example dropdown).  A multi-file tab switch is NOT
  // a new project: the user is still working on the same workspace,
  // so we preserve all of these.
  //
  // Multi-file (Stage 3): the picked example may carry companion
  // `files` (workspace-relative paths).  Seed each into the VFS at
  // `/workspace/<rel>` so the tabs strip shows them and the
  // project loader's import-graph walk resolves them.  We also
  // write `example.source` to `/workspace/main.ddd` and flip the
  // active path so the user lands on main.ddd regardless of what
  // they had open before — a multi-file example with no obvious
  // entry would otherwise leave the editor on a stale file.
  //
  // URL hash always tracks main.ddd content (per-keystroke sync
  // stays single-file by design; explicit Share button generates
  // the multi-file URL via `copyShareLink`), so we use
  // `writeHashSource` here with the example's main.ddd content.
  useEffect(() => {
    const picked = augmentedExamplesList.find((e) => e.id === exampleId);
    const mainContent = picked?.source ?? exampleSource;
    // Phase-3 seeding: write the example's files to the VFS so the
    // workspace immediately reflects the picked example.
    const s = sourcesRef.current;
    s.write("/workspace/main.ddd", mainContent);
    if (picked?.files) {
      for (const [rel, content] of Object.entries(picked.files)) {
        const abs = `/workspace/${rel.replace(/^\/+/, "")}`;
        if (abs.endsWith(".ddd")) s.write(abs, content);
      }
    }
    s.setActivePath("/workspace/main.ddd");
    writeHashSource(mainContent);
    dispatch({ type: "RESET" });
    setDiagnostics([]);
    setSelectedPath(null);
    setPreviewBundle(null);
    setPreviewBooted(false);
    setBackendLog([]);
    setAppLog([]);
    void engineRef.current?.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exampleId]);

  const hashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHashSync = (text: string): void => {
    if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
    hashTimerRef.current = setTimeout(() => writeHashSource(text), 300);
  };

  const autoGenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorCountRef = useRef(0);
  const generatingRef = useRef(false);
  generatingRef.current = pipeline.generating;
  const runGenerateRef = useRef<() => Promise<void> | void>(() => {});
  const scheduleAutoGenerate = (): void => {
    if (autoGenTimerRef.current) clearTimeout(autoGenTimerRef.current);
    autoGenTimerRef.current = setTimeout(() => {
      if (errorCountRef.current === 0 && !generatingRef.current) {
        void runGenerateRef.current();
      }
      // 5s (was 800ms): the preview now refreshes in place, so the
      // debounce is the throttle on how often a background refresh
      // fires — long enough to coalesce a burst of keystrokes into one
      // rebuild after the user pauses.
    }, 5000);
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

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  errorCountRef.current = errorCount;

  const generateResult = pipeline.generate.kind === "result" ? pipeline.generate.result : null;
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

  const reactBundleStatus: ReactBundleStatus = (() => {
    if (pipeline.bundle.kind !== "result") return { kind: "pending" };
    const r = pipeline.bundle.react;
    if (r === null) return { kind: "absent" };
    return r.ok ? { kind: "ok", result: r } : { kind: "fail", result: r };
  })();

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

  async function runGenerateStep(): Promise<GenerateResult | null> {
    const client = buildClientRef.current;
    if (!client) return null;
    dispatch({ type: "GENERATE_START" });
    const entryPath = sourcesRef.current.activePath;
    await client.vfsWrite([{ kind: "file", path: entryPath, content: sourceRef.current }]);
    const result = await client.generateFromPath(entryPath);
    dispatch({ type: "GENERATE_DONE", result });
    if (result.ok && result.files.length > 0) {
      setSelectedPath((prev) => prev ?? result.files[0].path);
    } else {
      setSelectedPath(null);
    }
    return result;
  }

  interface BundleStepResult {
    hono: BundleOk | { ok: false };
    react: BundleOk | { ok: false } | null;
  }

  async function runBundleStep(gen: GenerateOk): Promise<BundleStepResult | null> {
    const engine = engineRef.current;
    if (!engine) return null;
    const entries = analyzeDeployables(gen.files);
    if (!entries.hono) {
      // The playground's runtime is Hono + React only.  Spell out
      // why bundling can't proceed: either nothing recognisable was
      // emitted, or the system only declares deployables the
      // browser can't run (.NET, Phoenix LiveView).
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
    const { hono: honoRes, react: reactRes } = await engine.prepare({
      files: gen.files,
      dependencies: emptyDependencySet(),
      honoEntry: entries.hono,
      reactEntry: entries.react ?? undefined,
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
      const dataDir = `opfs-ahp://loom-${sourceHash}`;
      const res = await engine.boot(hono.code, dataDir, { fresh: opts?.fresh });
      if (res.ok) {
        dispatch({
          type: "BOOT_OK",
          ddl: res.ddl,
          persistent: res.persistent,
          migrated: res.migrated,
        });
        await loadOpenApiSpec(engine);
        return true;
      }
      dispatch({ type: "BOOT_FAIL", message: res.message });
      return false;
    } catch (err) {
      dispatch({
        type: "BOOT_FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
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
  ): Promise<VirtualFile[] | null> {
    const store = workspace.store;
    if (!store || !result?.ok || result.files.length === 0) return null;
    try {
      await applyGeneratedTree(store, result.files);
      const merged = await readGeneratedTree(store);
      if (merged.length === 0) return null;
      return merged.map((f) => ({
        path: f.path,
        content: f.content,
        size: f.content.length,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("failed to version generated output:", err);
      return null;
    }
  }

  async function runGenerate(persist = false): Promise<void> {
    const result = await runGenerateStep();
    let bundleGen: GenerateResult | null = result;
    if (persist && result?.ok) {
      const merged = await persistGeneratedTree(result);
      if (merged) bundleGen = { ...result, files: merged };
    }
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
    if (!generateSuccess) return;
    const result = await runBundleStep(generateSuccess);
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
  async function runFull(): Promise<void> {
    const gen = await runGenerateStep();
    if (!gen?.ok || gen.files.length === 0) return;
    // Intentional run → version the output and bundle the merged tree
    // (reflects hand edits to generated code).
    let bundleGen: GenerateOk = gen;
    const merged = await persistGeneratedTree(gen);
    if (merged) bundleGen = { ...gen, files: merged };
    const bundleRes = await runBundleStep(bundleGen);
    if (!bundleRes?.hono.ok) return;
    const booted = await runBootStep(bundleRes.hono);
    if (!booted) return;
    // React frontend present and successfully bundled → Preview is
    // the natural destination.  Otherwise the user gets the Backend
    // tab so they can poke endpoints against the live runtime.
    setActiveTab(bundleRes.react?.ok ? "preview" : "backend");
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

  const files: VirtualFile[] = generateSuccess?.files ?? [];
  // The `.c4.json` sidecar backs the in-browser LikeC4 render of its
  // `.c4` sibling — kept in `files` for lookup, but hidden from the tree.
  const tree = useMemo(
    () => buildTree(files.filter((f) => !f.path.endsWith(".c4.json"))),
    [files],
  );
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

  // Bundle every piece of state + every action into a single ctx
  // object that the shell + its panes consume.  Children destructure
  // what they need; no React context, no prop drilling.
  const ctx: LayoutCtx = {
    isDesktop,
    exampleId,
    setExampleId,
    augmentedExamplesList,
    initialSource,
    getSource: () => sourceRef.current,
    workspace,
    activeSourcePath: sources.activePath,
    sourceFiles: sources.files,
    setActiveSourcePath: sources.setActivePath,
    // New-file: seed VFS with a stub body so the editor has
    // something non-empty to mount against, then flip the active
    // path.  The Files tab strip validates the basename before
    // calling, so we trust `path` here.
    createSourceFile: (path: string) => {
      const s = sourcesRef.current;
      const seed = "// New file — declare a context, valueobject, or enum here.\n";
      s.write(path, seed);
      s.setActivePath(path);
    },
    deleteSourceFile: sources.delete,
    emptySourceFolders: sources.emptyFolders,
    createEmptySourceFolder: sources.createEmptyFolder,
    deleteEmptySourceFolder: sources.deleteEmptyFolder,
    lspClient: lspClientRef.current,
    buildClient: buildClientRef.current,
    engine: engineRef.current,
    onSourceChange: (text, origin) => {
      sourceRef.current = text;
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
    editorSourceTick,
    onDiagnosticsChange: setDiagnostics,
    scheduleAutoGenerate,
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
    setSelectedPath,
    unsupportedDeployables: deployableAnalysis.unsupported,
    reqMethod,
    setReqMethod,
    reqPath,
    setReqPath,
    reqBody,
    setReqBody,
    apiEndpoints,
    selectedOpId,
    selectedEndpoint,
    runSelectEndpoint,
    pathParamValues,
    setPathParam,
    queryParamValues,
    setQueryParam,
    runGenerateExample,
    runQuery,
    liveMode,
    setLiveMode,
    activeTab,
    setActiveTab,
    codeView,
    setCodeView,
    testResults,
    setTestResults,
    outputStream,
    setOutputStream,
    backendLog,
    appLog,
    appendAppLog,
    getAppLog,
    clearBackendLog,
    clearAppLog,
    copied,
    copyShareLink,
    runGenerate: () => void runGenerate(true),
    runBundle: () => void runBundle(),
    runBoot: () => void runBoot(),
    runResetData: () => void runResetData(),
    runWipe: () => void runWipe(),
    runDispatch: () => void runDispatch(),
    runFull: () => void runFull(),
  };

  return (
    <AppShell
      header={{ height: isDesktop ? 48 : 52 }}
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
