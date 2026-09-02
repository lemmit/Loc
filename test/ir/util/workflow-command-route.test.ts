import { describe, expect, it } from "vitest";
import type { WorkflowIR } from "../../../src/ir/types/loom-ir.js";
import { workflowEmitsCommandRoute } from "../../../src/ir/types/loom-ir.js";
import {
  commandWorkflowsOf,
  emitsCommandRoute,
} from "../../../src/ir/util/workflow-command-route.js";

// `emitsCommandRoute` decides whether a workflow gets a POST route at all, on
// every backend.  Get it wrong in one direction and a reactor saga grows an
// HTTP surface whose Request DTO has an event-typed param (which does not
// compile); get it wrong in the other and a command workflow becomes
// unreachable from outside the process.  M-T9.17 slice 2 — it had no direct
// test.
//
// THE RULE: the facade is the primary unnamed command-triggered create, else
// the first create.  The workflow has a command surface when that facade is
// command-triggered.
//
// ---------------------------------------------------------------------------
// A SECOND COPY OF THIS RULE EXISTS, and the equivalence test at the bottom is
// why this file imports both.  `workflowEmitsCommandRoute` in
// `src/ir/types/loom-ir.ts` is byte-identical logic, and the two have disjoint
// consumers:
//
//   loom-ir.ts copy    → macros/scaffold/_pages, elixir (×2), java (×3)
//   this util copy     → hono, dotnet, python (×2), and system-checks
//
// `workflow-command-route.ts`'s own header says it lives at IR level "so every
// backend imports it DOWN the pipeline — the Hono, .NET, and Python workflow
// emitters each carried a byte-identical copy of this rule".  The
// de-duplication reached those three and stopped; java, elixir and the scaffold
// macro still read the older copy.  They agree TODAY.  Nothing made them.
//
// Consolidating them is a `src/` change and belongs in its own PR; until then
// the equivalence test below turns "they might drift" into "they cannot drift
// silently", which is the part a test can own.
// ---------------------------------------------------------------------------

/** A workflow carrying only the fields these predicates read. */
const wf = (creates: { name: string | null; triggerKind: "event" | "command" }[]): WorkflowIR =>
  ({ name: "W", creates }) as unknown as WorkflowIR;

const cmd = (name: string | null = null) => ({ name, triggerKind: "command" as const });
const evt = (name: string | null = null) => ({ name, triggerKind: "event" as const });

describe("emitsCommandRoute — the facade rule", () => {
  it("a lone command create exposes a route", () => {
    expect(emitsCommandRoute(wf([cmd()]))).toBe(true);
  });

  it("a lone EVENT create does not — a reactor is dispatcher-only", () => {
    // The load-bearing case: emitting a Request DTO with an event-typed param
    // would not compile on any backend.
    expect(emitsCommandRoute(wf([evt()]))).toBe(false);
  });

  it("prefers the unnamed COMMAND create over an earlier event create", () => {
    // Order must not decide it: the facade is chosen by (unnamed ∧ command),
    // so an event-triggered starter listed first does not suppress the route.
    expect(emitsCommandRoute(wf([evt(), cmd()]))).toBe(true);
  });

  it("falls back to the FIRST create when no unnamed command create exists", () => {
    // Both named → no `name === null` match → `creates[0]` decides.
    expect(emitsCommandRoute(wf([evt("onPlaced"), cmd("start")]))).toBe(false);
    expect(emitsCommandRoute(wf([cmd("start"), evt("onPlaced")]))).toBe(true);
  });

  it("a NAMED command create does not win the facade slot over an earlier event", () => {
    // Guards the `c.name === null` half of the find: dropping it would flip
    // the previous case's first assertion to `true`.
    expect(emitsCommandRoute(wf([evt(), cmd("start")]))).toBe(false);
  });

  it("a create-less workflow returns true", () => {
    // Pinned as-is rather than as a claim about routes.  The predicate's `!facade`
    // arm returns true, while its doc comment says "a create-less workflow keeps
    // an empty route" — both hold, because the route LIST a backend builds from
    // the creates is empty regardless.  The comment describes the downstream
    // emission; this function's own answer is `true`.
    expect(emitsCommandRoute(wf([]))).toBe(true);
  });
});

describe("commandWorkflowsOf", () => {
  it("keeps the command workflows and drops the reactors", () => {
    const ctx = {
      workflows: [
        { name: "Place", creates: [cmd()] },
        { name: "OnPlaced", creates: [evt()] },
        { name: "Ship", creates: [cmd()] },
      ],
    } as unknown as Parameters<typeof commandWorkflowsOf>[0];
    expect(commandWorkflowsOf(ctx).map((w) => w.name)).toEqual(["Place", "Ship"]);
  });

  it("returns an empty list for a context with no workflows", () => {
    const ctx = { workflows: [] } as unknown as Parameters<typeof commandWorkflowsOf>[0];
    expect(commandWorkflowsOf(ctx)).toEqual([]);
  });
});

describe("the two copies of the facade rule agree", () => {
  // Every shape the rule can see, crossed.  If either copy is edited alone this
  // fails and names the shape — which is the drift the util module's own header
  // says it exists to prevent, and which its incomplete rollout left possible.
  const SHAPES: { label: string; creates: ReturnType<typeof cmd>[] }[] = [
    { label: "no creates", creates: [] },
    { label: "unnamed command", creates: [cmd()] },
    { label: "unnamed event", creates: [evt()] },
    { label: "named command", creates: [cmd("start")] },
    { label: "named event", creates: [evt("onPlaced")] },
    { label: "event then unnamed command", creates: [evt(), cmd()] },
    { label: "unnamed command then event", creates: [cmd(), evt()] },
    { label: "event then named command", creates: [evt(), cmd("start")] },
    { label: "named command then event", creates: [cmd("start"), evt()] },
    { label: "two events", creates: [evt(), evt("onPlaced")] },
    { label: "two commands", creates: [cmd("a"), cmd("b")] },
  ];

  it.each(SHAPES)("$label", ({ creates }) => {
    const w = wf(creates);
    expect(
      workflowEmitsCommandRoute(w),
      "loom-ir.ts's copy (java / elixir / scaffold macro) disagrees with " +
        "ir/util's (hono / dotnet / python / system-checks) — the two have " +
        "drifted, and half the backends now decide command surfaces differently",
    ).toBe(emitsCommandRoute(w));
  });

  it("the matrix actually covers both answers", () => {
    // Vacuous-pass guard: an all-true (or all-false) matrix would let a copy
    // that always returns a constant pass the equivalence check above.
    const answers = new Set(SHAPES.map((s) => emitsCommandRoute(wf(s.creates))));
    expect(answers).toEqual(new Set([true, false]));
  });
});
