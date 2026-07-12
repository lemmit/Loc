// ---------------------------------------------------------------------------
// Vanilla Elixir — event-sourced saga starter guard (S5b).  When an event-
// sourced workflow declares BOTH `create(e)` and `on(e)` for the SAME event, the
// `on` reactor drops on an empty stream and the `create` starter must drop on a
// NON-empty one (its inverse), so the event folds exactly once.  The context
// Dispatcher runs the handlers on-then-start in order, so the guard alone closes
// both the new-stream and existing-stream cases.  A create with no paired `on`
// on the same event stays byte-identical (folds unconditionally).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const PAIRED = `system S {
  subdomain O { context O {
    aggregate Order { name: string  operation archive() { emit ProjectArchived { project: id } } }
    repository Orders for Order { }
    event ProjectArchived { project: Order id }
    event ProjectArchivedRecorded { project: Order id, count: int }
    channel L { carries: ProjectArchived, ProjectArchivedRecorded  delivery: broadcast  retention: ephemeral }
    workflow Tracker eventSourced {
      project: Order id
      archivedCount: int
      create(e: ProjectArchived) by e.project { emit ProjectArchivedRecorded { project: e.project, count: 1 } }
      on(e: ProjectArchived) by e.project { emit ProjectArchivedRecorded { project: e.project, count: 1 } }
      apply(r: ProjectArchivedRecorded) { archivedCount := archivedCount + r.count }
    }
  } }
  api A from O
  storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: elixir contexts: [O] dataSources: [oState] serves: A port: 4000 } }`;

const UNPAIRED = `system S {
  subdomain O { context O {
    aggregate Order { status: string  create place() { status := "P"  emit OrderPlaced { order: id } } }
    repository Orders for Order { }
    event OrderPlaced { order: Order id }
    event PaymentRegistered { order: Order id, amount: int }
    channel L { carries: OrderPlaced, PaymentRegistered  delivery: broadcast  retention: ephemeral }
    workflow Tally eventSourced {
      orderId: Order id
      total: int
      create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
      on(pr: PaymentRegistered) by pr.order { precondition total >= 0  emit PaymentRegistered { order: pr.order, amount: total } }
      apply(pr: PaymentRegistered) { total := total + pr.amount }
    }
  } }
  api A from O
  storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: elixir contexts: [O] dataSources: [oState] serves: A port: 4000 } }`;

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("elixir event-sourced saga starter guard (S5b)", () => {
  it("the starter folds only on an empty stream and drops+logs on a non-empty one", async () => {
    const files = await generateSystemFiles(PAIRED);
    const starter = file(files, "workflows/tracker/start_project_archived.ex");
    const reactor = file(files, "workflows/tracker/on_project_archived.ex");
    // The `on` reactor: `[]` → drop+log, `loaded` → fold + body.
    expect(reactor).toContain("case Api.O.Workflows.TrackerStream.load(sid) do");
    expect(reactor).toMatch(/\[\] ->\s+Logger\.warning\("event_unrouted"/);
    // The starter is the inverse: `[]` → fold-from-zero + append, `_loaded` → drop+log.
    expect(starter).toContain("require Logger");
    expect(starter).toContain("case Api.O.Workflows.TrackerStream.load(sid) do");
    expect(starter).toMatch(
      /\[\] ->\s+_state = Api\.O\.Workflows\.TrackerFold\.from_events\(key, \[\]\)/,
    );
    expect(starter).toMatch(/_loaded ->\s+Logger\.warning\("event_unrouted"/);
    expect(starter).toContain("TrackerStream.append(sid, events)");
  });

  it("a create with no paired on stays byte-identical (folds unconditionally, no case/guard)", async () => {
    const starter = file(
      await generateSystemFiles(UNPAIRED),
      "workflows/tally/start_order_placed.ex",
    );
    // Unconditional fold — no stream-exists case branch, no drop+log.
    expect(starter).toContain(
      "_state = Api.O.Workflows.TallyFold.from_events(key, Api.O.Workflows.TallyStream.load(sid))",
    );
    expect(starter).not.toContain("event_unrouted");
    expect(starter).not.toContain("require Logger");
  });
});
