// Multi-context event-log naming (event-log-architecture.md; PR #1836 follow-up).
//
// `renderSchema` receives a MERGED union of every context a Hono deployable
// hosts, so a naive emitter names the shared `<ctx>_events` log after the merge
// (the first context) instead of the event-sourced stream's OWNING context —
// while the per-aggregate repository and the workflow fold helpers name it after
// the owner. In a multi-context deployable those diverge and the generated
// project fails `tsc` (the repo references `schema.<owner>Events`, the schema
// exports `schema.<merge>Events`).
//
// This pins the fix at the lowest catching altitude: pure in-memory
// `generateSystems` (no docker, no LOOM_* env, no channel — the workflow's
// stream/fold codegen is emitted regardless of runtime delivery). The stream
// lives in the SECOND context (`Beta`), so the merge name (`Alpha`, the first
// context) is deliberately different from the owner — a regression to the merge
// name makes `betaEvents` vanish from the schema and the positive assertions
// fail.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

// Alpha (plain CRUD) is declared first so it becomes the merged context name;
// the event-sourced Job aggregate AND the event-sourced Counter workflow live in
// Beta — both share Beta's per-context `beta_events` log. No `channel`: delivery
// is a runtime concern, orthogonal to the stream-table codegen under test.
const SRC = `
system MC {
  subdomain S {
    context Alpha {
      aggregate Widget { name: string  operation rename(n: string) { name := n } }
      repository Widgets for Widget { }
    }
    context Beta {
      aggregate Job persistedAs(eventLog) {
        label: string
        create start() { emit Started { job: id } }
        apply(e: Started) { label := "" }
      }
      repository Jobs for Job { }
      event Started { job: Job id }
      event Ticked { job: Job id, by: int }
      workflow Counter eventSourced {
        jobId: Job id
        total: int
        create(s: Started) by s.job { emit Ticked { job: s.job, by: 1 } }
        on(t: Ticked) by t.job { emit Ticked { job: t.job, by: total } }
        apply(t: Ticked) { total := total + t.by }
      }
    }
  }
  api A from S
  storage pg { type: postgres }
  resource alphaState { for: Alpha, kind: state, use: pg }
  resource betaLog { for: Beta, kind: eventLog, use: pg }
  deployable api { platform: node contexts: [Alpha, Beta] serves: A dataSources: [alphaState, betaLog] port: 8080 }
}`;

describe("multi-context event-log naming (Hono, merged contexts)", () => {
  it("names the shared <ctx>_events log by the stream's OWNING context, not the merge", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    const schema = get("api/db/schema.ts");
    const workflows = get("api/http/workflows.ts");
    const jobRepo = get("api/db/repositories/job-repository.ts");

    // Owning context = Beta: const `betaEvents`, physical `beta_events`, in Beta's schema.
    expect(schema).toContain('export const betaEvents = betaSchema.table("beta_events"');
    // The event-sourced AGGREGATE repository reads the owning-context const...
    expect(jobRepo).toContain("schema.betaEvents");
    // ...and so do the event-sourced WORKFLOW fold helpers (the path fixed alongside).
    expect(workflows).toContain("schema.betaEvents");

    // The merge name (Alpha, the first context) must never leak into the log const —
    // this is the exact regression: `alphaEvents` would appear here instead.
    expect(schema).not.toContain("alphaEvents");
    expect(workflows).not.toContain("schema.alphaEvents");
  });
});
