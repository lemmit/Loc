// Multi-context event-log naming (.NET / EF Core; event-log-architecture.md
// follow-up).
//
// EF Core maps each CLR entity type to a SINGLE table, so the per-context
// `<ctx>_events` log needs a distinct entity per context — a shared `EventRecord`
// POCO with N `IEntityTypeConfiguration<EventRecord>` (one per context, each
// `ToTable`-ing a different `<ctx>_events`) collapses to one table under EF's
// last-wins mapping, so a deployable hosting several event-sourced contexts
// routes one context's streams to the other's table (or fails the model build).
//
// The fix emits `<Ctx>EventRecord` + `<Ctx>Events` per event-sourced context.
// This pins it in-memory (no docker): TWO event-sourced contexts (Alpha, Beta),
// so a single shared type would be observably wrong.  Beta also carries an ES
// *workflow* (Counter), so the merged-context dispatch handler + fold class
// exercise the `esEventRecordClass(wf, ownerOf)` owner-resolution path — the
// aggregate repos alone run per-context and can't regress it.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
system MC {
  subdomain S {
    context Alpha {
      aggregate Note persistedAs(eventLog) {
        text: string
        create make() { emit Wrote { note: id } }
        apply(e: Wrote) { text := "" }
      }
      repository Notes for Note { }
      event Wrote { note: Note id }
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
  resource alphaLog { for: Alpha, kind: eventLog, use: pg }
  resource betaLog { for: Beta, kind: eventLog, use: pg }
  deployable api { platform: dotnet contexts: [Alpha, Beta] serves: A dataSources: [alphaLog, betaLog] port: 8080 }
}`;

describe("multi-context event-log naming (.NET, two event-sourced contexts)", () => {
  it("emits a distinct <Ctx>EventRecord entity + <Ctx>Events DbSet per context", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    const has = (suffix: string): boolean => keys.some((k) => k.endsWith(suffix));
    const get = (suffix: string): string =>
      [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

    // A distinct POCO per context — NOT one shared `EventRecord.cs`.
    expect(has("Infrastructure/Persistence/Events/AlphaEventRecord.cs")).toBe(true);
    expect(has("Infrastructure/Persistence/Events/BetaEventRecord.cs")).toBe(true);
    expect(has("Infrastructure/Persistence/Events/EventRecord.cs")).toBe(false);

    // Each configuration binds a DISTINCT entity type to its own table — the two
    // never collide on one `EventRecord` (the EF last-wins trap).
    const alphaCfg = get("Configurations/AlphaEventRecordConfiguration.cs");
    const betaCfg = get("Configurations/BetaEventRecordConfiguration.cs");
    expect(alphaCfg).toContain("IEntityTypeConfiguration<AlphaEventRecord>");
    expect(alphaCfg).toContain('builder.ToTable("alpha_events", "alpha");');
    expect(betaCfg).toContain("IEntityTypeConfiguration<BetaEventRecord>");
    expect(betaCfg).toContain('builder.ToTable("beta_events", "beta");');

    // Two per-context DbSets on the AppDbContext (not one shared `Events`).
    const dbctx = get("Infrastructure/Persistence/AppDbContext.cs");
    expect(dbctx).toContain(
      "public DbSet<AlphaEventRecord> AlphaEvents => Set<AlphaEventRecord>();",
    );
    expect(dbctx).toContain("public DbSet<BetaEventRecord> BetaEvents => Set<BetaEventRecord>();");

    // Each aggregate's repository reads its own context's DbSet, stream-typed.
    const noteRepo = get("Repositories/NoteRepository.cs");
    const jobRepo = get("Repositories/JobRepository.cs");
    expect(noteRepo).toContain('_db.AlphaEvents.Where(e => e.StreamType == "Note"');
    expect(jobRepo).toContain('_db.BetaEvents.Where(e => e.StreamType == "Job"');

    // The ES workflow (Counter, in Beta) rehydrates from Beta's log — the fold
    // class + the merged-context dispatch handler resolve the OWNING context via
    // `ownerOf`, not the merged `ctx.name` (Alpha).  A regression re-types the
    // event store to `AlphaEventRecord` and mis-routes the stream.
    const counterState = get("Application/Workflows/CounterState.cs");
    expect(counterState).toContain("RowToEvent(BetaEventRecord __r)");
    expect(counterState).not.toContain("AlphaEventRecord");
    // The dispatch handler injects the event store typed on the OWNING record.
    // Scan every emitted file so the assertion is path-independent.
    const allContent = [...files.values()].join("\n");
    expect(allContent).toContain("IWorkflowEventStore<BetaEventRecord>");
    expect(allContent).not.toContain("IWorkflowEventStore<AlphaEventRecord>");
  });
});
