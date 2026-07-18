// timerSource → Phoenix/Ecto scheduler emission (scheduling.md, M-T4.1).
//
// The Elixir sibling of `test/platform/hono-timer-scheduler.test.ts`.  Pure
// in-memory `generateSystems` (no docker, no LOOM_* env).  Asserts the emitted
// per-timer GenServer module (transaction-scoped advisory-lock single-fire,
// dispatch through the existing in-process Dispatcher, crontab vs
// Process.send_after per cadence, the tick struct), the supervision-tree wiring,
// the conditional crontab dep — and that a timer-free deployable is
// byte-identical (no scheduler artifacts at all).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const WITH_TIMERS = `
system Reaping {
  subdomain Ops {
    context Orders {
      aggregate Sweep {
        runId: string
        firedAt: datetime
      }
      event SweepTick { sweep: Sweep id, at: datetime }
      event SweepRan  { sweep: Sweep id, at: datetime }
      event HealthTick { at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun eventSourced {
        sweep: Sweep id
        firedAt: datetime
        create(t: SweepTick) by t.sweep { emit SweepRan { sweep: t.sweep, at: t.at } }
        apply(r: SweepRan) { firedAt := r.at }
      }
      repository Sweeps for Sweep { }
    }
  }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api OrdersApi from Ops
  deployable d { platform: elixir, contexts: [Orders], dataSources: [opsState], serves: OrdersApi, port: 4000 }
  timerSource sweep   { for: SweepTick, cron: "*/5 * * * *" }
  timerSource healthz { for: HealthTick, every: 15s }
}
`;

const NO_TIMERS = `
system Plain {
  subdomain Ops {
    context Orders {
      aggregate Order { status: string }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api A from Ops
  deployable d { platform: elixir, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
}
`;

const get =
  (files: Map<string, string>) =>
  (suffix: string): string =>
    [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

describe("timerSource → Phoenix/Ecto scheduler", () => {
  it("emits one GenServer per timer with single-fire, dispatch, and per-cadence drivers", async () => {
    const { model, errors } = await parseString(WITH_TIMERS);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const g = get(files);

    const sweep = g("d/lib/d/scheduler/sweep.ex");
    expect(sweep).not.toBe("");
    // A GenServer added to the supervision tree.
    expect(sweep).toContain("defmodule D.Scheduler.Sweep do");
    expect(sweep).toContain("use GenServer");
    // Single-fire via a TRANSACTION-SCOPED advisory lock (auto-released on tx
    // commit — a plain session lock + pool would leak the unlock onto a
    // different connection), keyed per timer.
    expect(sweep).toContain("pg_try_advisory_xact_lock");
    expect(sweep).toContain("D.Repo.transaction(fn ->");
    expect(sweep).toContain("@lock_key");
    // No manual session-lock unlock (the tx commit releases it).
    expect(sweep).not.toContain("pg_advisory_unlock");
    // Dispatches through the existing in-process Dispatcher, inside the lock tx.
    expect(sweep).toContain("D.Orders.Dispatcher.dispatch(event)");
    // Catalog obs events (cross-backend parity).
    expect(sweep).toContain('event: "timer_fired"');
    expect(sweep).toContain('event: "timer_lock_contended"');
    expect(sweep).toContain('event: "timer_emit_failed"');
    // cron: → crontab next-occurrence; every: → bare Process.send_after.
    expect(sweep).toContain('Crontab.CronExpression.Parser.parse!("*/5 * * * *")');
    expect(sweep).toContain("Crontab.Scheduler.get_next_run_date!");
    // The tick struct: mint a fresh id per tick, stamp the fire time.
    expect(sweep).toContain("%D.Orders.Events.SweepTick{");
    expect(sweep).toContain("sweep: UUIDv7.generate()");
    expect(sweep).toContain("at: DateTime.utc_now()");

    const healthz = g("d/lib/d/scheduler/healthz.ex");
    expect(healthz).toContain("defmodule D.Scheduler.Healthz do");
    // every: → fixed-interval Process.send_after (no crontab).
    expect(healthz).toContain("Process.send_after(self(), :tick, 15000)");
    expect(healthz).not.toContain("Crontab");
  });

  it("wires each scheduler into the supervision tree and adds crontab only for a cron timer", async () => {
    const { model } = await parseString(WITH_TIMERS);
    const files = generateSystems(model).files;
    const g = get(files);

    const app = g("d/lib/d/application.ex");
    expect(app).toContain("D.Scheduler.Sweep");
    expect(app).toContain("D.Scheduler.Healthz");

    const mix = g("d/mix.exs");
    expect(mix).toContain('{:crontab, "~> 1.1"}');
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const { model } = await parseString(NO_TIMERS);
    const files = generateSystems(model).files;
    const keys = [...files.keys()];
    expect(keys.some((k) => k.includes("/scheduler/"))).toBe(false);

    const g = get(files);
    expect(g("d/mix.exs")).not.toContain("crontab");
    expect(g("d/lib/d/application.ex")).not.toContain("Scheduler");
  });
});
