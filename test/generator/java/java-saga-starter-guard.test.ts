// ---------------------------------------------------------------------------
// Java backend — event-sourced saga double-append (S5b).  When an event-sourced
// workflow declares BOTH `create(e)` and `on(e)` for the SAME event, the two
// @EventListener methods would fan out in unspecified Spring order and both
// append.  The fix merges them into ONE ordered @EventListener that reads the
// `<wf>_events` stream once and branches (empty → create-logic, non-empty →
// on-logic), so exactly one appends regardless of fan-out order.  A create + on
// on DIFFERENT events stays two independent handlers (byte-identical).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const PAIRED = `system S { subdomain O { context O {
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
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: java contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

const UNPAIRED = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
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
} } api A from O storage pg { type: postgres }
  resource oState { for: O, kind: state, use: pg }
  deployable api { platform: java contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("java event-sourced saga double-append (S5b)", () => {
  it("merges create+on for one event into a SINGLE read-once-branch @EventListener", async () => {
    const d = file(await generateSystemFiles(PAIRED), "workflows/ODispatcher.java");
    // Exactly one @EventListener for the shared event (no separate on/start pair).
    expect(d).toContain("public void onTrackerProjectArchived(ProjectArchived e)");
    expect(d).not.toContain("onTrackerStartProjectArchived");
    expect(d).not.toContain("onTrackerOnProjectArchived");
    // Reads the stream ONCE, then branches.
    expect(d).toContain(
      '"select type, data from o.tracker_events where stream_id = ? order by version", __sid);',
    );
    expect(d).toContain("if (__rows.isEmpty()) {");
    expect(d).toContain("} else {");
    // Single read of the stream for the handler (one queryForList).
    const m = d.slice(d.indexOf("onTrackerProjectArchived"));
    const body = m.slice(0, m.indexOf("\n    }\n"));
    expect(body.match(/order by version", __sid\);/g)?.length).toBe(1);
  });

  it("create+on on DIFFERENT events stay two independent @EventListener methods", async () => {
    const d = file(await generateSystemFiles(UNPAIRED), "workflows/ODispatcher.java");
    expect(d).toContain("onTallyStartOrderPlaced");
    expect(d).toContain("onTallyOnPaymentRegistered");
  });
});
