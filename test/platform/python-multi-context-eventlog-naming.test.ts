// Multi-context event-log naming (Python; event-log-architecture.md follow-up).
//
// `renderPySchema` receives a MERGED union of every context a Python deployable
// hosts, so a naive emitter names the shared `<ctx>_events` SQLAlchemy model
// (`<Ctx>EventRow` + `__tablename__`) after the merge (the first context) — but
// the per-aggregate repository and the ES-workflow dispatch import it by the
// stream's OWNING context.  In a multi-context deployable those diverge and the
// generated project fails to import (`ImportError: cannot import name
// 'BetaEventRow'`), and the model's table never matches the Alembic migration.
//
// This pins the fix at the lowest catching altitude: pure in-memory
// `generateSystems`, no docker, no `uv`.  The ES streams live in the SECOND
// context (`Beta`), so the merge name (`Alpha`) is deliberately different from
// the owner — a regression to the merge name makes `BetaEventRow` vanish from
// the schema (and `AlphaEventRow` reappear in the repo imports) and these
// assertions fail.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
system MC {
  subdomain S {
    context Alpha {
      aggregate Widget { name: string  operation rename(n: string) { name := n } }
      repository Widgets for Widget { }
    }
    context Beta {
      aggregate Job persistedAs: eventLog {
        label: string
        create start() { emit Started { job: id } }
        apply(e: Started) { label := "" }
      }
      repository Jobs for Job { }
      event Started { job: Job id }
      event Ticked { job: Job id, by: int }
      channel L { carries: Started, Ticked  delivery: broadcast  retention: ephemeral }
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
  deployable api { platform: python contexts: [Alpha, Beta] serves: A dataSources: [alphaState, betaLog] port: 8080 }
}`;

describe("multi-context event-log naming (Python, merged contexts)", () => {
  it("names the <Ctx>EventRow model + table by the stream's OWNING context, not the merge", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    const schema = get("api/app/db/schema.py");
    const jobRepo = get("api/app/db/repositories/job_repository.py");
    const dispatch = get("api/app/dispatch.py");

    // Owning context = Beta: class `BetaEventRow`, table `beta_events`.
    expect(schema).toContain("class BetaEventRow(Base):");
    expect(schema).toContain('__tablename__ = "beta_events"');
    // The aggregate repository AND the ES-workflow dispatch import that class...
    expect(jobRepo).toContain("from app.db.schema import BetaEventRow");
    expect(dispatch).toContain("BetaEventRow");

    // The merge name (Alpha, the first context) must never appear as an event
    // row class — that is the exact regression (`AlphaEventRow` / `alpha_events`
    // in the schema, imported nowhere, so the project fails to load).
    expect(schema).not.toContain("AlphaEventRow");
    expect(jobRepo).not.toContain("AlphaEventRow");
    expect(dispatch).not.toContain("AlphaEventRow");
  });
});
