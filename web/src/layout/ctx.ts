// Bundle of state + actions threaded from App.tsx down into the
// shell components.  Keeping it as a plain interface (no React
// context) means every consumer is explicit about what it reads —
// the props panel in devtools shows exactly which slice each pane
// depends on, and re-renders fan out naturally through React's
// usual prop-equality bailouts.
//
// Children destructure what they need; they don't all consume the
// full ctx.  When a pane needs only 2-3 fields you can pass those
// instead of the whole ctx — see ProblemsPanel for an example.

import type { MutableRefObject, ReactNode } from "react";
import type { AgentMessage } from "../agent/demo";
import type { AgentSettings } from "../agent/provider";
import type { EditorHandle } from "../editor/LoomEditor";
import type { LoomLspClient } from "../lsp/client";
import type { LoomBuildClient } from "../build/client";
import type { RuntimeDispatcher, RuntimeEngine } from "../engine";
import type { Diagnostic } from "../lsp/protocol";
import type {
  EvolutionResult,
  GenerateOk,
  GenerateResult,
  SnapshotResult,
  VirtualFile,
} from "../build/protocol";
import type { BundleFail, BundleOk } from "../bundle/protocol";
import type { LoomExample } from "../examples";
import type { TreeFolder } from "../preview/file-tree";
import type { useWorkspace } from "../workspace/use-workspace";
import type { PipelineState } from "../pipeline/state";
import type { DispatchResult, QueryResult } from "../runtime/protocol";
import type { ApiEndpoint } from "../backend/openapi";
import type { TestResult } from "../testing/harness";
import type { OutputStream } from "./OutputPanel";
import type { LogLine } from "../util/log-line";

export type ReactBundleStatus =
  | { kind: "pending" }
  | { kind: "absent" }
  | { kind: "fail"; result: BundleFail }
  | { kind: "ok"; result: BundleOk };

/** Playground auth-stub config (Phase 7).  When enabled, the configured
 *  claims are injected into every dispatched request as the
 *  `x-loom-dev-claims` header (base64 JSON), which the generated Hono
 *  dev-stub verifier merges over its built-in identity — so an
 *  `auth: required` system is explorable in the sandbox as different
 *  users without a reachable IdP.  No-op for systems with a real
 *  `auth { oidc }` block (the OIDC verifier is active instead). */
export interface AuthStubConfig {
  enabled: boolean;
  /** A JSON object literal of claims, edited in the Auth panel. */
  claimsJson: string;
}

export const DEFAULT_AUTH_STUB: AuthStubConfig = {
  enabled: false,
  claimsJson: '{\n  "role": "admin"\n}',
};

/** Encode the configured claims as the `x-loom-dev-claims` header value
 *  (base64 of UTF-8 JSON) — or null when disabled / empty / invalid, in
 *  which case no header is injected and the dev-stub's built-in identity
 *  stands. */
export function devClaimsHeader(cfg: AuthStubConfig): string | null {
  if (!cfg.enabled) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(cfg.claimsJson);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Platforms whose generated output the playground cannot bundle or
 *  boot — i.e. anything other than Hono + React.  Listed in the UI so
 *  the user understands why Preview is grey instead of erroring out.
 *  `svelte` / `vue` generate a complete, downloadable project (the
 *  preview engine bundles only the React SPA shape — SvelteKit's
 *  `$app/*` client and Vue's SFC pipeline aren't reproduced in-browser
 *  yet), so they're surfaced here exactly like the backend platforms. */
export type UnsupportedPlatform = "dotnet" | "elixir" | "svelte" | "vue";
export interface UnsupportedDeployable {
  slug: string;
  platform: UnsupportedPlatform;
}

export type WorkspaceState = ReturnType<typeof useWorkspace>;

/** Bottom-tab identifiers for the mobile shell.  Lifted to the
 *  context so the `runFull` cascade (from the header's Run button)
 *  can navigate to Preview or Backend on a successful boot — the
 *  Mobile shell consumes activeTab/setActiveTab from here instead of
 *  owning its own state. */
export type MobileTab =
  | "code"
  | "preview"
  | "output"
  | "backend"
  | "tests"
  | "history"
  | "auth";

/** Sub-view of the consolidated mobile "Code" tab: the source editor,
 *  the visual page Builder, the structural Model, or the generated-file
 *  browser. Persisted by App.tsx; mirrors the desktop center-pane switch. */
export type MobileCodeView =
  | "source"
  | "builder"
  | "model"
  | "model-v2"
  | "requirements"
  | "generated";

/** Identifiers for the desktop bottom dock's tabs.  Defined here (rather
 *  than in DevToolsDock) so `LayoutCtx` can carry the active-tab state
 *  without a ctx→DevToolsDock→ctx import cycle; DevToolsDock re-exports it. */
export type DockTab =
  | "output"
  | "agent"
  | "backend"
  | "tests"
  | "migrations"
  | "history"
  | "auth";

export interface LayoutCtx {
  isDesktop: boolean;

  // Example picker
  exampleId: string;
  setExampleId: (v: string) => void;
  /** Create a NEW workspace seeded from an example (non-destructive
   *  "pick a starting point" — distinct from `setExampleId`, which
   *  overwrites the active workspace). */
  createWorkspaceFromExample: (name: string, exampleId: string) => void;
  augmentedExamplesList: LoomExample[];
  initialSource: string;
  /** The live editor source (reflects unsaved edits); for the Builder. */
  getSource: () => string;

  // Workspace (IDB-backed VFS)
  workspace: WorkspaceState;

  /** Workspace path of the file the editor is currently showing.
   *  Phase 2b1 of the multi-file work locks this to
   *  `/workspace/main.ddd`; Phase 2b2 lifts it to the Files panel.
   *  Threading it through the ctx now means Phase 2b2 doesn't have
   *  to touch every shell to pick it up. */
  activeSourcePath: string;
  /** Every `.ddd` source under `/workspace/`, snapshotted from the
   *  workspace-sources controller (Phase 2a).  Drives the Files
   *  tab strip above the editor. */
  sourceFiles: ReadonlyMap<string, string>;
  /** Switch which file the editor shows.  Wired to the controller's
   *  `setActivePath` in Phase 2b2; a no-op when the platform isn't
   *  multi-file (e.g. tests passing a stub ctx). */
  setActiveSourcePath: (path: string) => void;
  /** Create a new `/workspace/<basename>.ddd` with empty body and
   *  immediately switch the active path to it.  The tab strip
   *  validates the basename before calling. */
  createSourceFile: (path: string) => void;
  /** Delete a `.ddd` source file from the VFS.  The tree
   *  never offers this for `/workspace/main.ddd`. */
  deleteSourceFile: (path: string) => void;
  /** Rename a `.ddd` source file: write `newPath` with the old
   *  content and drop `oldPath`, re-pointing the active file when the
   *  renamed one was open. */
  renameSourceFile: (oldPath: string, newPath: string) => void;
  /** Delete a folder and every `.ddd` file under it (workspace-
   *  relative path, no leading slash). */
  deleteSourceFolder: (folder: string) => void;
  /** Workspace-relative folder paths that exist as empty folders
   *  — real VFS dir entries with no `.ddd` descendants.  Tree
   *  picker merges these into its tree as folder-only rows. */
  emptySourceFolders: ReadonlySet<string>;
  /** Create an empty folder via the VFS's first-class `mkdir`.
   *  `folder` is workspace-relative (no leading slash). */
  createEmptySourceFolder: (folder: string) => void;
  /** Delete an empty folder via the VFS's `rmdir`.  Throws if the
   *  folder still has `.ddd` content inside. */
  deleteEmptySourceFolder: (folder: string) => void;

  // Worker clients
  lspClient: LoomLspClient | null;
  buildClient: LoomBuildClient | null;
  engine: RuntimeEngine | null;
  /** Dispatcher handed to the preview — wraps `engine` with the auth-stub
   *  claims-header injection.  Stable identity (so the preview iframe is
   *  not re-mounted when the stub changes). */
  authedRuntime: RuntimeDispatcher;

  // Editor wiring
  /** Canonical-source sink.  `origin` distinguishes edits typed in Monaco
   *  ("editor") from edits applied by the visual Builder ("builder"); the
   *  latter are pushed back into the Monaco model + LSP so all surfaces stay
   *  in sync.  Omitted origin is treated as external (Builder-like). */
  onSourceChange: (text: string, origin?: "editor" | "builder") => void;
  /** Counter incremented on every editor-originated source change (i.e.
   *  the user typing in Monaco).  Drives the page-builder's debounced
   *  live re-seed; builder-originated edits do **not** bump this, so the
   *  Apply path can't echo-loop into the re-seed. */
  editorSourceTick: number;
  onDiagnosticsChange: (items: Diagnostic[]) => void;
  scheduleAutoGenerate: () => void;
  /** Imperative handle to the live Monaco model (set while the editor is
   *  mounted), so Builder edits reflect into the source tab + LSP immediately. */
  editorHandleRef: MutableRefObject<EditorHandle | null>;

  // Diagnostics + counts
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;

  /** Workspace-relative `/workspace/generated` paths that currently carry
   *  unresolved regenerate-merge conflict markers.  Drives the Output
   *  "Conflicts" stream + dot; self-clears as the user resolves them. */
  generatedConflicts: string[];

  // Pipeline state + selectors
  pipeline: PipelineState;
  generateResult: GenerateResult | null;
  generateSuccess: GenerateOk | null;
  honoBundleResult: BundleOk | BundleFail | null;
  reactBundleResult: BundleOk | BundleFail | null;
  reactBundleStatus: ReactBundleStatus;
  honoBundle: BundleOk | null;
  reactBundle: BundleOk | null;
  /** Last react bundle that compiled — what the preview iframe renders.
   *  Retained across the live regenerate cascade (and across a failed
   *  rebuild) so the preview refreshes in place rather than tearing the
   *  iframe down.  Null until the first successful React bundle. */
  previewBundle: BundleOk | null;
  /** True once the backend has booted at least once — the gate for
   *  mounting <Preview>.  Stays true across subsequent rebuilds even
   *  while the boot slot transiently clears. */
  previewBooted: boolean;
  /** The newest generate/bundle attempt failed while a good preview is
   *  still on screen — drives a non-blocking "problem occurred" badge. */
  previewProblem: boolean;
  ddl: string | null;
  persistent: boolean;
  migrated: boolean;
  bootErrorMessage: string | null;
  dispatchSlot: DispatchResult | null;

  // Test runner results — lifted out of TestsPanel so the Output
  // panel's "Tests" stream can render the captured console logs even
  // while the interactive Tests tab is unmounted.
  testResults: Record<string, TestResult>;
  setTestResults: (
    v: Record<string, TestResult> | ((prev: Record<string, TestResult>) => Record<string, TestResult>),
  ) => void;

  // Which stream the consolidated Output panel is showing.  Shared by
  // both shells and persisted by App.tsx.
  outputStream: OutputStream;
  setOutputStream: (s: OutputStream) => void;

  // Live console streams for the Output panel.  `backendLog` is the
  // Hono runtime worker's captured console + stack traces (per RPC);
  // `appLog` is the preview app's console + uncaught errors, forwarded
  // over the sandbox bridge.  Both are capped + cleared on example
  // switch by App.tsx.
  backendLog: LogLine[];
  appLog: LogLine[];
  /** Append one preview-app log line (handed to <Preview onAppLog>). */
  appendAppLog: (line: LogLine) => void;
  /** Live snapshot of the current appLog buffer — read by the UI-test
   *  runner to slice each test's app output (state is stale in its
   *  async closure). */
  getAppLog: () => LogLine[];
  clearBackendLog: () => void;
  clearAppLog: () => void;

  // Files
  files: VirtualFile[];
  tree: TreeFolder;
  selectedFile: VirtualFile | null;
  selectedPath: string | null;
  setSelectedPath: (p: string | null) => void;
  /** Deployables in the generated output that the playground can't
   *  run (.NET, Phoenix LiveView).  Empty for Hono/React-only
   *  systems; the FooterBar + PreviewPane reference this to explain
   *  why those deployables are file-pane-only. */
  unsupportedDeployables: ReadonlyArray<UnsupportedDeployable>;

  // Playground auth stub (Phase 7) — identity injected into dispatched
  // requests via the `x-loom-dev-claims` header.  Persisted by App.tsx.
  authStub: AuthStubConfig;
  setAuthStub: (v: AuthStubConfig | ((prev: AuthStubConfig) => AuthStubConfig)) => void;

  // Backend tester form
  reqMethod: string;
  setReqMethod: (v: string) => void;
  reqPath: string;
  setReqPath: (v: string) => void;
  reqBody: string;
  setReqBody: (v: string) => void;

  // Spec-driven endpoint console — populated from the booted backend's
  // `/openapi.json`.  Empty when the spec couldn't be fetched/parsed, in
  // which case the panel falls back to the bare manual form above.
  apiEndpoints: ApiEndpoint[];
  /** Selected operationId, the CUSTOM_ENDPOINT sentinel, or null. */
  selectedOpId: string | null;
  /** Resolved endpoint for `selectedOpId` (null for Custom / none). */
  selectedEndpoint: ApiEndpoint | null;
  runSelectEndpoint: (opId: string) => void;
  pathParamValues: Record<string, string>;
  setPathParam: (name: string, value: string) => void;
  queryParamValues: Record<string, string>;
  setQueryParam: (name: string, value: string) => void;
  /** Regenerate the request body from the selected endpoint's schema. */
  runGenerateExample: () => void;
  /** Run one SQL statement against the booted DB (Database console). */
  runQuery: (sql: string) => Promise<QueryResult>;

  // Live mode
  liveMode: boolean;
  setLiveMode: (v: boolean) => void;

  // Mobile bottom-tab navigation state — lifted from MobileShell so
  // actions like `runFull` (header Run button) can navigate after a
  // successful cascade.  Persisted to localStorage by App.tsx.
  activeTab: MobileTab;
  setActiveTab: (t: MobileTab) => void;

  // Desktop bottom-dock tab — lifted from DesktopShell so a panel inside
  // the dock (e.g. History) can navigate to a sibling (Migrations) with
  // context.  Persisted by App.tsx.  Mobile has no dock and ignores it.
  dockTab: DockTab;
  setDockTab: (t: DockTab) => void;

  // Sub-view of the consolidated mobile Code tab (source / builder /
  // model / generated). Persisted by App.tsx.
  codeView: MobileCodeView;
  setCodeView: (v: MobileCodeView) => void;

  // Share-link feedback
  copied: boolean;
  copyShareLink: () => void;

  // Agent demo (the Agent dock tab) — the deterministic M-T8.3 wedge: a scripted
  // agent turns prose into a validated `.ddd` and a generated stack, running the
  // real browser-safe `loom_*` tools.  Messages stream as the transcript plays.
  agentMessages: AgentMessage[];
  agentRunning: boolean;
  /** Play (or replay) the scripted prose → `.ddd` → generate → green demo. */
  runAgentDemo: () => void;
  /** BYOK provider settings for the LIVE chat (persisted to localStorage).
   *  Empty key until the user configures a provider. */
  agentSettings: AgentSettings;
  setAgentSettings: (s: AgentSettings) => void;
  /** Send one live-chat turn to the configured provider — drives the real
   *  `loom_*` agent loop, streaming into `agentMessages` and reflecting the
   *  agent's `.ddd` edits into the editor.  No-op until settings are ready. */
  sendAgentMessage: (text: string) => void;
  /** Clear the live chat (display + the carried transcript). */
  clearAgentChat: () => void;

  // Actions
  runGenerate: () => void;
  runBundle: () => void;
  runBoot: () => void;
  /** Re-boot with the persistent DB's stored data dropped first — the
   *  recovery path when a boot keeps failing on stale persisted data. */
  runResetData: () => void;
  runWipe: () => void;
  runDispatch: () => void;

  // Evolution lifecycle (the Migrations dock tab) — the migration + wire-
  // contract delta the live edit implies vs the last-committed baseline,
  // plus on-demand provenance snapshot capture.  Null until the user runs
  // the diff / captures a snapshot (both are deliberate, not auto-run).
  /** Result of the last migration + wire-contract diff, or null. */
  evolution: EvolutionResult | null;
  evolutionRunning: boolean;
  /** Diff the live source against the baseline at `ref` (default `HEAD`,
   *  i.e. the last save) — any commit oid pins an earlier baseline. */
  runEvolutionDiff: (ref?: string) => void;
  /** The baseline ref the Migrations tab currently diffs against — `HEAD`
   *  by default, or a commit oid.  Shared (not panel-local) so the History
   *  tab can pin a milestone as the baseline. */
  evolutionBaselineRef: string;
  /** Pin `ref` as the evolution baseline, reveal the Migrations dock tab,
   *  and run the diff — the one-click "diff against this milestone" from
   *  the History tab (and the Migrations tab's own baseline picker). */
  pinEvolutionBaseline: (ref: string) => void;
  /** Result of the last provenance-snapshot capture, or null. */
  snapshotResult: SnapshotResult | null;
  snapshotRunning: boolean;
  /** Capture immutable `.loom/snapshots/*.loomsnap.json` for the current
   *  source — the playground's `ddd snapshot`. */
  runCaptureSnapshot: () => void;
  /** Download the generated project tree as a single `.zip` — the bridge out
   *  of the browser for backends/frontends the preview can't boot. */
  runDownloadZip: () => void;

  /** Full pipeline cascade — Generate → Bundle → Boot.  On a clean
   *  end, jumps the mobile shell to Preview (if a React deployable
   *  exists) or Backend (if Hono-only).  Used by the mobile header's
   *  "Run" button; desktop continues to expose the per-step buttons.
   *  Pipeline `generating | bundling | booting` flags double as the
   *  loading indicator so a single spinner spans all three stages. */
  runFull: () => void;
}

// Convenience helper — formats the generated-mode label used in the
// Files-pane status text and the FooterBar.  Lives here so both
// the desktop and mobile shells can import a single source of truth.
export function modeLabel(result: GenerateResult | null): string {
  if (!result) return "not generated";
  if (!result.ok) return "failed";
  switch (result.mode) {
    case "system": return "system";
    case "ts": return "single Hono project";
    case "none": return "empty";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human label for a runtime the playground can't host in-browser. */
export function unsupportedPlatformLabel(p: UnsupportedPlatform): string {
  switch (p) {
    case "dotnet":
      return ".NET";
    case "elixir":
      return "Phoenix LiveView";
    case "svelte":
      return "SvelteKit";
    case "vue":
      return "Vue";
  }
}

/** Render the unsupported-deployable list as a comma-joined string —
 *  `"slugA (.NET), slugB (Phoenix LiveView)"`. */
export function formatUnsupportedDeployables(
  items: ReadonlyArray<UnsupportedDeployable>,
): string {
  return items.map((d) => `${d.slug} (${unsupportedPlatformLabel(d.platform)})`).join(", ");
}

// Re-export to keep imports from shells short.
export type { ReactNode };
