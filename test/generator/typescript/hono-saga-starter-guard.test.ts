// Event-sourced saga starter guard (S5b) — no double-append on Hono.  When an
// event-sourced workflow declares BOTH `create(e)` and `on(e)` for the SAME
// event, the `on` reactor guards on an empty stream and the `create` starter
// must guard on a NON-empty one (its inverse), so the event folds exactly once:
// a brand-new correlation runs the create, an existing one runs the on, never
// both.  A create with no paired `on` on the same event stays byte-identical.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// create(e: ProjectArchived) AND on(e: ProjectArchived) — the same-event saga pair.
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
} } api A from O storage pg { type: postgres } deployable api { platform: node contexts: [O] serves: A port: 8080 } }`;

// create + on on DIFFERENT events — no pairing, so the starter must NOT guard.
const UNPAIRED = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentReceived { order: Order id, amount: int }
  channel L { carries: OrderPlaced, PaymentReceived  delivery: broadcast  retention: ephemeral }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentReceived { order: p.order, amount: 0 } }
    on(pr: PaymentReceived) by pr.order { emit PaymentReceived { order: pr.order, amount: total } }
    apply(pr: PaymentReceived) { total := total + pr.amount }
  }
} } api A from O storage pg { type: postgres } deployable api { platform: node contexts: [O] serves: A port: 8080 } }`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const file = (files: Map<string, string>, suffix: string): string =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

const fn = (src: string, name: string): string => {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? undefined : after);
};

describe("hono event-sourced saga starter guard (S5b)", () => {
  it("the starter no-ops on a non-empty stream — the inverse of the on-guard", async () => {
    const src = file(await gen(PAIRED), "http/workflows.ts");
    const starter = fn(src, "trackerStartProjectArchived");
    const reactor = fn(src, "trackerOnProjectArchived");
    // The `on` reactor drops on an EMPTY stream (a continuation needs a start).
    expect(reactor).toContain("if (__stream.length === 0) {");
    expect(reactor).toContain("event_unrouted");
    // The starter drops on a NON-empty stream (the on reactor owns it) — inverse.
    expect(starter).toContain("if (__stream.length !== 0) {");
    expect(starter).toContain("event_unrouted");
    // It still appends its own event when the stream IS empty (new correlation).
    expect(starter).toContain("appendTrackerEvents");
  });

  it("the dispatcher runs the on reactor BEFORE the starter (new-stream correctness)", async () => {
    const src = file(await gen(PAIRED), "http/workflows.ts");
    const dispatch = src.slice(src.indexOf("createInProcessDispatcher"));
    const onCall = dispatch.indexOf("trackerOnProjectArchived(db, dispatcher, event)");
    const startCall = dispatch.indexOf("trackerStartProjectArchived(db, dispatcher, event)");
    expect(onCall).toBeGreaterThanOrEqual(0);
    expect(startCall).toBeGreaterThan(onCall);
  });

  it("a create with no paired on stays byte-identical (no exists-guard)", async () => {
    const src = file(await gen(UNPAIRED), "http/workflows.ts");
    const starter = fn(src, "tallyStartOrderPlaced");
    expect(starter).not.toContain("if (__stream.length !== 0)");
  });
});
