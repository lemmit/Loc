// ---------------------------------------------------------------------------
// The `duration` expression had no walker seam.
//
// `walker-core`'s `duration` arm hardcoded the JAVASCRIPT representation — a
// bare millisecond number, `((amount) * DURATION_UNIT_MS[unit])` — for all six
// frontends.  That is right for the four JS-embedding ones (a `Date` and a
// millisecond number are both numeric-ish, exactly as the TypeScript backend
// has it), and invalid on the two whose datetime is a real datetime TYPE:
//
//   feliz    `model.Until + ((7) * 86400000)`   — `System.DateTime` has no `+ int`
//   flutter  `state.until + ((7) * 86400000)`   — Dart's `DateTime` has NO `+` at all
//
// So the fix is the same shape the BACKENDS already use — `ExprTarget.duration`
// is a per-target leaf there — plus its companion: the datetime-involving `+`/`-`
// is a METHOD on those targets (`.Add` / `.add`), which `exprBinary` cannot
// express because it only sees two strings and an operator.  Two optional
// `WalkerTarget` seams (`exprDuration`, `exprTemporalBinary`), consulted by the
// walker with today's behaviour as the fallback — so the four JS targets, which
// implement NEITHER, stay byte-for-byte what they were.
//
// The SPAN is still `DURATION_UNIT_MS` on every target: only the representation
// diverges, so `7 days` remains the same length of time everywhere.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { angularTarget } from "../../../src/generator/angular/walker/angular-target.js";
import { fsTemporalBinary } from "../../../src/generator/feliz/fs-expr.js";
import { dartTemporalBinary } from "../../../src/generator/flutter/dart-expr.js";
import { tsxTarget } from "../../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../../src/generator/vue/walker/vue-target.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { DURATION_UNIT_MS } from "../../../src/util/temporal.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** One page whose body and action both compute `until + days(7)`, hosted on
 *  `platform` with `framework` naming the ui's frontend.
 *
 *  NOTE the `= now()` seed: on Flutter that still emits the bare word `now`
 *  (the Dart twin of the Feliz `now`-literal defect, a separate open gap) — the
 *  assertions below deliberately pin only the duration/temporal fragments. */
const durationSystem = (platform: string, framework: string): string => `
system Sched {
  subdomain S {
    context Ops {
      aggregate Job { name: string }
      repository Jobs for Job { }
    }
  }
  ui Web {
    framework: ${framework}
    page Deadline {
      route: "/"
      state { until: datetime = now() }
      action push() { until := until + days(7) }
      body: Stack {
        Text { string(until + days(7)) },
        Button { "push", onClick: push }
      }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable web { platform: ${platform} targets: api ui: Web port: 3007 }
}`;

/** Concatenate every generated file so assertions stay path-agnostic. */
async function emit(platform: string, framework = platform): Promise<string> {
  const files = await generateSystemFiles(durationSystem(platform, framework));
  let all = "";
  for (const content of files.values()) all += `\n${content}`;
  return all;
}

/** The JS millisecond form the walker falls back to — what every target
 *  emitted before the seam, and what the four JS ones must still emit. */
const JS_MS_FORM = `((7) * ${DURATION_UNIT_MS.days})`;

describe("the JS frontends keep the millisecond-number form byte-for-byte", () => {
  // Structural half: the fallback is reached because NEITHER seam is
  // implemented, so no JS output can have changed shape.
  for (const [name, target] of [
    ["react", tsxTarget],
    ["vue", vueTarget],
    ["svelte", svelteTarget],
    ["angular", angularTarget],
  ] as const) {
    it(`${name} implements neither seam, so it takes the walker fallback`, () => {
      expect(target.exprDuration).toBeUndefined();
      expect(target.exprTemporalBinary).toBeUndefined();
    });
  }

  // Emission half: the exact pre-seam string, and none of the new forms.
  for (const platform of ["react", "vue", "svelte", "angular"]) {
    it(`${platform} still emits ${JS_MS_FORM}`, async () => {
      const out = await emit(platform);
      expect(out).toContain(JS_MS_FORM);
      expect(out).not.toContain("TimeSpan");
      expect(out).not.toContain("Duration(milliseconds:");
    });
  }
});

describe("feliz renders a System.TimeSpan and .Add, not DateTime + int", () => {
  const TS = `(System.TimeSpan.FromMilliseconds(float (7) * ${DURATION_UNIT_MS.days}.0))`;

  it("emits the TimeSpan on the view path and adds it to the datetime", async () => {
    const out = await emit("feliz");
    expect(out).toContain(TS);
    expect(out).toContain(`(model.Until).Add(${TS})`);
    // The defect: `System.DateTime + int` does not type-check in F#.
    expect(out).not.toContain(`model.Until + ${JS_MS_FORM}`);
    expect(out).not.toContain(JS_MS_FORM);
  });

  it("emits the SAME form on the MVU update path", async () => {
    const out = await emit("feliz");
    // `push()` assigns through `renderFsExpr`, feliz's second dispatcher — the
    // two paths must not disagree about what `days(7)` is.
    expect(out).toContain(`{ model with Until = ((model.Until).Add(${TS})) }`);
  });

  it("subtracts and commutes off the lowered type stamps", () => {
    const dt = { kind: "primitive", name: "datetime" } as const;
    const dur = { kind: "primitive", name: "duration" } as const;
    const bin = (op: "+" | "-", l: typeof dt | typeof dur, r: typeof dt | typeof dur): ExprIR => ({
      kind: "binary",
      op,
      left: { kind: "literal", lit: "int", value: "0" },
      right: { kind: "literal", lit: "int", value: "0" },
      leftType: l,
      rightType: r,
      resultType: dt,
    });
    const b = (e: ExprIR) => fsTemporalBinary("L", "R", e as Extract<ExprIR, { kind: "binary" }>);
    expect(b(bin("-", dt, dur))).toBe("((L).Subtract(R))");
    expect(b(bin("+", dur, dt))).toBe("((R).Add(L))"); // commuted — receiver is the datetime
    // `datetime - datetime` falls through: F#'s `-` on two DateTimes already
    // yields the TimeSpan a duration is.
    expect(b(bin("-", dt, dt))).toBeNull();
    // Non-temporal operands are none of this seam's business.
    expect(b(bin("+", dur, dur))).toBeNull();
  });
});

describe("flutter renders a Duration and .add, not DateTime + int", () => {
  const DUR = `Duration(milliseconds: ((7) * ${DURATION_UNIT_MS.days}))`;

  it("emits the Duration on the view path and adds it to the datetime", async () => {
    const out = await emit("flutter");
    expect(out).toContain(DUR);
    expect(out).toContain(`(state.until).add(${DUR})`);
    // The defect: Dart's `DateTime` declares no `operator +` whatsoever.  (The
    // millisecond product itself survives — it is the `Duration`'s argument,
    // which is how the span stays the one `DURATION_UNIT_MS` value.)
    expect(out).not.toContain(`state.until + ${JS_MS_FORM}`);
  });

  it("emits the SAME form in the Riverpod notifier body", async () => {
    const out = await emit("flutter");
    expect(out).toContain(`state.copyWith(until: (state.until).add(${DUR}))`);
  });

  it("subtracts, commutes, and differences off the lowered type stamps", () => {
    const dt = { kind: "primitive", name: "datetime" } as const;
    const dur = { kind: "primitive", name: "duration" } as const;
    const bin = (op: "+" | "-", l: typeof dt | typeof dur, r: typeof dt | typeof dur): ExprIR => ({
      kind: "binary",
      op,
      left: { kind: "literal", lit: "int", value: "0" },
      right: { kind: "literal", lit: "int", value: "0" },
      leftType: l,
      rightType: r,
      resultType: dt,
    });
    const b = (e: ExprIR) => dartTemporalBinary("L", "R", e as Extract<ExprIR, { kind: "binary" }>);
    expect(b(bin("-", dt, dur))).toBe("(L).subtract(R)");
    expect(b(bin("+", dur, dt))).toBe("(R).add(L)");
    // Dart has no `-` on DateTime either — `difference` is the only spelling.
    expect(b(bin("-", dt, dt))).toBe("(L).difference(R)");
    expect(b(bin("+", dur, dur))).toBeNull();
  });
});
