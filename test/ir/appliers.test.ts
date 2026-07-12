// Appliers — `apply(e: Event) { … }` on an event-sourced aggregate
// (D-DOCUMENT-AXIS, Phase A1: surface + IR + event-sourcing body
// discipline; emission of the event-store / fold layer is deferred to
// Phase A2).  Covers the grammar surface, the lowered `ApplyIR`, and
// every rule of `validateEventSourcedDiscipline`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** Lower a source string and return the first aggregate of the first
 *  context (the only aggregate every fixture below declares). */
async function lowerFirstAgg(source: string) {
  const { model } = await parseString(source, { validate: false });
  const loom = lowerModel(model);
  const ctx = allContexts(loom)[0];
  return ctx.aggregates[0];
}

/** Run the IR validator and return only the event-sourcing discipline
 *  errors (keyed off the wording the validator uses). */
async function esErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter(
      (d) =>
        d.severity === "error" &&
        (d.message.includes("event-sourced") ||
          d.message.includes("apply(") ||
          d.message.includes("emits") ||
          d.message.includes("applier")),
    )
    .map((d) => d.message);
}

/** An event-sourced Counter with one command + one applier.  `extra`
 *  is spliced into the aggregate body so each test can perturb one
 *  thing (an applier, a bad statement, …). */
function counter(opts: { persistedAs?: string; command?: string; appliers?: string }): string {
  const header = opts.persistedAs ? ` persistedAs(${opts.persistedAs})` : "";
  const command =
    opts.command ??
    `operation bump(by: int) {
       emit Bumped { counter: id, by: by }
     }`;
  const appliers = opts.appliers ?? "";
  return `
system Tally {
  subdomain Core {
    context Core {
      event Bumped { counter: Counter id, by: int }
      aggregate Counter${header} {
        total: int
        ${command}
        ${appliers}
      }
    }
  }
  storage pg { type: postgres }
  resource counterLog { for: Core, kind: eventLog, use: pg }
  resource counterState { for: Core, kind: state, use: pg }
  deployable api { platform: node, contexts: [Core], dataSources: [counterLog, counterState], port: 4000 }
}
`;
}

describe("appliers — grammar + lowering", () => {
  it("parses an apply(...) member without errors", async () => {
    const { errors } = await parseString(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errors).toEqual([]);
  });

  it("lowers apply(...) into agg.appliers with event, param and body", async () => {
    const agg = await lowerFirstAgg(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(agg.appliers).toBeDefined();
    expect(agg.appliers).toHaveLength(1);
    const [applier] = agg.appliers ?? [];
    expect(applier.event).toBe("Bumped");
    expect(applier.param).toBe("e");
    expect(applier.statements).toHaveLength(1);
    expect(applier.statements[0].kind).toBe("add");
  });

  it("type-resolves member access on the event param (e.field) from the event's fields", async () => {
    // `Bumped { counter: Counter id, by: int }` — `e.by` must resolve to
    // int, and `e.counter` to an `id` ref, not the string fallback.
    const agg = await lowerFirstAgg(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) { total := e.by }`,
      }),
    );
    const [applier] = agg.appliers ?? [];
    const stmt = applier.statements[0];
    expect(stmt.kind).toBe("assign");
    // The RHS is the `e.by` member access; its resolved memberType is int.
    const value = stmt.kind === "assign" ? stmt.value : undefined;
    expect(value?.kind).toBe("member");
    if (value?.kind === "member") {
      expect(value.memberType).toEqual({ kind: "primitive", name: "int" });
      expect(value.receiverType).toEqual({ kind: "entity", name: "Bumped" });
    }
  });

  it("leaves appliers undefined when the aggregate declares none", async () => {
    const agg = await lowerFirstAgg(counter({ persistedAs: "eventLog" }));
    // The default command emits Bumped but declares no applier — the IR
    // still has no appliers array (the validator flags the gap separately).
    expect(agg.appliers).toBeUndefined();
  });
});

describe("appliers — event-sourcing discipline", () => {
  it("accepts a command that emits with a matching applier", async () => {
    const errs = await esErrors(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errs).toEqual([]);
  });

  it("rejects an applier on a non-event-sourced aggregate (rule 1)", async () => {
    const errs = await esErrors(counter({ appliers: `apply(e: Bumped) { total += e.by }` }));
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs.some((m) => m.includes("not event-sourced"))).toBe(true);
  });

  it("rejects direct mutation in an event-sourced command body (rule 2)", async () => {
    const errs = await esErrors(
      counter({
        persistedAs: "eventLog",
        command: `operation bump(by: int) {
          total += by
          emit Bumped { counter: id, by: by }
        }`,
        appliers: `apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errs.some((m) => m.includes("mutates 'this' directly"))).toBe(true);
  });

  it("rejects an emitted event with no matching applier (rule 3)", async () => {
    const errs = await esErrors(counter({ persistedAs: "eventLog" }));
    expect(errs.some((m) => m.includes("no applier folds it"))).toBe(true);
  });

  it("rejects emit inside an applier body (rule 4)", async () => {
    const errs = await esErrors(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) {
          total += e.by
          emit Bumped { counter: id, by: e.by }
        }`,
      }),
    );
    expect(errs.some((m) => m.includes("emits an event"))).toBe(true);
  });

  it("rejects a precondition inside an applier body (rule 4)", async () => {
    const errs = await esErrors(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) {
          precondition e.by > 0
          total += e.by
        }`,
      }),
    );
    expect(errs.some((m) => m.includes("precondition") || m.includes("guards"))).toBe(true);
  });

  it("rejects two appliers for the same event (rule 5)", async () => {
    const errs = await esErrors(
      counter({
        persistedAs: "eventLog",
        appliers: `apply(e: Bumped) { total += e.by }
                   apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errs.some((m) => m.includes("appliers for event"))).toBe(true);
  });
});
