// Event-sourced saga starter guard (S5b) — no double-append on Python/FastAPI.
// When an event-sourced workflow declares BOTH `create(e)` and `on(e)` for the
// SAME event, the `on` reactor drops on an empty stream and the `create` starter
// must drop on a NON-empty one (its inverse), so the event folds exactly once.
// Python calls on-then-start in ONE dispatcher, so the guard alone closes both
// the new-stream and existing-stream cases.  A create with no paired `on` on the
// same event stays byte-identical.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

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
  deployable api { platform: python contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

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
  deployable api { platform: python contexts: [O] serves: A dataSources: [oState] port: 8080 } }`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

const fn = (src: string, name: string): string => {
  const start = src.indexOf(`async def ${name}(`);
  if (start < 0) return "";
  const after = src.indexOf("\nasync def ", start + 1);
  const after2 = src.indexOf("\nclass ", start + 1);
  const end = [after, after2].filter((x) => x >= 0).sort((a, b) => a - b)[0];
  return src.slice(start, end ?? undefined);
};

describe("python event-sourced saga starter guard (S5b)", () => {
  it("the starter no-ops on a non-empty stream — the inverse of the on-guard", async () => {
    const d = file(await gen(PAIRED), "app/dispatch.py");
    const reactor = fn(d, "_tracker_on_project_archived");
    const starter = fn(d, "_tracker_create_project_archived");
    // `on` drops on an EMPTY stream; the starter drops on a NON-empty one.
    expect(reactor).toContain("if not __events:");
    expect(reactor).toContain("event_unrouted");
    expect(starter).toContain("__events = await _load_tracker_events(session, __key)");
    expect(starter).toContain("if __events:");
    expect(starter).toContain("event_unrouted");
    expect(starter).toContain("return");
  });

  it("the dispatcher runs the on reactor BEFORE the starter", async () => {
    const d = file(await gen(PAIRED), "app/dispatch.py");
    const dispatch = d.slice(d.indexOf("class InProcessDispatcher"));
    const onCall = dispatch.indexOf("await _tracker_on_project_archived(");
    const startCall = dispatch.indexOf("await _tracker_create_project_archived(");
    expect(onCall).toBeGreaterThanOrEqual(0);
    expect(startCall).toBeGreaterThan(onCall);
  });

  it("a create with no paired on stays byte-identical (no exists-guard)", async () => {
    const d = file(await gen(UNPAIRED), "app/dispatch.py");
    const starter = fn(d, "_tally_create_order_placed");
    expect(starter).not.toContain("if __events:");
  });
});
