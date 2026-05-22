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
import type { EditorHandle } from "../editor/LoomEditor";
import type { LoomLspClient } from "../lsp/client";
import type { LoomBuildClient } from "../build/client";
import type { RuntimeEngine } from "../engine";
import type { Diagnostic } from "../lsp/protocol";
import type { GenerateOk, GenerateResult, VirtualFile } from "../build/protocol";
import type { BundleFail, BundleOk } from "../bundle/protocol";
import type { LoomExample } from "../examples";
import type { TreeFolder } from "../preview/file-tree";
import type { useWorkspace } from "../workspace/use-workspace";
import type { PipelineState } from "../pipeline/state";
import type { DispatchResult } from "../runtime/protocol";
import type { ApiEndpoint } from "../backend/openapi";

export type ReactBundleStatus =
  | { kind: "pending" }
  | { kind: "absent" }
  | { kind: "fail"; result: BundleFail }
  | { kind: "ok"; result: BundleOk };

/** Platforms whose generated output the playground cannot bundle or
 *  boot — i.e. anything other than Hono + React.  Listed in the UI so
 *  the user understands why Preview is grey instead of erroring out. */
export type UnsupportedPlatform = "dotnet" | "phoenixLiveView";
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
  | "problems"
  | "backend"
  | "tests";

/** Sub-view of the consolidated mobile "Code" tab: the source editor,
 *  the visual page Builder, the structural Model, or the generated-file
 *  browser. Persisted by App.tsx; mirrors the desktop center-pane switch. */
export type MobileCodeView = "source" | "builder" | "model" | "generated";

export interface LayoutCtx {
  isDesktop: boolean;

  // Example picker
  exampleId: string;
  setExampleId: (v: string) => void;
  augmentedExamplesList: LoomExample[];
  initialSource: string;
  /** The live editor source (reflects unsaved edits); for the Builder. */
  getSource: () => string;

  // Workspace (IDB-backed VFS)
  workspace: WorkspaceState;

  // Worker clients
  lspClient: LoomLspClient | null;
  buildClient: LoomBuildClient | null;
  engine: RuntimeEngine | null;

  // Editor wiring
  /** Canonical-source sink.  `origin` distinguishes edits typed in Monaco
   *  ("editor") from edits applied by the visual Builder ("builder"); the
   *  latter are pushed back into the Monaco model + LSP so all surfaces stay
   *  in sync.  Omitted origin is treated as external (Builder-like). */
  onSourceChange: (text: string, origin?: "editor" | "builder") => void;
  onDiagnosticsChange: (items: Diagnostic[]) => void;
  scheduleAutoGenerate: () => void;
  /** Imperative handle to the live Monaco model (set while the editor is
   *  mounted), so Builder edits reflect into the source tab + LSP immediately. */
  editorHandleRef: MutableRefObject<EditorHandle | null>;

  // Diagnostics + counts
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;

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

  // Live mode
  liveMode: boolean;
  setLiveMode: (v: boolean) => void;

  // Mobile bottom-tab navigation state — lifted from MobileShell so
  // actions like `runFull` (header Run button) can navigate after a
  // successful cascade.  Persisted to localStorage by App.tsx.
  activeTab: MobileTab;
  setActiveTab: (t: MobileTab) => void;

  // Sub-view of the consolidated mobile Code tab (source / builder /
  // model / generated). Persisted by App.tsx.
  codeView: MobileCodeView;
  setCodeView: (v: MobileCodeView) => void;

  // Share-link feedback
  copied: boolean;
  copyShareLink: () => void;

  // Actions
  runGenerate: () => void;
  runBundle: () => void;
  runBoot: () => void;
  runWipe: () => void;
  runDispatch: () => void;
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
  return p === "dotnet" ? ".NET" : "Phoenix LiveView";
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
