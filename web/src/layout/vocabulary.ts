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

/** What a stage does — the hover text on an enabled segment. */
export const STAGE_HINT: Record<StageId, string> = {
  validate: "Parse + validate the source. Live on desktop; click to open Problems.",
  generate: "Emit the project from the source.",
  bundle: "Compile the generated backend and frontend (~10 s on first run).",
  boot: "Start the generated API and an in-browser Postgres.",
};
