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

// ---------------------------------------------------------------------
// M-T8.22 — runtime & evolution surfaces.
// ---------------------------------------------------------------------

/** The Migrations tab (audit M8).  The diff auto-runs on open, so the copy
 *  never says "click Refresh"; the picker is "Compare with"; the baseline
 *  default is "Last save"; the button keeps its label while loading. */
export const MIGRATIONS = {
  compareWith: "Compare with",
  lastSave: "Last save",
  refresh: "Refresh",
  /** The loading line — `comparing("Last save")` →
   *  "Comparing the live source with Last save…". */
  comparing: (baseline: string): string => `Comparing the live source with ${baseline}…`,
  /** Shown before the first comparison has produced a result while the
   *  build worker is still starting — says what WILL happen, not what to
   *  click. */
  waitingForWorker: "The comparison starts as soon as the build worker is ready.",
  noBuildWorker: "The comparison needs the build worker, which is not available in this session.",
  schemaHeading: "Schema",
  sqlHeading: "Migration SQL",
  wireHeading: "Wire contract",
  /** Diagram legend, in tint order. */
  tint: { added: "added", changed: "changed", removed: "removed", untouched: "untouched" },
  /** The destructive gate (`docs/migrations.md`): what is blocked, the flag
   *  that lets it through, and the data that would go. */
  destructiveTitle: "Destructive change — blocked by default",
  destructiveFlag: "--allow-destructive",
  destructiveBody:
    "ddd generate system refuses this migration until it runs with the flag below; the SQL shown is the safe add-nullable / backfill / set-not-null sequence it would emit once allowed.",
  destructiveDropsHeading: "Data it would drop",
} as const;

/** Requirement verdicts (audit M9) — sentence case on the badge, one legend
 *  line above the list.  Shared by the Tests tab and the Requirements pane. */
export const VERDICT_LABEL = {
  VERIFIED: "Verified",
  FAILING: "Failing",
  UNTESTED: "Untested",
  UNVERIFIED: "Unverified",
} as const;

export type VerdictKey = keyof typeof VERDICT_LABEL;

export const VERDICT_LEGEND =
  `${VERDICT_LABEL.VERIFIED} = every covering test passed · ` +
  `${VERDICT_LABEL.FAILING} = a covering test failed · ` +
  `${VERDICT_LABEL.UNTESTED} = no test case covers it · ` +
  `${VERDICT_LABEL.UNVERIFIED} = covered, not yet run`;

/** Test discovery (audit M18 / M19). */
export const TEST_DISCOVERY = {
  /** `progress(2, 3, "orders")` → "Discovering tests — suite 2 of 3: orders…" */
  progress: (n: number, total: number, label: string): string =>
    `Discovering tests — suite ${n} of ${total}: ${label}…`,
  cancel: "Cancel",
  cancelled: "Test discovery cancelled.",
  retry: "Retry",
  /** The one line above the raw transform / import error. */
  errorHint: (isDesktop: boolean): string =>
    `Test discovery needs the generated project's dependencies — ${nextStep("bundle", isDesktop)} first, or check the network if that already ran.`,
  showRaw: "Show details",
  hideRaw: "Hide details",
} as const;

/** Runtime tab sub-views (audit M19 / §4 #26). */
export const RUNTIME_VIEW = {
  api: "API",
  db: "Database",
  tables: "Tables",
  requests: "Requests",
} as const;

export const RUNTIME_USERS = {
  heading: "Users",
  builtIn: "Built-in dev identity",
  override: "Override (Auth tab)",
  none: "No dev identities — this system declares no user block, so requests carry no identity.",
  oidc: "OIDC verifier active — identities come from the configured provider, not a stub.",
} as const;

export const REQUESTS = {
  heading: "Requests by operation",
  notFoundHeading: "404s — paths that matched no operation",
  empty: (isDesktop: boolean): string =>
    `No requests yet — call an endpoint from the ${RUNTIME_VIEW.api} view or open the ${PANE.preview}${isDesktop ? "" : " tab"}.`,
  noneNotFound: "Every request so far matched an operation.",
  lastLabel: "Last request",
} as const;

/** "See <stream>" link text — every interpretation line points at exactly
 *  one Output stream. */
export function seeStream(stream: string): string {
  return `See ${PANE.output} → ${stream}`;
}

/** One line of interpretation above a raw runtime response (audit M19). */
export function interpretStatus(status: number): string {
  if (status >= 500) return "The backend threw while handling this request — the stack trace is in the runtime logs.";
  if (status === 404) return "No route matches this method + path — check the endpoint picker, or the 404s list under Requests.";
  if (status === 401 || status === 403) return `The request was rejected by an auth gate — pick an identity under ${PANE.auth} and retry.`;
  if (status === 400 || status === 422) return "The backend rejected the request body or parameters — the body below says which field.";
  if (status >= 400) return "The backend refused the request — the body below carries its reason.";
  return "";
}

/** Interpretation of a dispatch that produced no response at all. */
export const DISPATCH_FAILED =
  "The request never produced a response — the runtime worker threw or was reset before answering.";

/** Interpretation of a boot failure, by the phase the message names. */
export function interpretBootError(message: string): string {
  if (/persist|opfs|storage|stale|drift/i.test(message)) {
    return "The database could not be reused — persisted rows from an earlier boot no longer fit this schema.";
  }
  if (/wasm|pglite|fetch|network|load failed/i.test(message)) {
    return "The in-browser Postgres could not be loaded — its WASM download failed (offline, blocked, or a slow network).";
  }
  if (/memory|oom|out of memory/i.test(message)) {
    return "The browser refused the memory the in-browser Postgres needs — close other tabs or try a desktop browser.";
  }
  return `${STAGE.boot} failed before the API came up — the bundled backend threw while starting.`;
}
