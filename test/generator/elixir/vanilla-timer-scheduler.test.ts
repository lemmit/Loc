// timerSource → Phoenix/Ecto scheduler emission (scheduling.md, M-T4.1).
//
// The Elixir sibling of `test/platform/hono-timer-scheduler.test.ts`.  Pure
// in-memory `generateSystems` (no docker, no LOOM_* env).  Asserts the emitted
// durable-driver split: `cron:` timers become an Oban worker (durable, unique
// single-fire, retry) plus a scheduler GenServer (crontab boundaries + a
// coalesce-once watermark catch-up); `every:` timers stay the in-process
// GenServer + transaction-scoped advisory lock; the supervision-tree wiring, the
// conditional crontab+oban deps, the Oban config + migration — and that a
// timer-free deployable is byte-identical (no scheduler artifacts at all).

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

const EVERY_ONLY = `
system Intervals {
  subdomain Ops {
    context Orders {
      aggregate Sweep {
        runId: string
        firedAt: datetime
      }
      event SweepTick { sweep: Sweep id, at: datetime }
      event SweepRan  { sweep: Sweep id, at: datetime }
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
  api A from Ops
  deployable d { platform: elixir, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
  timerSource healthz { for: SweepTick, every: 30s }
}
`;

const get =
  (files: Map<string, string>) =>
  (suffix: string): string =>
    [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1] ?? "";

async function filesFor(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  expect(errors).toEqual([]);
  return generateSystems(model).files;
}

describe("timerSource → Phoenix/Ecto scheduler", () => {
  it("makes a cron timer a DURABLE Oban worker (unique single-fire, retry)", async () => {
    const g = get(await filesFor(WITH_TIMERS));

    const worker = g("d/lib/d/scheduler/sweep_worker.ex");
    expect(worker).not.toBe("");
    expect(worker).toContain("defmodule D.Scheduler.SweepWorker do");
    expect(worker).toContain("use Oban.Worker,");
    expect(worker).toContain("max_attempts: 3"); // durable retry
    // The unique constraint IS the single-fire ledger — keyed on the boundary
    // arg, across all states so a boundary is never re-run.
    expect(worker).toContain("unique: [");
    expect(worker).toContain("keys: [:boundary]");
    expect(worker).toContain(":completed");
    // The worker builds the tick struct and dispatches through the existing
    // in-process Dispatcher.
    expect(worker).toContain("%D.Orders.Events.SweepTick{");
    expect(worker).toContain("sweep: UUIDv7.generate()");
    expect(worker).toContain("D.Orders.Dispatcher.dispatch(event)");
    expect(worker).toContain('event: "timer_fired"');
  });

  it("schedules cron boundaries + coalesce-once catch-up via a watermark", async () => {
    const g = get(await filesFor(WITH_TIMERS));

    const sweep = g("d/lib/d/scheduler/sweep.ex");
    expect(sweep).toContain("defmodule D.Scheduler.Sweep do");
    expect(sweep).toContain("use GenServer");
    // cron: → crontab next-occurrence; enqueue a durable Oban job per boundary.
    expect(sweep).toContain("Crontab.CronExpression.Parser.parse(@cron)");
    expect(sweep).toContain("Crontab.Scheduler.get_next_run_date!");
    expect(sweep).toContain("D.Scheduler.SweepWorker.new()");
    expect(sweep).toContain("|> Oban.insert()");
    // Coalesce-once missed-run catch-up over a self-owned watermark: first boot
    // baselines WITHOUT firing; a later boot past the watermark replays once.
    expect(sweep).toContain("defp catch_up(cron)");
    expect(sweep).toContain("loom_timer_runs");
    expect(sweep).toContain('event: "timer_catchup"');
    // The cron path is store-coordinated (Oban unique) — NO advisory lock.
    expect(sweep).not.toContain("pg_try_advisory_xact_lock");
  });

  it("keeps every: timers in-process (GenServer + advisory lock, no Oban)", async () => {
    const g = get(await filesFor(WITH_TIMERS));

    const healthz = g("d/lib/d/scheduler/healthz.ex");
    expect(healthz).toContain("defmodule D.Scheduler.Healthz do");
    // Single-fire via a TRANSACTION-SCOPED advisory lock, dispatch inline.
    expect(healthz).toContain("pg_try_advisory_xact_lock");
    expect(healthz).toContain("D.Repo.transaction(fn ->");
    expect(healthz).not.toContain("pg_advisory_unlock");
    // every: → fixed-interval Process.send_after (no crontab, no Oban).
    expect(healthz).toContain("Process.send_after(self(), :tick, 15000)");
    expect(healthz).not.toContain("Crontab");
    expect(healthz).not.toContain("Oban");
  });

  it("wires Oban + both schedulers into the supervision tree, config, deps, migration", async () => {
    const g = get(await filesFor(WITH_TIMERS));

    const app = g("d/lib/d/application.ex");
    // Oban leads the timer children (it must be up before the schedulers enqueue).
    expect(app).toContain("{Oban, Application.fetch_env!(:d, Oban)}");
    expect(app).toContain("D.Scheduler.Sweep");
    expect(app).toContain("D.Scheduler.Healthz");

    const mix = g("d/mix.exs");
    expect(mix).toContain('{:crontab, "~> 1.1"}');
    expect(mix).toContain('{:oban, "~> 2.19"}');

    const config = g("d/config/config.exs");
    expect(config).toContain("config :d, Oban,");
    expect(config).toContain("queues: [timers: 10]");
    expect(config).toContain("Oban.Plugins.Pruner");

    const migration = g("d/priv/repo/migrations/20000101000000_add_timer_infrastructure.exs");
    expect(migration).not.toBe("");
    expect(migration).toContain("Oban.Migration.up(version: 12)");
    expect(migration).toContain("create_if_not_exists table(:loom_timer_runs");
  });

  it("an every-only deployable pulls no Oban (in-process path only)", async () => {
    const g = get(await filesFor(EVERY_ONLY));

    const healthz = g("d/lib/d/scheduler/healthz.ex");
    expect(healthz).toContain("Process.send_after(self(), :tick, 30000)");
    expect(healthz).toContain("pg_try_advisory_xact_lock");

    // No durable-timer machinery when there is no cron timer.
    expect(g("d/mix.exs")).not.toContain("oban");
    expect(g("d/mix.exs")).not.toContain("crontab");
    expect(g("d/config/config.exs")).not.toContain("Oban");
    expect(g("d/lib/d/application.ex")).not.toContain("Oban");
    const keys = [...(await filesFor(EVERY_ONLY)).keys()];
    expect(keys.some((k) => k.includes("add_timer_infrastructure"))).toBe(false);
  });

  it("is byte-identical for a timer-free deployable (no scheduler artifacts)", async () => {
    const files = await filesFor(NO_TIMERS);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.includes("/scheduler/"))).toBe(false);

    const g = get(files);
    expect(g("d/mix.exs")).not.toContain("crontab");
    expect(g("d/mix.exs")).not.toContain("oban");
    expect(g("d/config/config.exs")).not.toContain("Oban");
    expect(g("d/lib/d/application.ex")).not.toContain("Scheduler");
  });
});
