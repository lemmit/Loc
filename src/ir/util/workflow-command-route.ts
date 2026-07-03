// -------------------------------------------------------------------------
// Shared "does this workflow expose an HTTP command route?" predicate.
//
// A workflow exposes a POST command surface when its facade — the primary
// unnamed command-triggered create, else the first create — is
// command-triggered.  A workflow whose facade is event-triggered
// (`create(e: Event)`) is a reactor / saga started by an event and invoked
// only by the in-process dispatcher, never by an HTTP call, so it has no
// command route.  A create-less workflow keeps an empty route.
//
// It lives at IR level (`ir/util/`) so every backend imports it DOWN the
// pipeline — the Hono, .NET, and Python workflow emitters each carried a
// byte-identical copy of this rule (the `page-kind.ts` precedent).  Pure,
// platform-neutral, browser-safe.
// -------------------------------------------------------------------------
import type { EnrichedBoundedContextIR, WorkflowIR } from "../types/loom-ir.js";

/** True when the workflow has an HTTP command surface (a POST route). */
export function emitsCommandRoute(wf: WorkflowIR): boolean {
  const facade =
    wf.creates.find((c) => c.name === null && c.triggerKind === "command") ?? wf.creates[0];
  return !facade || facade.triggerKind === "command";
}

/** The command-route-bearing workflows of a context (filter helper). */
export function commandWorkflowsOf(ctx: EnrichedBoundedContextIR): WorkflowIR[] {
  return ctx.workflows.filter(emitsCommandRoute);
}
