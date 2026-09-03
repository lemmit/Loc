// The playground's one vocabulary (M-T8.16).
//
// Every user-visible name for a pipeline stage, a pane, an Output stream
// or a precondition comes from here.  The audit (playground-ux-review
// 2026-09, M7) found one concept under three names — the dock tab said
// *Runtime*, the Output stream said *Backend logs*, the test id said
// `backend-status` — and the same precondition phrased three ways.  A new
// literal "Backend logs" / "Reqs" / "spin up PGlite" in a `.tsx` is a review
// reject; `test/playground/vocabulary.test.ts` ratchets the retired ones.
//
// Pure data + string builders — no React, no DOM — so the ratchet test can
// import it under vitest.

/** The four pipeline stages, in order.  `validate` is live on desktop (the
 *  LSP) and part of Run on mobile; the other three are the buttons. */
export type StageId = "validate" | "generate" | "bundle" | "boot";

export const STAGE_ORDER: readonly StageId[] = ["validate", "generate", "bundle", "boot"];

export const STAGE: Record<StageId, string> = {
  validate: "Validate",
  generate: "Generate",
  bundle: "Bundle",
  boot: "Boot",
};

/** Mobile's one verb — Generate → Bundle → Boot in a single tap. */
export const RUN = "Run";

/** The strip's auto toggle (the old "Live" switch).  Validate is always
 *  live; Generate follows the toggle; Bundle + Boot never auto-run unless it
 *  is on — today's cascade, now with a label that says so. */
export const AUTO_RUN = "Auto-run on edit";
export const AUTO_RUN_HINT = "When on, every edit cascades Generate → Bundle → Boot.";

/** Pane / tab names — the dock, the mobile tab bar, the centre switcher. */
export const PANE = {
  source: "Source",
  builder: "Builder",
  model: "Model",
  requirements: "Requirements",
  generated: "Generated",
  code: "Code",
  preview: "Preview",
  output: "Output",
  agent: "Agent",
  runtime: "Runtime",
  tests: "Tests",
  migrations: "Migrations",
  history: "History",
  auth: "Auth",
  more: "More",
  explorer: "Explorer",
  devTools: "Dev Tools",
  examples: "Examples",
} as const;

/** Output streams. */
export const STREAM = {
  problems: "Problems",
  generator: "Generator",
  bundler: "Bundler",
  conflicts: "Conflicts",
  runtimeLogs: "Runtime logs",
  appLogs: "App logs",
  tests: "Tests",
  diagnostics: "Diagnostics",
} as const;

/** Runtime status badge text (`backend-status`). */
export const RUNTIME_STATUS = { booted: "booted", offline: "offline" } as const;

/** Pluralised count — `1 error`, `3 errors`, `0 files`. */
export function countOf(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The ONE phrasing for "what do I do to get to stage X".  Desktop names
 *  the chain of buttons; mobile always says Tap Run.  Callers append the
 *  purpose (" to start the in-browser backend").
 *
 *    nextStep("boot", true)   → "Generate, then Bundle, then Boot"
 *    nextStep("bundle", true) → "Generate, then Bundle"
 *    nextStep("generate", true) → "Click Generate"
 *    nextStep(_, false)       → "Tap Run"
 */
export function nextStep(stage: Exclude<StageId, "validate">, isDesktop: boolean): string {
  if (!isDesktop) return `Tap ${RUN}`;
  switch (stage) {
    case "generate":
      return `Click ${STAGE.generate}`;
    case "bundle":
      return `${STAGE.generate}, then ${STAGE.bundle}`;
    case "boot":
      return `${STAGE.generate}, then ${STAGE.bundle}, then ${STAGE.boot}`;
  }
}

/** `nextStep` for mid-sentence use — "Nothing generated yet — click
 *  Generate to …".  Only the verb forms change case; the button chain
 *  starts with a stage name and stays as it is. */
export function nextStepMid(stage: Exclude<StageId, "validate">, isDesktop: boolean): string {
  const s = nextStep(stage, isDesktop);
  return s.startsWith("Click ") || s.startsWith("Tap ") ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Why a stage cannot run right now — one sentence, shown as the blocked
 *  segment's tooltip on the pipeline strip and reused by the panes. */
export const BLOCKER = {
  generate: (errors: number): string =>
    `Fix the ${countOf(errors, "error")} in your source first (${PANE.output} → ${STREAM.problems}).`,
  bundle: `${STAGE.generate} first — ${STAGE.bundle} compiles the generated backend and frontend.`,
  boot: `${nextStep("boot", true)} — ${STAGE.boot} runs the bundled backend on an in-browser Postgres.`,
} as const;

// ---------------------------------------------------------------------------
// M-T8.18 — Problems as a teaching surface, the palette, help, first run.
// ---------------------------------------------------------------------------

/** The Problems stream's row actions, filters and announcements. */
export const PROBLEMS = {
  empty: "No problems — the source is valid.",
  /** Both filters off, or the on-filter matches nothing. */
  filteredOut: "Nothing to show — turn a filter back on.",
  fix: "Fix",
  fixHint: "Apply the compiler's suggested repair to the source.",
  askAgent: "Ask the agent",
  askAgentHint: `Open the ${PANE.agent} tab with this problem in the composer.`,
  docs: "Docs",
  docsHint: (code: string): string => `What the reference says about ${code}.`,
  errors: "Errors",
  warnings: "Warnings",
  next: "Next problem (F8)",
  previous: "Previous problem (Shift+F8)",
  /** The `aria-live` line when F8 lands on a problem. */
  announce: (index: number, total: number, line: number, message: string): string =>
    `Problem ${index} of ${total}, line ${line}: ${message}`,
  /** The `aria-live` line when there is nothing to step to. */
  announceNone: "No problems.",
  /** The agent composer prefill built from a diagnostic. */
  agentPrompt: (line: number, code: string | undefined, message: string): string =>
    `Fix this problem on line ${line}${code ? ` (${code})` : ""}: ${message}`,
} as const;

/** The visual panes' parse-error state (audit H7) — shared copy for the four
 *  panes; `purpose` is the pane's own clause ("to use the builder"). */
export const PARSE_ERROR = {
  /** Kept as the leading phrase: `builder-page.spec.ts` asserts on it. */
  title: "Source has syntax errors",
  body: (purpose: string): string => `Fix them in the editor ${purpose}.`,
  goToLine: (line: number): string => `Go to line ${line}`,
  purpose: {
    builder: "to use the builder",
    model: "to use the model builder",
    requirements: "to see the requirements view",
  },
} as const;

/** The `?` help menu. */
export const HELP = {
  menu: "Help",
  docs: "Docs",
  reference: "Language reference",
  shortcuts: "Keyboard shortcuts",
  report: "Report a problem",
  docsUrl: "https://lemmit.github.io/Loc/",
  referenceUrl: "https://lemmit.github.io/Loc/language-reference/README.html",
} as const;

/** The ⌘K command palette. */
export const PALETTE = {
  title: "Command palette",
  placeholder: "Type a command…",
  nothingFound: "No matching command.",
  group: {
    run: "Run",
    view: "Views",
    dock: PANE.devTools,
    workspace: "Workspace",
    share: "Share & export",
    help: HELP.menu,
  },
  run: (stage: string): string => `Run ${stage}`,
  runFull: `${RUN} — ${STAGE.generate} → ${STAGE.bundle} → ${STAGE.boot}`,
  show: (pane: string): string => `Show ${pane}`,
  newWorkspace: "New workspace…",
  renameWorkspace: "Rename workspace…",
  deleteWorkspace: "Delete workspace…",
  exportZip: "Download generated project (.zip)",
  share: "Copy share link",
  workspaceName: "Workspace name",
  create: "Create",
  rename: "Rename",
} as const;

/** The `?` shortcut sheet — every binding the app installs, plus the two the
 *  editor owns that people ask about. */
export const SHORTCUTS = {
  title: "Keyboard shortcuts",
  note: "Inside the editor, Tab indents; press Esc then Tab to move focus out. The editor keeps its own F1 command list.",
  undoNote: "⌘Z / Ctrl+Z undo and ⌘⇧Z / Ctrl+⇧Z / Ctrl+Y redo also work from the visual panes — they reach the source's own undo stack.",
} as const;

/** The first-run card (audit H5). */
export const FIRST_RUN = {
  title: "Start building",
  blurb:
    "A .ddd file describes a system — aggregates, workflows, pages — and Loom generates the whole stack from it, in this tab.",
  describe: "Describe a system",
  describeHint: "Tell the agent what to build in plain English.",
  example: "Start from an example",
  exampleHint: "Open one of the sample systems in a new workspace.",
  write: "Write .ddd",
  writeHint: "Jump into the editor with this starter.",
  dismiss: "Don't show again",
} as const;

/** The Examples pane / sheet. */
export const EXAMPLES = {
  pane: "Examples",
  hint: "Each opens in a new workspace — the current one is untouched.",
  open: "Open in a new workspace",
  unread: "Not opened yet",
  read: "Opened before",
  concept: {
    crud: "CRUD & aggregates",
    workflows: "Workflows & events",
    auth: "Auth & capabilities",
    tenancy: "Persistence & data",
    multiBackend: "Multi-backend systems",
    frontends: "Frontends & design packs",
  },
} as const;

/** What a stage does — the hover text on an enabled segment. */
export const STAGE_HINT: Record<StageId, string> = {
  validate: "Parse + validate the source. Live on desktop; click to open Problems.",
  generate: "Emit the project from the source.",
  bundle: "Compile the generated backend and frontend (~10 s on first run).",
  boot: "Start the generated API and an in-browser Postgres.",
};
