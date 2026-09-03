// Pipeline-strip state derivation (M-T8.16 slice 1) — pure, so the
// headless unit test can drive it without React.
//
// The strip is the one place that says "do these things in this order":
// Validate → Generate → Bundle → Boot.  Each segment's state is a function
// of the pipeline reducer + the diagnostics, nothing else; the rendering
// component (`PipelineStrip.tsx`) only maps states to buttons.

import type { LayoutCtx } from "./ctx";
import { formatBytes } from "./ctx";
import { BLOCKER, countOf, STAGE, STAGE_HINT, STAGE_ORDER, type StageId } from "./vocabulary";

export type StageState = "idle" | "running" | "ok" | "failed" | "blocked";

export interface StageView {
  id: StageId;
  label: string;
  state: StageState;
  /** A count / size where one exists (`0 errors`, `42 files`, `1.2 MB`). */
  count: string | null;
  /** One sentence naming what stops this stage — set iff `state === "blocked"`. */
  blocker: string | null;
  /** Hover text when the segment is enabled. */
  hint: string;
  /** Whether a click on this segment does anything. */
  enabled: boolean;
}

/** The slice of `LayoutCtx` the derivation reads.  Kept explicit so the
 *  unit test can build one by hand. */
export type StageInputs = Pick<
  LayoutCtx,
  | "isDesktop"
  | "errorCount"
  | "pipeline"
  | "generateResult"
  | "generateSuccess"
  | "honoBundleResult"
  | "reactBundleResult"
  | "honoBundle"
  | "ddl"
  | "bootErrorMessage"
>;

function deriveValidate(c: StageInputs): StageView {
  const base = { id: "validate" as const, label: STAGE.validate, hint: STAGE_HINT.validate, blocker: null };
  // Mobile has no LSP: diagnostics arrive with the generate result, so
  // before the first Run there is nothing to report yet.
  if (!c.isDesktop && c.generateResult == null) {
    return { ...base, state: "idle", count: null, enabled: false };
  }
  if (c.errorCount > 0) {
    return { ...base, state: "failed", count: countOf(c.errorCount, "error"), enabled: true };
  }
  return { ...base, state: "ok", count: countOf(0, "error"), enabled: true };
}

function deriveGenerate(c: StageInputs): StageView {
  const base = { id: "generate" as const, label: STAGE.generate, hint: STAGE_HINT.generate };
  if (c.pipeline.generating) {
    return { ...base, state: "running", count: null, blocker: null, enabled: false };
  }
  if (c.errorCount > 0) {
    return { ...base, state: "blocked", count: null, blocker: BLOCKER.generate(c.errorCount), enabled: false };
  }
  if (c.generateResult != null && !c.generateResult.ok) {
    const errors = c.generateResult.diagnostics.filter((d) => d.severity === "error").length;
    return { ...base, state: "failed", count: countOf(errors, "error"), blocker: null, enabled: true };
  }
  if (c.generateSuccess) {
    return {
      ...base,
      state: "ok",
      count: countOf(c.generateSuccess.files.length, "file"),
      blocker: null,
      enabled: true,
    };
  }
  return { ...base, state: "idle", count: null, blocker: null, enabled: true };
}

function deriveBundle(c: StageInputs): StageView {
  const base = { id: "bundle" as const, label: STAGE.bundle, hint: STAGE_HINT.bundle };
  if (c.pipeline.bundling) {
    return { ...base, state: "running", count: null, blocker: null, enabled: false };
  }
  if (!c.generateSuccess || c.generateSuccess.files.length === 0) {
    return { ...base, state: "blocked", count: null, blocker: BLOCKER.bundle, enabled: false };
  }
  const failed = [c.honoBundleResult, c.reactBundleResult].filter((r) => r != null && !r.ok);
  if (failed.length > 0) {
    const errors = failed.reduce(
      (n, r) => n + (r && !r.ok ? r.diagnostics.filter((d) => d.severity === "error").length : 0),
      0,
    );
    return { ...base, state: "failed", count: countOf(errors, "error"), blocker: null, enabled: true };
  }
  if (c.honoBundle) {
    const size =
      c.honoBundle.size + (c.reactBundleResult && c.reactBundleResult.ok ? c.reactBundleResult.size : 0);
    return { ...base, state: "ok", count: formatBytes(size), blocker: null, enabled: true };
  }
  return { ...base, state: "idle", count: null, blocker: null, enabled: true };
}

function deriveBoot(c: StageInputs): StageView {
  const base = { id: "boot" as const, label: STAGE.boot, hint: STAGE_HINT.boot };
  if (c.pipeline.booting) {
    return { ...base, state: "running", count: null, blocker: null, enabled: false };
  }
  if (!c.honoBundle) {
    return { ...base, state: "blocked", count: null, blocker: BLOCKER.boot, enabled: false };
  }
  if (c.bootErrorMessage) {
    return { ...base, state: "failed", count: null, blocker: null, enabled: true };
  }
  if (c.ddl) {
    return { ...base, state: "ok", count: null, blocker: null, hint: "Booted — click to reboot.", enabled: true };
  }
  return { ...base, state: "idle", count: null, blocker: null, enabled: true };
}

/** All four segments, in pipeline order. */
export function deriveStages(c: StageInputs): StageView[] {
  const byId: Record<StageId, (c: StageInputs) => StageView> = {
    validate: deriveValidate,
    generate: deriveGenerate,
    bundle: deriveBundle,
    boot: deriveBoot,
  };
  return STAGE_ORDER.map((id) => byId[id](c));
}

/** The first stage a click would run — the strip's "next action", rendered
 *  as the filled (primary) segment.  `null` while something is running or
 *  everything is booted. */
export function nextStage(stages: StageView[]): StageId | null {
  if (stages.some((s) => s.state === "running")) return null;
  for (const s of stages) {
    if (s.id === "validate") continue;
    if (s.state === "blocked") return null;
    if (s.state !== "ok") return s.id;
  }
  return null;
}
