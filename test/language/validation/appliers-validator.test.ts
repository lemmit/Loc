import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// AST-level (LSP) mirror of the event-sourcing body discipline.  The IR
// validator (`validateEventSourcedDiscipline`) runs at `generate` time and
// in the playground; this Langium-side check surfaces the same contract
// live in the editor, attached to the precise offending node.  See
// `src/language/validators/structural.ts` and `docs/proposals/
// workflow-and-applier.md`.
// ---------------------------------------------------------------------------

/** A single-context fixture with an event and one aggregate.  `header`
 *  toggles event-sourcing; `command` / `appliers` are spliced into the
 *  aggregate body so each case perturbs one thing. */
function ctx(opts: { eventSourced?: boolean; command?: string; appliers?: string }): string {
  const header = opts.eventSourced ? " persistedAs(eventLog)" : "";
  const command = opts.command ?? `operation bump(by: int) { emit Bumped { counter: id, by: by } }`;
  const appliers = opts.appliers ?? "";
  return `
    context Core {
      event Bumped { counter: Counter id, by: int }
      aggregate Counter${header} {
        total: int
        ${command}
        ${appliers}
      }
    }
  `;
}

describe("validator: event-sourcing discipline (AST/LSP)", () => {
  it("accepts an event-sourced aggregate with emit-only command + matching applier", async () => {
    const { errors } = await parseString(
      ctx({ eventSourced: true, appliers: `apply(e: Bumped) { total += e.by }` }),
    );
    expect(errors).toEqual([]);
  });

  it("flags an applier on a non-event-sourced aggregate", async () => {
    const { errors } = await parseString(ctx({ appliers: `apply(e: Bumped) { total += e.by }` }));
    expect(errors.some((e) => /not event-sourced/.test(e))).toBe(true);
  });

  it("flags direct mutation in an event-sourced command body", async () => {
    const { errors } = await parseString(
      ctx({
        eventSourced: true,
        command: `operation bump(by: int) {
          total += by
          emit Bumped { counter: id, by: by }
        }`,
        appliers: `apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errors.some((e) => /must not mutate 'this' directly/.test(e))).toBe(true);
  });

  it("flags an emitted event with no matching applier", async () => {
    const { errors } = await parseString(ctx({ eventSourced: true }));
    expect(errors.some((e) => /no applier folds it/.test(e))).toBe(true);
  });

  it("flags an emit inside an applier body", async () => {
    const { errors } = await parseString(
      ctx({
        eventSourced: true,
        appliers: `apply(e: Bumped) {
          total += e.by
          emit Bumped { counter: id, by: e.by }
        }`,
      }),
    );
    expect(errors.some((e) => /must not emit/.test(e))).toBe(true);
  });

  it("flags a precondition inside an applier body", async () => {
    const { errors } = await parseString(
      ctx({
        eventSourced: true,
        appliers: `apply(e: Bumped) {
          precondition e.by > 0
          total += e.by
        }`,
      }),
    );
    expect(errors.some((e) => /must not guard/.test(e))).toBe(true);
  });

  it("flags two appliers for the same event", async () => {
    const { errors } = await parseString(
      ctx({
        eventSourced: true,
        appliers: `apply(e: Bumped) { total += e.by }
                   apply(e: Bumped) { total += e.by }`,
      }),
    );
    expect(errors.some((e) => /more than one applier for event/.test(e))).toBe(true);
  });
});
