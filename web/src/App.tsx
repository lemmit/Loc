import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { EditorHandle } from "./editor/LoomEditor";
import { LoomLspClient } from "./lsp/client";
import type { Diagnostic } from "./lsp/protocol";
import { examples, defaultExample, type LoomExample } from "./examples";
import { LoomBuildClient } from "./build/client";
import type { GenerateOk, GenerateResult, VirtualFile } from "./build/protocol";
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
import { buildShareUrl, readHashSource, writeHashSource } from "./util/share";
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

export default function App(): JSX.Element {
  // Read once on mount.  If the URL hash has a `s=` payload we
  // synthesise a "Shared link" entry at the top of the dropdown.
  const hashSourceOnMount = useMemo(() => readHashSource(), []);
  const examplesList = useMemo<LoomExample[]>(() => {
    if (hashSourceOnMount === null) return examples;
    return [
      {
        id: "shared",
        label: "Shared link (from URL)",
        source: hashSourceOnMount,
        blurb:
          "Loaded from the URL hash — your edits update the URL so it stays shareable.",
      },
      ...examples,
    ];
  }, [hashSourceOnMount]);

  // Responsive layout switch.  Below the Mantine `sm` breakpoint
  // (768 px) we render `MobileShell` (bottom-tab nav, fullscreen
  // panes).  Default `true` keeps SSR + Playwright's 1280-px default
  // viewport on the desktop branch — no flicker for the e2e suite.
  const isDesktop = useMediaQuery("(min-width: 768px)", true) ?? true;

  const workspace = useWorkspace();
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

  const initialSource = useMemo(
    () =>
      augmentedExamplesList.find((e) => e.id === exampleId)?.source ??
      defaultExample.source,
    [exampleId, augmentedExamplesList],
  );

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

  const sourceRef = useRef<string>(initialSource);
  const editorHandleRef = useRef<EditorHandle | null>(null);
  const buildClientRef = useRef<LoomBuildClient | null>(null);
  const engineRef = useRef<RuntimeEngine | null>(null);
  const lspClientRef = useRef<LoomLspClient | null>(null);
  if (lspClientRef.current === null) {
    lspClientRef.current = new LoomLspClient();
  }

  const workspaceForSeedRef = useRef(workspace);
  workspaceForSeedRef.current = workspace;

  useEffect(() => {
    const build = new LoomBuildClient({
      seedWorkspace: () => {
        const vfs = workspaceForSeedRef.current.vfs;
        if (!vfs) return [];
        return vfs.list("/workspace/").flatMap((path) => {
          const content = vfs.read(path);
          return content != null ? [{ path, content }] : [];
        });
      },
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
    const vfs = workspace.vfs;
    const client = buildClientRef.current;
    if (!vfs || !client) return;
    const designPaths = vfs.list("/workspace/design/");
    if (designPaths.length === 0) return;
    const entries = designPaths.flatMap((path) => {
      const content = vfs.read(path);
      return content != null ? [{ path, content }] : [];
    });
    void client.vfsWrite(entries);
  }, [workspace.loaded, workspace.vfs, buildClientReady]);

  useEffect(() => {
    sourceRef.current = initialSource;
    writeHashSource(initialSource);
    dispatch({ type: "RESET" });
    setDiagnostics([]);
    setSelectedPath(null);
    // Drop the retained preview so the iframe remounts for the new
    // example instead of hot-swapping the previous app's bundle.
    setPreviewBundle(null);
    setPreviewBooted(false);
    // The live log streams belong to the previous example's runtime —
    // clear them so stale backend/app output doesn't bleed across.
    setBackendLog([]);
    setAppLog([]);
    void engineRef.current?.reset();
    scheduleAutoGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSource]);

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
      const url = buildShareUrl(sourceRef.current);
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
    await client.vfsWrite([
      { path: "/workspace/main.ddd", content: sourceRef.current },
    ]);
    const result = await client.generateFromPath("/workspace/main.ddd");
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
  async function runGenerate(): Promise<void> {
    const result = await runGenerateStep();
    if (
      liveModeRef.current &&
      result?.ok &&
      result.files.length > 0
    ) {
      const bundleRes = await runBundleStep(result);
      if (bundleRes?.hono.ok) {
        await runBootStep(bundleRes.hono);
      }
    }
  }
  runGenerateRef.current = runGenerate;

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
    const bundleRes = await runBundleStep(gen);
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
    lspClient: lspClientRef.current,
    buildClient: buildClientRef.current,
    engine: engineRef.current,
    onSourceChange: (text, origin) => {
      sourceRef.current = text;
      scheduleHashSync(text);
      scheduleAutoGenerate();
      workspace.vfs?.write("/workspace/main.ddd", text);
      // Builder (and any non-editor) edits don't flow through Monaco's own
      // change path, so push them into the live model — which also re-runs the
      // LSP — keeping the source tab and Problems panel in sync.
      if (origin !== "editor") editorHandleRef.current?.setSource(text);
    },
    onDiagnosticsChange: setDiagnostics,
    scheduleAutoGenerate,
    editorHandleRef,
    diagnostics,
    errorCount,
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
    clearBackendLog,
    clearAppLog,
    copied,
    copyShareLink,
    runGenerate: () => void runGenerate(),
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
