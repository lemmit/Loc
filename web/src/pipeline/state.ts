// Pipeline state machine.
//
// The playground's main flow has four sequential async stages:
//
//   generate → bundle → boot → dispatch
//
// Each stage produces a typed result, each one's success enables the
// next, and every kick of an upstream stage invalidates everything
// downstream.  Before this module the state lived in 11 disjoint
// `useState` slots in App.tsx, with manual `setBundleResult(null)`
// calls scattered across every async handler.  The "forgot to clear
// X" bug class hit twice during PR #1–#15 review (`setDiagnostics`
// not reset on example switch, `dispatchResult` lingering after
// reboot) — both were a missed setter, both would have been impossible
// in this reducer because invalidation is encoded in the transition,
// not the caller.
//
// `state` is one immutable record, `Action` is a tagged union,
// `reducer` (in ./reducer.ts) is total — one branch per action,
// each branch returns a new state with downstream slots cleared.

import type {
  GenerateResult,
  GenerateOk,
} from "../build/protocol.js";
import type {
  BundleOk,
  BundleResult,
} from "../bundle/protocol.js";
import type {
  DispatchResult,
  SerializedResponse,
} from "../runtime/protocol.js";

// ---------------------------------------------------------------------
// Per-stage result slots.  Each is a tagged union of "no attempt yet"
// / success / failure.  Distinguishing "none" from "fail" matters for
// UI: an empty file tree shows "click Generate" before the user has
// done anything, "see Problems" after a failed run.
// ---------------------------------------------------------------------

export type GenerateSlot =
  | { kind: "none" }
  | { kind: "result"; result: GenerateResult };

export type BundleSlot =
  | { kind: "none" }
  | { kind: "result"; hono: BundleResult; react: BundleResult | null };

export type BootSlot =
  | { kind: "none" }
  | { kind: "ok"; ddl: string; persistent: boolean; migrated: boolean }
  | { kind: "fail"; message: string };

export type DispatchSlot =
  | { kind: "none" }
  | { kind: "result"; result: DispatchResult };

// ---------------------------------------------------------------------
// Aggregate state.
// ---------------------------------------------------------------------

export interface PipelineState {
  generate: GenerateSlot;
  bundle: BundleSlot;
  boot: BootSlot;
  dispatch: DispatchSlot;
  // Activity flags — true while the corresponding async call is
  // in flight.  Drive button `loading` props.  Folded into the
  // reducer so START/DONE pairs can't get out of sync (which used
  // to happen if an exception propagated past an early return).
  generating: boolean;
  bundling: boolean;
  booting: boolean;
  dispatching: boolean;
}

export const initialPipelineState: PipelineState = {
  generate: { kind: "none" },
  bundle: { kind: "none" },
  boot: { kind: "none" },
  dispatch: { kind: "none" },
  generating: false,
  bundling: false,
  booting: false,
  dispatching: false,
};

// ---------------------------------------------------------------------
// Actions.  One per START / DONE / RESET.  No "set whatever you want"
// escape hatch — every transition has a name.
// ---------------------------------------------------------------------

export type PipelineAction =
  // Pipeline reset (example switch / explicit clear).
  | { type: "RESET" }
  // Generate
  | { type: "GENERATE_START" }
  | { type: "GENERATE_DONE"; result: GenerateResult }
  // Bundle (one Bundle click does Hono + optionally React)
  | { type: "BUNDLE_START" }
  | { type: "BUNDLE_DONE"; hono: BundleResult; react: BundleResult | null }
  // Boot
  | { type: "BOOT_START" }
  | { type: "BOOT_OK"; ddl: string; persistent: boolean; migrated: boolean }
  | { type: "BOOT_FAIL"; message: string }
  // Dispatch (a single HTTP call from the request composer)
  | { type: "DISPATCH_START" }
  | { type: "DISPATCH_DONE"; result: DispatchResult }
  // "Reset DB" — clears stale dispatch result without touching the
  // boot/bundle/generate slots, since the booted PGlite is still
  // valid (just emptied of rows).
  | { type: "DISPATCH_CLEAR" };

// ---------------------------------------------------------------------
// Convenience selectors.  Keeps JSX terse + makes the read paths
// auditable in one place.
// ---------------------------------------------------------------------

export function generateOk(s: PipelineState): GenerateOk | null {
  return s.generate.kind === "result" && s.generate.result.ok
    ? s.generate.result
    : null;
}

export function honoBundleOk(s: PipelineState): BundleOk | null {
  if (s.bundle.kind !== "result") return null;
  return s.bundle.hono.ok ? s.bundle.hono : null;
}

export function reactBundleOk(s: PipelineState): BundleOk | null {
  if (s.bundle.kind !== "result" || s.bundle.react === null) return null;
  return s.bundle.react.ok ? s.bundle.react : null;
}

export function bootedDDL(s: PipelineState): string | null {
  return s.boot.kind === "ok" ? s.boot.ddl : null;
}

export function bootPersistent(s: PipelineState): boolean {
  return s.boot.kind === "ok" && s.boot.persistent;
}

export function bootMigrated(s: PipelineState): boolean {
  return s.boot.kind === "ok" && s.boot.migrated;
}

export function bootError(s: PipelineState): string | null {
  return s.boot.kind === "fail" ? s.boot.message : null;
}

export function dispatchResponse(
  s: PipelineState,
): SerializedResponse | null {
  if (s.dispatch.kind !== "result" || !s.dispatch.result.ok) return null;
  return s.dispatch.result.response;
}
