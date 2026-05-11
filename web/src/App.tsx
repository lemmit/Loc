import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AppShell,
  Badge,
  Box,
  Button,
  Code,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { LoomEditor } from "./editor/LoomEditor";
import { LoomLspClient } from "./lsp/client";
import type { Diagnostic } from "./lsp/protocol";
import { examples, defaultExample, type LoomExample } from "./examples";
import { LoomBuildClient } from "./build/client";
import type { GenerateResult, VirtualFile } from "./build/protocol";
import { PackPicker } from "./workspace/PackPicker";
import { WorkspaceTree } from "./workspace/WorkspaceTree";
import { useWorkspace } from "./workspace/use-workspace";
import { LoomBundleClient } from "./bundle/client";
import { LoomRuntimeClient } from "./runtime/client";
import { FileTree } from "./preview/FileTree";
import { FileViewer } from "./preview/FileViewer";
import { Preview } from "./preview/Preview";
import { registerPreviewSw } from "./preview/sw-host";
import { buildTree } from "./preview/file-tree";
import {
  buildShareUrl,
  readHashSource,
  writeHashSource,
} from "./util/share";
import { fnv1a32 } from "./util/hash";
import {
  initialPipelineState,
  pipelineReducer,
} from "./pipeline/reducer";
import {
  bootError as selBootError,
  bootMigrated as selBootMigrated,
  bootPersistent as selBootPersistent,
  bootedDDL as selBootedDDL,
  generateOk as selGenerateOk,
  honoBundleOk as selHonoBundleOk,
  reactBundleOk as selReactBundleOk,
} from "./pipeline/state";

// Find the right entry paths in a generated tree.  Legacy
// single-context mode dumps everything at the root.  System mode
// wraps each deployable in a slug folder.
function findEntries(files: VirtualFile[]): { hono: string | null; react: string | null } {
  if (files.some((f) => f.path === "http/index.ts")) {
    // Legacy: only Hono, no React frontend.
    return { hono: "http/index.ts", react: null };
  }
  let hono: string | null = null;
  let react: string | null = null;
  for (const f of files) {
    if (!hono && /^[^/]+\/http\/index\.ts$/.test(f.path)) hono = f.path;
    if (!react && /^[^/]+\/src\/main\.tsx$/.test(f.path)) react = f.path;
  }
  return { hono, react };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface DiagnosticsPanelProps {
  items: Diagnostic[];
}

function DiagnosticsPanel({ items }: DiagnosticsPanelProps): JSX.Element {
  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        No diagnostics.
      </Text>
    );
  }
  return (
    <Stack gap={2} p="xs">
      {items.map((d, i) => {
        const colour =
          d.severity === "error"
            ? "red"
            : d.severity === "warning"
              ? "yellow"
              : "blue";
        return (
          <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
            <Badge size="xs" color={colour} variant="light" mt={2}>
              {d.severity}
            </Badge>
            <Text size="xs" ff="monospace" c="dimmed">
              {d.range.start.line + 1}:{d.range.start.character + 1}
            </Text>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {d.message}
            </Text>
          </Group>
        );
      })}
    </Stack>
  );
}

function modeLabel(result: GenerateResult | null): string {
  if (!result) return "not generated";
  if (!result.ok) return "failed";
  switch (result.mode) {
    case "system": return "system";
    case "ts": return "single Hono project";
    case "none": return "empty";
  }
}

export default function App(): JSX.Element {
  // Read once on mount.  If the URL hash has a `s=` payload we
  // synthesise a "Shared link" entry at the top of the dropdown
  // pointing at that source — picking any other entry afterwards
  // overwrites the editor and the URL hash.
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

  // Workspace persistence (IDB-backed VFS) — opening, hydration,
  // and the persisted-source lookup all live in `useWorkspace`.
  // Boot order spelt out in `WorkspaceState` JSDoc; the augmented
  // examples list + auto-switch effect below realise the
  // "Workspace (autosaved)" UX on top of it.
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

  const [exampleId, setExampleId] = useState(() =>
    hashSourceOnMount !== null ? "shared" : defaultExample.id,
  );

  // After IDB hydrates, switch to the autosaved workspace IF the
  // user hasn't already picked something else.  Tracking via a ref
  // (not derived from state) avoids re-firing the switch on every
  // re-render after the initial discovery.
  useEffect(() => {
    if (
      workspace.persistedSource !== null &&
      !userPickedExampleRef.current &&
      exampleId === defaultExample.id
    ) {
      setExampleId("workspace");
    }
    // exampleId intentionally omitted: we only want this to fire
    // when the persisted source first lands, not on every example
    // switch the user makes after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.persistedSource]);

  const initialSource = useMemo(
    () =>
      augmentedExamplesList.find((e) => e.id === exampleId)?.source ??
      defaultExample.source,
    [exampleId, augmentedExamplesList],
  );

  // Pipeline state machine — generate → bundle → boot → dispatch.
  // Replaces 11 disjoint useStates plus their manual invalidation
  // cascades; see web/src/pipeline/state.ts for the model.
  const [pipeline, dispatch] = useReducer(pipelineReducer, initialPipelineState);

  // Pure-UI state that doesn't belong to the pipeline.
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rightPane, setRightPane] = useState<"files" | "preview">("files");
  const [reqMethod, setReqMethod] = useState<string>("GET");
  const [reqPath, setReqPath] = useState<string>("/products");
  const [reqBody, setReqBody] = useState<string>("");
  const [copied, setCopied] = useState(false);
  // "Live mode" — when on, a successful Generate auto-bundles and
  // a successful Bundle auto-boots, so editing the source rolls
  // straight through to a live preview without clicks.  Off by
  // default because Bundle hits the network (esm.sh) and Boot
  // touches PGlite state — users shouldn't get those side effects
  // unless they opt in.
  const [liveMode, setLiveMode] = useState(false);
  const liveModeRef = useRef(liveMode);
  liveModeRef.current = liveMode;

  // Worker clients — lifetime-scoped to the App.
  const sourceRef = useRef<string>(initialSource);
  const buildClientRef = useRef<LoomBuildClient | null>(null);
  const bundleClientRef = useRef<LoomBundleClient | null>(null);
  const runtimeClientRef = useRef<LoomRuntimeClient | null>(null);
  // LSP client lives at the App level — `<LoomEditor>` is keyed by
  // exampleId and remounts on every example switch, but the LSP
  // worker (Langium services) is heavy and slow to init.  Keeping
  // the client here avoids re-spawning the worker on each switch.
  const lspClientRef = useRef<LoomLspClient | null>(null);
  if (lspClientRef.current === null) {
    lspClientRef.current = new LoomLspClient();
  }

  // Workspace-VFS getter exposed to the build client's seed
  // callback.  Closures captured at LoomBuildClient construction
  // would freeze on the boot-time `null`; reading through a ref
  // each call lets the seed reflect whatever the workspace VFS
  // looks like *now* — including any custom packs imported in
  // this session.
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
    const bundleClient = new LoomBundleClient();
    const runtimeClient = new LoomRuntimeClient();
    buildClientRef.current = build;
    bundleClientRef.current = bundleClient;
    runtimeClientRef.current = runtimeClient;
    setBuildClientReady(true);
    // Preview Service Worker — scaffolding registration.  The SW
    // currently only claims clients and serves a placeholder; the
    // legacy srcdoc preview is still the active path.  Registering
    // here so production deploys exercise the path/scope plumbing
    // before the migration depends on it.  Failures are logged and
    // ignored — they don't break the playground.
    void registerPreviewSw();
    return () => {
      buildClientRef.current = null;
      bundleClientRef.current = null;
      runtimeClientRef.current = null;
      setBuildClientReady(false);
      build.dispose();
      bundleClient.dispose();
      runtimeClient.dispose();
      // LSP client created lazily above survives across this
      // effect's lifetime — dispose it here too.
      lspClientRef.current?.dispose();
      lspClientRef.current = null;
    };
  }, []);

  // Worker-rehydrate on tab background-kill.  Mobile Safari (and
  // some desktop browsers under memory pressure) terminate
  // backgrounded workers — without intervention, the next
  // `generateFromPath` lands on a worker whose VFS is empty and
  // throws "entryPath not found".  We respawn proactively when
  // the page returns to visible after being hidden long enough
  // that the kill is plausible; the LoomBuildClient's seedWorkspace
  // callback re-replays workspace state into the fresh worker, so
  // post-respawn behaviour is operationally indistinguishable
  // from pre-kill.
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
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Replay any persisted custom packs (`/workspace/design/<pack>/...`)
  // into the build worker once both the IDB-backed workspace VFS
  // and the build client are ready.  Without this, a user who
  // imported a pack last session and reloaded would have the pack
  // resident in IDB but invisible to the worker, so generation
  // against `design: "./design/<pack>"` would fail.
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

  // Reset the whole pipeline + UI state when the user picks a
  // different example.  The reducer's RESET kills generate/bundle/
  // boot/dispatch in one shot — no scattered setters to forget.
  // Also kicks the auto-Generate timer so picking an example does
  // a "type one char to trigger" without the typing — the user
  // sees fresh files in the tree ~800 ms later automatically.
  useEffect(() => {
    sourceRef.current = initialSource;
    writeHashSource(initialSource);
    dispatch({ type: "RESET" });
    setDiagnostics([]);
    setSelectedPath(null);
    setRightPane("files");
    runtimeClientRef.current?.reset();
    scheduleAutoGenerate();
    // scheduleAutoGenerate is stable (refs only); excluding from deps
    // avoids re-firing the effect when the ref churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSource]);

  // Debounced URL-hash mirror for live edits.
  const hashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHashSync = (text: string): void => {
    if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
    hashTimerRef.current = setTimeout(() => {
      writeHashSource(text);
    }, 300);
  };

  // Auto-Generate: fire `runGenerate()` after the source has been
  // idle for 800 ms.  Skips when the LSP says the source has parse
  // errors (no point asking the build worker to fail on the same
  // text) and when a generation is already in flight (the next
  // edit will retry).  Manual Bundle / Boot stay explicit because
  // they touch the network and PGlite state respectively — auto-
  // bundling would re-fire ~140 esm.sh fetches per keystroke run
  // even with the warm cache; auto-booting would wipe the user's
  // PGlite data on every edit.
  //
  // Refs (errorCount / generating / source) are read at fire-time,
  // not capture-time, so the timer always reflects the latest
  // editor state when the 800 ms idle elapses.
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
    }, 800);
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
      // Clipboard permission denied or context insecure — the
      // address bar already has the live URL.
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  // Mirror into the ref so the auto-Generate timer can read fresh
  // values without forcing a rebind on every render.
  errorCountRef.current = errorCount;

  // Pipeline selectors — read paths in one place, compose JSX cheaply.
  const generateResult = pipeline.generate.kind === "result"
    ? pipeline.generate.result
    : null;
  const generateSuccess = selGenerateOk(pipeline);
  const honoBundleResult = pipeline.bundle.kind === "result"
    ? pipeline.bundle.hono
    : null;
  const honoBundle = selHonoBundleOk(pipeline);
  const reactBundle = selReactBundleOk(pipeline);
  const ddl = selBootedDDL(pipeline);
  const persistent = selBootPersistent(pipeline);
  const migrated = selBootMigrated(pipeline);
  const bootErrorMessage = selBootError(pipeline);
  const dispatchSlot = pipeline.dispatch.kind === "result"
    ? pipeline.dispatch.result
    : null;

  async function runGenerate(): Promise<void> {
    const client = buildClientRef.current;
    if (!client) return;
    dispatch({ type: "GENERATE_START" });
    // Phase 2 of the IDE refactor: source flows through the build
    // worker's VFS instead of being passed as an inline argument.
    // Awaiting the write before calling generate guarantees the
    // entry path is resident by the time the worker resolves it
    // (writes and generates are serialised in the worker's message
    // queue, but awaiting also lets a future progress UI surface
    // the write step distinctly).
    await client.vfsWrite([
      { path: "/workspace/main.ddd", content: sourceRef.current },
    ]);
    const result = await client.generateFromPath("/workspace/main.ddd");
    dispatch({ type: "GENERATE_DONE", result });
    if (result.ok && result.files.length > 0) {
      // Default to the first file — typically a top-level
      // package.json or domain/<aggregate>.ts.  Lets the user
      // immediately see something instead of an empty viewer.
      setSelectedPath((prev) => prev ?? result.files[0].path);
    } else {
      setSelectedPath(null);
    }
    // Live-mode cascade: roll into Bundle automatically when
    // Generate succeeded.  Manual mode stops here.
    if (liveModeRef.current && result.ok && result.files.length > 0) {
      void runBundleRef.current();
    }
  }
  // Stash the latest closure for the auto-Generate timer — the
  // timer is created in a ref-scoped helper, so it can't capture
  // `runGenerate` directly.  Updating the ref every render is fine
  // (cheap, and timer only fires once).
  runGenerateRef.current = runGenerate;

  async function runBundle(): Promise<void> {
    const client = bundleClientRef.current;
    if (!client || !generateSuccess) return;
    const entries = findEntries(generateSuccess.files);
    if (!entries.hono) {
      // No hono entry → synthesise a fail result the UI can render.
      dispatch({
        type: "BUNDLE_DONE",
        hono: {
          ok: false,
          diagnostics: [
            {
              severity: "error",
              message:
                "No hono deployable found in generated output (looked for http/index.ts).",
            },
          ],
        },
        react: null,
      });
      return;
    }
    dispatch({ type: "BUNDLE_START" });
    const honoRes = await client.bundle({
      kind: "hono",
      files: generateSuccess.files,
      entryPath: entries.hono,
    });
    let reactRes: typeof honoRes | null = null;
    // System mode emits a React deployable too — bundle it so the
    // Preview pane can boot the generated SPA against the same
    // PGlite-backed Hono backend.
    if (honoRes.ok && entries.react) {
      reactRes = await client.bundle({
        kind: "react",
        files: generateSuccess.files,
        entryPath: entries.react,
      });
    }
    dispatch({ type: "BUNDLE_DONE", hono: honoRes, react: reactRes });
    // Live-mode cascade: roll into Boot when the hono bundle
    // succeeded.  Boot uses the migrate-or-apply path, so for
    // unchanged schemas this is fast and preserves data; for
    // schema changes it drops the public schema and re-applies.
    if (liveModeRef.current && honoRes.ok) {
      void runBootRef.current();
    }
  }
  const runBundleRef = useRef<() => Promise<void> | void>(() => {});
  runBundleRef.current = runBundle;

  async function runBoot(): Promise<void> {
    const runtime = runtimeClientRef.current;
    if (!runtime || !honoBundle) return;
    dispatch({ type: "BOOT_START" });
    try {
      // Source-keyed OPFS path: each unique `.ddd` gets its own
      // PGlite data island that survives page reloads.  FNV-1a 32
      // gives an 8-char hex ID; collisions are tolerated because
      // synthDDL emits idempotent CREATE-IF-NOT-EXISTS statements
      // (a hash collision just means two sources share a DB).
      const sourceHash = fnv1a32(sourceRef.current);
      const dataDir = `opfs-ahp://loom-${sourceHash}`;
      const res = await runtime.boot({
        bundleCode: honoBundle.code,
        dataDir,
      });
      if (res.ok) {
        dispatch({
          type: "BOOT_OK",
          ddl: res.ddl,
          persistent: res.persistent,
          migrated: res.migrated,
        });
      } else {
        dispatch({ type: "BOOT_FAIL", message: res.message });
      }
    } catch (err) {
      dispatch({
        type: "BOOT_FAIL",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // No further cascade — Boot is the last stage.  Dispatch (the
  // request composer) is user-driven by design.
  const runBootRef = useRef<() => Promise<void> | void>(() => {});
  runBootRef.current = runBoot;

  async function runWipe(): Promise<void> {
    const runtime = runtimeClientRef.current;
    if (!runtime || ddl === null) return;
    // Wipe is in-place: the booted PGlite stays attached and the
    // Hono app keeps working — only the rows go.  Clear any stale
    // dispatch result so the UI doesn't keep showing a list/get
    // response from before the wipe.
    await runtime.wipe();
    dispatch({ type: "DISPATCH_CLEAR" });
  }

  async function runDispatch(): Promise<void> {
    const runtime = runtimeClientRef.current;
    if (!runtime || ddl === null) return;
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
      const result = await runtime.dispatch({
        url,
        method: reqMethod,
        headers,
        body,
      });
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

  const files: VirtualFile[] = generateSuccess?.files ?? [];
  const tree = useMemo(() => buildTree(files), [files]);
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  return (
    <AppShell header={{ height: { base: 96, sm: 48 } }} footer={{ height: 28 }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="wrap" gap="xs">
          <Group gap="md" wrap="wrap">
            <Title order={5}>Loom Playground</Title>
            <Select
              size="xs"
              value={exampleId}
              onChange={(v) => {
                if (!v) return;
                userPickedExampleRef.current = true;
                setExampleId(v);
              }}
              data={augmentedExamplesList.map((e) => ({ value: e.id, label: e.label }))}
              allowDeselect={false}
              w={300}
            />
            <Button
              size="xs"
              variant="default"
              onClick={copyShareLink}
              data-testid="btn-share"
              title="Copy a link that loads the current source — works for any other user / browser."
            >
              {copied ? "✓ Copied" : "Share link"}
            </Button>
            <PackPicker
              workspaceVfs={workspace.vfs}
              buildClient={buildClientRef.current}
              onImported={() => {
                // A pre-existing `design: "./design/X"` in the
                // editor needs a re-parse before generation will
                // pick the new pack up.  Touching auto-generate
                // re-fires the build worker against the latest
                // source through the new VFS state.
                scheduleAutoGenerate();
              }}
              onError={(err) => {
                // eslint-disable-next-line no-console
                console.warn("pack import:", err.message);
              }}
            />
            <WorkspaceTree
              workspaceVfs={workspace.vfs}
              buildClient={buildClientRef.current}
            />
          </Group>
          <Group gap="xs" wrap="wrap">
            <Button
              size="xs"
              onClick={runGenerate}
              loading={pipeline.generating}
              disabled={errorCount > 0}
              variant="filled"
              data-testid="btn-generate"
            >
              Generate
            </Button>
            <Button
              size="xs"
              onClick={runBundle}
              loading={pipeline.bundling}
              disabled={!generateSuccess || generateSuccess.files.length === 0}
              variant="default"
              data-testid="btn-bundle"
            >
              Bundle
            </Button>
            <Badge color="red" variant={errorCount > 0 ? "filled" : "light"} size="sm">
              {errorCount} error{errorCount === 1 ? "" : "s"}
            </Badge>
            <Badge color="yellow" variant={warningCount > 0 ? "filled" : "light"} size="sm">
              {warningCount} warning{warningCount === 1 ? "" : "s"}
            </Badge>
            <Switch
              size="xs"
              checked={liveMode}
              onChange={(e) => setLiveMode(e.currentTarget.checked)}
              label="Live"
              data-testid="live-mode"
              title="When on, edits cascade Generate → Bundle → Boot automatically."
            />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main style={{
        display: "flex",
        flexDirection: "column",
        // Subtract the header + footer heights via the Mantine
        // AppShell CSS vars so the layout adapts when the header
        // grows to fit the toolbar on narrow viewports (mobile).
        // Hardcoding 76px previously caused the second-row toolbar
        // content to overlay the right pane's tab strip.
        height:
          "calc(100dvh - var(--app-shell-header-height, 48px) - var(--app-shell-footer-height, 28px))",
      }}>
        <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Editor pane */}
          <Box style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--mantine-color-dark-4)" }}>
            {lspClientRef.current && (
              <LoomEditor
                key={exampleId}
                client={lspClientRef.current}
                initialValue={initialSource}
                onChange={(text) => {
                  sourceRef.current = text;
                  scheduleHashSync(text);
                  scheduleAutoGenerate();
                  // Mirror to the IDB-backed workspace VFS.  The
                  // VFS debounces flushes internally (~250ms), so
                  // bursty typing collapses into one IDB write per
                  // natural pause.  Safe to call when the VFS is
                  // still loading — the ref is null then and we
                  // skip silently; persistence resumes on the
                  // next keystroke after IDB resolves.
                  workspace.vfs?.write(
                    "/workspace/main.ddd",
                    text,
                  );
                }}
                onDiagnosticsChange={setDiagnostics}
              />
            )}
          </Box>
          {/* Right pane — toggle between Files (tree + viewer) and
              Preview (iframe of the generated React app, fetches
              routed back to the runtime worker). */}
          <Box style={{ flex: 1.5, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs">
              <SegmentedControl
                size="xs"
                value={rightPane}
                onChange={(v) => setRightPane(v as "files" | "preview")}
                data={[
                  { label: "Files", value: "files" },
                  { label: "Preview", value: "preview" },
                ]}
                data-testid="right-pane-tabs"
              />
              {rightPane === "files" ? (
                <Text size="xs" c="dimmed">
                  {files.length} file{files.length === 1 ? "" : "s"} · {modeLabel(generateResult)}
                </Text>
              ) : (
                <Text size="xs" c={reactBundle && ddl ? "green" : "dimmed"}>
                  {reactBundle && ddl
                    ? "live"
                    : reactBundle
                      ? "needs Boot"
                      : "needs Bundle"}
                </Text>
              )}
            </Group>
            {rightPane === "files" ? (
              <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
                <Box style={{ width: 240, minWidth: 240, borderRight: "1px solid var(--mantine-color-dark-4)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <ScrollArea style={{ flex: 1, minHeight: 0 }}>
                    <FileTree
                      root={tree}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                  </ScrollArea>
                </Box>
                <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <Group px="sm" py={4} bg="dark.7" gap="xs">
                    <Text size="xs" ff="monospace" c={selectedFile ? undefined : "dimmed"}>
                      {selectedFile?.path ?? "no file selected"}
                    </Text>
                  </Group>
                  <Box style={{ flex: 1, minHeight: 0 }}>
                    {selectedFile ? (
                      <FileViewer
                        key={selectedFile.path}
                        path={selectedFile.path}
                        content={selectedFile.content}
                      />
                    ) : (
                      <Box p="md">
                        <Text size="sm" c="dimmed">
                          {generateResult?.ok === false
                            ? "Generation failed — see Problems."
                            : "Click Generate to emit a project from the source."}
                        </Text>
                      </Box>
                    )}
                  </Box>
                  {honoBundleResult && !honoBundleResult.ok && (
                    <Box
                      p="xs"
                      style={{
                        borderTop: "1px solid var(--mantine-color-dark-4)",
                        background: "var(--mantine-color-dark-7)",
                        maxHeight: 160,
                        overflow: "auto",
                      }}
                    >
                      <Text size="xs" fw={600} tt="uppercase" c="red" mb={4}>
                        Bundle errors
                      </Text>
                      <Stack gap={2}>
                        {honoBundleResult.diagnostics.map((d, i) => (
                          <Text key={i} size="xs" ff="monospace" style={{ whiteSpace: "pre-wrap" }}>
                            {d.file ? `${d.file}:${d.line ?? "?"}: ` : ""}
                            {d.message}
                          </Text>
                        ))}
                      </Stack>
                    </Box>
                  )}
                </Box>
              </Box>
            ) : (
              <Box style={{ flex: 1, minHeight: 0 }}>
                {reactBundle && ddl && runtimeClientRef.current ? (
                  <Preview
                    js={reactBundle.code}
                    css={reactBundle.css}
                    versions={reactBundle.versions}
                    runtime={runtimeClientRef.current}
                  />
                ) : (
                  <Box p="md">
                    <Text size="sm" c="dimmed">
                      {!generateSuccess
                        ? "Generate a system-mode source first (the Sales System example has both Hono + React deployables)."
                        : !reactBundle
                          ? honoBundleResult && !honoBundleResult.ok
                            ? "Bundling the React app failed — switch to Files for details."
                            : "Click Bundle to compile the React frontend (~10 s on first run)."
                          : !ddl
                            ? "Boot the backend first — the React app calls into PGlite via the runtime worker."
                            : "Loading…"}
                    </Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Box>
        <Box
          style={{
            height: 220,
            borderTop: "1px solid var(--mantine-color-dark-4)",
            background: "var(--mantine-color-dark-7)",
            overflow: "hidden",
            display: "flex",
          }}
        >
          {/* Problems — half-width.  */}
          <Box style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--mantine-color-dark-4)", display: "flex", flexDirection: "column" }}>
            <Group px="sm" py={4} bg="dark.6" gap="xs">
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                Problems
              </Text>
            </Group>
            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              <DiagnosticsPanel items={diagnostics} />
            </ScrollArea>
          </Box>
          {/* Backend panel — half-width.  Shows a Boot button until
              the bundle is up; afterwards reveals a request composer
              that fires Requests through `app.fetch`. */}
          <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs">
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                Backend
              </Text>
              <Group gap="xs">
                {ddl ? (
                  <Badge size="xs" color="green" variant="light" data-testid="backend-status">booted</Badge>
                ) : (
                  <Badge size="xs" color="gray" variant="light" data-testid="backend-status">offline</Badge>
                )}
                {ddl && (
                  <Badge
                    size="xs"
                    color={persistent ? "blue" : "gray"}
                    variant="light"
                    title={
                      persistent
                        ? "Rows survive page reload — PGlite is OPFS-backed, keyed by source hash."
                        : "Browser refused OPFS storage — rows live in memory and are wiped on reload."
                    }
                    data-testid="persistence-status"
                  >
                    {persistent ? "persisted" : "in-memory"}
                  </Badge>
                )}
                {ddl && migrated && (
                  <Badge
                    size="xs"
                    color="orange"
                    variant="light"
                    title="Schema changed since the previous boot — DROP SCHEMA + re-applied DDL.  Pre-existing rows were dropped."
                    data-testid="migrated-status"
                  >
                    schema migrated
                  </Badge>
                )}
                {ddl && (
                  <Button
                    size="xs"
                    variant="default"
                    onClick={runWipe}
                    title="Drop every row in the booted PGlite and re-apply the schema."
                    data-testid="btn-wipe"
                  >
                    Reset DB
                  </Button>
                )}
                <Button
                  size="xs"
                  onClick={runBoot}
                  loading={pipeline.booting}
                  disabled={!honoBundle}
                  variant="default"
                  data-testid="btn-boot"
                >
                  {ddl ? "Reboot" : "Boot"}
                </Button>
              </Group>
            </Group>
            <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }} p="xs">
              {bootErrorMessage && (
                <Code block c="red" mb="xs" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                  {bootErrorMessage}
                </Code>
              )}
              {ddl ? (
                <Stack gap={6}>
                  <Group gap={6} wrap="nowrap">
                    <Select
                      size="xs"
                      value={reqMethod}
                      onChange={(v) => v && setReqMethod(v)}
                      data={["GET", "POST", "PUT", "DELETE", "PATCH"]}
                      allowDeselect={false}
                      w={90}
                      data-testid="req-method"
                    />
                    <TextInput
                      size="xs"
                      value={reqPath}
                      onChange={(e) => setReqPath(e.currentTarget.value)}
                      placeholder="/products"
                      style={{ flex: 1 }}
                      data-testid="req-path"
                    />
                    <Button
                      size="xs"
                      onClick={runDispatch}
                      loading={pipeline.dispatching}
                      disabled={ddl === null}
                      data-testid="btn-send"
                    >
                      Send
                    </Button>
                  </Group>
                  {(reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH") && (
                    <Textarea
                      size="xs"
                      value={reqBody}
                      onChange={(e) => setReqBody(e.currentTarget.value)}
                      placeholder='{"sku": "W-1", "price": {"amount": 5, "currency": "USD"}}'
                      autosize
                      minRows={2}
                      maxRows={4}
                      styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 11 } }}
                      data-testid="req-body"
                    />
                  )}
                  {dispatchSlot && (
                    dispatchSlot.ok ? (
                      <Box data-testid="resp-ok">
                        <Group gap={6} mb={4}>
                          <Badge
                            size="xs"
                            color={dispatchSlot.response.status < 400 ? "green" : "red"}
                            variant="filled"
                            data-testid="resp-status"
                          >
                            {dispatchSlot.response.status} {dispatchSlot.response.statusText}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {dispatchSlot.durationMs} ms
                          </Text>
                        </Group>
                        <Code block style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 100, overflow: "auto" }} data-testid="resp-body">
                          {dispatchSlot.response.body || "(empty body)"}
                        </Code>
                      </Box>
                    ) : (
                      <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="resp-err">
                        {dispatchSlot.message}
                      </Code>
                    )
                  )}
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">
                  {honoBundle
                    ? "Click Boot to spin up PGlite + the generated Hono app."
                    : "Generate and Bundle first to enable the backend."}
                </Text>
              )}
            </Box>
          </Box>
        </Box>
      </AppShell.Main>
      <AppShell.Footer>
        <Group h="100%" px="md" gap="md" justify="space-between">
          <Text size="xs" c="dimmed">
            Loom Playground — editor + LSP + generator + bundler + runtime
          </Text>
          <Group gap="md">
            <Text size="xs" c="dimmed">
              {generateResult?.ok === false
                ? `generate: ${generateResult.diagnostics.filter((d) => d.severity === "error").length} error(s)`
                : generateResult?.ok
                  ? `generated ${generateResult.files.length} file(s) (${modeLabel(generateResult)})`
                  : "no generation yet"}
            </Text>
            <Text size="xs" c="dimmed">
              {honoBundleResult === null
                ? "no bundle yet"
                : honoBundleResult.ok
                  ? `bundled ${formatBytes(honoBundleResult.size)} in ${honoBundleResult.durationMs} ms (${honoBundleResult.fetchedUrls.length} deps fetched)`
                  : `bundle: ${honoBundleResult.diagnostics.filter((d) => d.severity === "error").length} error(s)`}
            </Text>
          </Group>
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}
