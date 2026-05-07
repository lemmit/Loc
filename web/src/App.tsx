import { useEffect, useMemo, useRef, useState } from "react";
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
import { LoomBundleClient } from "./bundle/client";
import type { BundleResult } from "./bundle/protocol";
import { LoomRuntimeClient } from "./runtime/client";
import type { DispatchResult } from "./runtime/protocol";
import { FileTree } from "./preview/FileTree";
import { FileViewer } from "./preview/FileViewer";
import { Preview } from "./preview/Preview";
import { buildTree } from "./preview/file-tree";
import {
  buildShareUrl,
  readHashSource,
  writeHashSource,
} from "./util/share";

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

  const [exampleId, setExampleId] = useState(() =>
    hashSourceOnMount !== null ? "shared" : defaultExample.id,
  );
  const initialSource = useMemo(
    () =>
      examplesList.find((e) => e.id === exampleId)?.source ??
      defaultExample.source,
    [exampleId, examplesList],
  );
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
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
  const [generating, setGenerating] = useState(false);
  const [bundling, setBundling] = useState(false);
  const [booting, setBooting] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [bundleResult, setBundleResult] = useState<BundleResult | null>(null);
  const [reactBundle, setReactBundle] = useState<BundleResult | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootedDDL, setBootedDDL] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rightPane, setRightPane] = useState<"files" | "preview">("files");
  // Request composer state.
  const [reqMethod, setReqMethod] = useState<string>("GET");
  const [reqPath, setReqPath] = useState<string>("/products");
  const [reqBody, setReqBody] = useState<string>("");
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);

  useEffect(() => {
    const build = new LoomBuildClient();
    const bundleClient = new LoomBundleClient();
    const runtimeClient = new LoomRuntimeClient();
    buildClientRef.current = build;
    bundleClientRef.current = bundleClient;
    runtimeClientRef.current = runtimeClient;
    return () => {
      buildClientRef.current = null;
      bundleClientRef.current = null;
      runtimeClientRef.current = null;
      build.dispose();
      bundleClient.dispose();
      runtimeClient.dispose();
      // LSP client created lazily above survives across this
      // effect's lifetime — dispose it here too.
      lspClientRef.current?.dispose();
      lspClientRef.current = null;
    };
  }, []);

  // Reset preview state when the user picks a different example —
  // the previously generated tree no longer corresponds to the
  // source in the editor.  Also clear the diagnostics list: stale
  // errors from the previous source linger in the Problems panel
  // until the LSP worker re-pushes from the new buffer, which
  // shows wrong red badges in the header for a beat after every
  // example switch.  And mirror the source into the URL hash so
  // the page is always shareable as-is.
  useEffect(() => {
    sourceRef.current = initialSource;
    writeHashSource(initialSource);
    setResult(null);
    setBundleResult(null);
    setReactBundle(null);
    setBootedDDL(null);
    setBootError(null);
    setDispatchResult(null);
    setSelectedPath(null);
    setRightPane("files");
    setDiagnostics([]);
    runtimeClientRef.current?.reset();
  }, [initialSource]);

  // Debounced URL-hash mirror for live edits — the editor's
  // `onChange` writes to `sourceRef`, here we coalesce keystroke
  // bursts (300 ms idle) and push the encoded source into the URL.
  // Stays inside `replaceState` so we don't add a history entry
  // per keystroke.
  const hashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHashSync = (text: string): void => {
    if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
    hashTimerRef.current = setTimeout(() => {
      writeHashSource(text);
    }, 300);
  };
  // Cancel any pending hash write on unmount so we don't push to
  // an already-disposed window.
  useEffect(() => {
    return () => {
      if (hashTimerRef.current) clearTimeout(hashTimerRef.current);
    };
  }, []);

  const [copied, setCopied] = useState(false);
  async function copyShareLink(): Promise<void> {
    try {
      const url = buildShareUrl(sourceRef.current);
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or context insecure; fall back
      // to a no-op — the address bar already has the live URL.
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  async function runGenerate(): Promise<void> {
    const client = buildClientRef.current;
    if (!client) return;
    setGenerating(true);
    try {
      const res = await client.generate(sourceRef.current);
      setResult(res);
      // A new generation invalidates any prior bundle.
      setBundleResult(null);
      if (res.ok && res.files.length > 0) {
        // Default to the first file — typically a top-level
        // package.json or domain/<aggregate>.ts.  Lets the user
        // immediately see something instead of an empty viewer.
        setSelectedPath((prev) => prev ?? res.files[0].path);
      } else {
        setSelectedPath(null);
      }
    } finally {
      setGenerating(false);
    }
  }

  async function runBundle(): Promise<void> {
    const client = bundleClientRef.current;
    if (!client || !result?.ok) return;
    const entries = findEntries(result.files);
    if (!entries.hono) {
      setBundleResult({
        ok: false,
        diagnostics: [
          {
            severity: "error",
            message: "No hono deployable found in generated output (looked for http/index.ts).",
          },
        ],
      });
      return;
    }
    setBundling(true);
    setBootedDDL(null);
    setBootError(null);
    setDispatchResult(null);
    setReactBundle(null);
    try {
      const honoRes = await client.bundle({
        kind: "hono",
        files: result.files,
        entryPath: entries.hono,
      });
      setBundleResult(honoRes);
      // System mode emits a React deployable too — bundle it so the
      // Preview pane can boot the generated SPA against the same
      // PGlite-backed Hono backend.
      if (honoRes.ok && entries.react) {
        const reactRes = await client.bundle({
          kind: "react",
          files: result.files,
          entryPath: entries.react,
        });
        setReactBundle(reactRes);
      }
    } finally {
      setBundling(false);
    }
  }

  async function runBoot(): Promise<void> {
    const runtime = runtimeClientRef.current;
    if (!runtime || !bundleResult?.ok) return;
    setBooting(true);
    setBootError(null);
    setBootedDDL(null);
    setDispatchResult(null);
    try {
      const res = await runtime.boot(bundleResult.code);
      if (res.ok) {
        setBootedDDL(res.ddl);
      } else {
        setBootError(res.message);
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : String(err));
    } finally {
      setBooting(false);
    }
  }

  async function runDispatch(): Promise<void> {
    const runtime = runtimeClientRef.current;
    if (!runtime || !bootedDDL) return;
    setDispatching(true);
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
      const res = await runtime.dispatch({
        url,
        method: reqMethod,
        headers,
        body,
      });
      setDispatchResult(res);
    } catch (err) {
      setDispatchResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDispatching(false);
    }
  }

  const files: VirtualFile[] = result?.ok ? result.files : [];
  const tree = useMemo(() => buildTree(files), [files]);
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  return (
    <AppShell header={{ height: 48 }} footer={{ height: 28 }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="md">
            <Title order={5}>Loom Playground</Title>
            <Select
              size="xs"
              value={exampleId}
              onChange={(v) => v && setExampleId(v)}
              data={examplesList.map((e) => ({ value: e.id, label: e.label }))}
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
          </Group>
          <Group gap="xs">
            <Button
              size="xs"
              onClick={runGenerate}
              loading={generating}
              disabled={errorCount > 0}
              variant="filled"
              data-testid="btn-generate"
            >
              Generate
            </Button>
            <Button
              size="xs"
              onClick={runBundle}
              loading={bundling}
              disabled={!result?.ok || result.files.length === 0}
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
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 76px)" }}>
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
                  {files.length} file{files.length === 1 ? "" : "s"} · {modeLabel(result)}
                </Text>
              ) : (
                <Text size="xs" c={reactBundle?.ok && bootedDDL ? "green" : "dimmed"}>
                  {reactBundle?.ok && bootedDDL
                    ? "live"
                    : reactBundle?.ok
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
                          {result?.ok === false
                            ? "Generation failed — see Problems."
                            : "Click Generate to emit a project from the source."}
                        </Text>
                      </Box>
                    )}
                  </Box>
                  {bundleResult && !bundleResult.ok && (
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
                        {bundleResult.diagnostics.map((d, i) => (
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
                {reactBundle?.ok && bootedDDL && runtimeClientRef.current ? (
                  <Preview
                    js={reactBundle.code}
                    css={reactBundle.css}
                    versions={reactBundle.versions}
                    runtime={runtimeClientRef.current}
                  />
                ) : (
                  <Box p="md">
                    <Text size="sm" c="dimmed">
                      {!result?.ok
                        ? "Generate a system-mode source first (the Sales System example has both Hono + React deployables)."
                        : !reactBundle?.ok
                          ? reactBundle && !reactBundle.ok
                            ? "Bundling the React app failed — switch to Files for details."
                            : "Click Bundle to compile the React frontend (~10 s on first run)."
                          : !bootedDDL
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
                {bootedDDL ? (
                  <Badge size="xs" color="green" variant="light" data-testid="backend-status">booted</Badge>
                ) : (
                  <Badge size="xs" color="gray" variant="light" data-testid="backend-status">offline</Badge>
                )}
                <Button
                  size="xs"
                  onClick={runBoot}
                  loading={booting}
                  disabled={!bundleResult?.ok}
                  variant="default"
                  data-testid="btn-boot"
                >
                  {bootedDDL ? "Reboot" : "Boot"}
                </Button>
              </Group>
            </Group>
            <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }} p="xs">
              {bootError && (
                <Code block c="red" mb="xs" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                  {bootError}
                </Code>
              )}
              {bootedDDL ? (
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
                      loading={dispatching}
                      disabled={!bootedDDL}
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
                  {dispatchResult && (
                    dispatchResult.ok ? (
                      <Box data-testid="resp-ok">
                        <Group gap={6} mb={4}>
                          <Badge
                            size="xs"
                            color={dispatchResult.response.status < 400 ? "green" : "red"}
                            variant="filled"
                            data-testid="resp-status"
                          >
                            {dispatchResult.response.status} {dispatchResult.response.statusText}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {dispatchResult.durationMs} ms
                          </Text>
                        </Group>
                        <Code block style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 100, overflow: "auto" }} data-testid="resp-body">
                          {dispatchResult.response.body || "(empty body)"}
                        </Code>
                      </Box>
                    ) : (
                      <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="resp-err">
                        {dispatchResult.message}
                      </Code>
                    )
                  )}
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">
                  {bundleResult?.ok
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
            Phase 3b — editor + LSP + generator + bundler + runtime
          </Text>
          <Group gap="md">
            <Text size="xs" c="dimmed">
              {result?.ok === false
                ? `generate: ${result.diagnostics.filter((d) => d.severity === "error").length} error(s)`
                : result?.ok
                  ? `generated ${result.files.length} file(s) (${modeLabel(result)})`
                  : "no generation yet"}
            </Text>
            <Text size="xs" c="dimmed">
              {bundleResult === null
                ? "no bundle yet"
                : bundleResult.ok
                  ? `bundled ${formatBytes(bundleResult.size)} in ${bundleResult.durationMs} ms (${bundleResult.fetchedUrls.length} deps fetched)`
                  : `bundle: ${bundleResult.diagnostics.filter((d) => d.severity === "error").length} error(s)`}
            </Text>
          </Group>
        </Group>
      </AppShell.Footer>
    </AppShell>
  );
}
