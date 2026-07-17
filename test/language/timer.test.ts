// timerSource — parse + AST-level cadence validation (scheduling.md, M-T4.1).
//
// The `timerSource` declaration parses (a real `for=[EventDecl:ID]` cross-ref,
// resolved system-wide by the scope arm), and `loom.timer-cadence` fires for the
// field-presence + cron/every well-formedness cases the AST sees.  These are the
// AST-visible gates; the IR-level checks are in test/ir/timer-checks.test.ts.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { isTimerSource } from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/print-structural.js";
import { parseString } from "../_helpers/parse.js";

const VALID = `
system Reaping {
  subdomain Ops {
    context Orders {
      aggregate Sweep { runId: string }
      event SweepTick { sweep: Sweep id, at: datetime }
      event HealthTick { at: datetime }
      channel Ticks { carries: SweepTick }
      workflow SweepRun eventSourced {
        sweep: Sweep id
        create(t: SweepTick) by t.sweep { emit SweepRan { sweep: t.sweep, at: t.at } }
        apply(r: SweepRan) { sweep := r.sweep }
      }
      event SweepRan { sweep: Sweep id, at: datetime }
    }
  }
  storage pg { type: postgres }
  resource opsState { for: Orders, kind: state, use: pg }
  api A from Ops
  deployable d { platform: node, contexts: [Orders], dataSources: [opsState], serves: A, port: 4000 }
  timerSource sweep   { for: SweepTick, cron: "*/5 * * * *" }
  timerSource healthz { for: HealthTick, every: 15s }
}
`;

describe("timerSource — parse + cadence validation", () => {
  it("parses a valid cron and every timerSource with no errors", async () => {
    const { errors } = await parseString(VALID);
    expect(errors).toEqual([]);
  });

  it("resolves `for:` to a system-wide event (the scope arm)", async () => {
    const { model } = await parseString(VALID);
    const timers = [...AstUtils.streamAllContents(model)].filter(isTimerSource);
    expect(timers.map((t) => t.name)).toEqual(["sweep", "healthz"]);
    expect(timers[0].event.ref?.name).toBe("SweepTick");
    expect(timers[1].event.ref?.name).toBe("HealthTick");
  });

  it("rejects both cron and every set", async () => {
    const { errors } = await parseString(cadence(`cron: "*/5 * * * *", every: 15s`));
    expect(errors.some((e) => /sets both 'cron:' and 'every:'/.test(e))).toBe(true);
  });

  it("rejects neither cron nor every set", async () => {
    const { errors } = await parseString(cadence(``));
    expect(errors.some((e) => /sets neither 'cron:' nor 'every:'/.test(e))).toBe(true);
  });

  it("rejects an out-of-range cron field", async () => {
    const { errors } = await parseString(cadence(`cron: "*/5 * 99 * *"`));
    expect(errors.some((e) => /day-of-month must be 1-31/.test(e))).toBe(true);
  });

  it("steers a cron-expressible every back to cron", async () => {
    const { errors } = await parseString(cadence(`every: 5m`));
    expect(errors.some((e) => /cleanly cron-expressible/.test(e))).toBe(true);
  });

  it("prints the timerSource declaration back to source", async () => {
    const { model } = await parseString(VALID);
    const ts = [...AstUtils.streamAllContents(model)].filter(isTimerSource)[0];
    const printed = printStructural(ts);
    expect(printed).toContain("timerSource sweep");
    expect(printed).toContain(`for: SweepTick`);
    expect(printed).toContain(`cron: "*/5 * * * *"`);
  });
});

/** A minimal system whose single timerSource carries the given cadence clause. */
function cadence(clause: string): string {
  return `
    system S {
      subdomain M { context C {
        aggregate A { n: string }
        event Tick { at: datetime }
      }}
      storage pg { type: postgres }
      resource st { for: C, kind: state, use: pg }
      api Api from M
      deployable d { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 4000 }
      timerSource t { for: Tick${clause ? `, ${clause}` : ""} }
    }
  `;
}
