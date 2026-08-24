// Scalar intrinsics on the Flutter (Dart) frontend — the second target drained
// (after Feliz's F# table, #2439) in the frontend-intrinsic slice of the
// frontend-expression plan.
//
// `dart-expr.ts` had `DART_LEAVES` (the expression-LEAF table: literals,
// binary/unary/ternary, list/object) but no `renderIntrinsic` arm — so a
// scalar intrinsic in a page body fell through the shared `emitExpr`'s
// `method-call` default to a VERBATIM `recv.member(args)`, which is not Dart
// (`s.toUpper()` has no such member; `String.toUpperCase()` does).
//
// Unlike Feliz, Flutter has only ONE dispatch path: `riverpod-emit.ts`'s
// `renderNotifierStmt` (the Notifier/action-body renderer) calls the SAME
// `emitExpr`/`walkBody` the page view uses — there is no second, hand-rolled
// switch to fall out of sync.  So this table needs wiring into exactly one
// seam (`flutterTarget.renderIntrinsic`) to cover both surfaces.
//
// Two properties are pinned here:
//
//   1. COVERAGE — every `INTRINSIC_SIGNATURES` row has a Dart arm.  The
//      catalogue is the source of truth, so a new row fails this test until
//      Flutter renders it, exactly as `intrinsic-completeness.test.ts` does
//      for the five backends.
//   2. THE CATALOGUE CONTRACT — the snippets are checked against the
//      contract in `src/util/intrinsics.ts`, not against Dart's own
//      defaults.  Three arms deliberately diverge: `substring` clamps where
//      Dart's `String.substring` throws (and Dart's is start+END, not
//      Loom's start+LENGTH), `round` forces away-from-zero where Dart's
//      `.round()` rounds `.5` toward +infinity, and `floor`/`ceil` use
//      `floorToDouble`/`ceilToDouble` — the bare `num` methods return `int`,
//      which would silently narrow `decimal`'s Dart representation (`double`,
//      per `dart-types.ts`).  The MONEY arms of those three route through the
//      generated `LoomMoney` runtime instead: money is the wire STRING on this
//      target (M-T1.21), so a `num` method on it would not compile at all.
//
// Dart compilation of every arm is proven by `generated-flutter-build.yml`
// (`flutter analyze` + `flutter build web`), not by this suite — a string
// table cannot prove that.

import { describe, expect, it } from "vitest";
import {
  DART_INTRINSIC_RENDERERS,
  renderDartIntrinsic,
} from "../../../src/generator/flutter/dart-expr.js";
import { usesMath } from "../../../src/generator/flutter/pack.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { INTRINSIC_SIGNATURES, intrinsicKey } from "../../../src/util/intrinsics.js";

const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;

describe("Flutter Dart intrinsic table — coverage", () => {
  it("has an arm for every catalogue row", () => {
    const missing = INTRINSIC_SIGNATURES.filter(
      (s) => !DART_INTRINSIC_RENDERERS[intrinsicKey(s.receiver, s.name)],
    ).map((s) => intrinsicKey(s.receiver, s.name));
    expect(
      missing,
      "every INTRINSIC_SIGNATURES row needs a Dart arm — otherwise the Flutter walker " +
        "falls through to a VERBATIM `recv.member(args)`, which is not Dart",
    ).toEqual([]);
  });

  it("carries no arm the catalogue does not declare", () => {
    const declared = new Set(INTRINSIC_SIGNATURES.map((s) => intrinsicKey(s.receiver, s.name)));
    expect(Object.keys(DART_INTRINSIC_RENDERERS).filter((k) => !declared.has(k))).toEqual([]);
  });
});

describe("Flutter Dart intrinsic table — the catalogue contract", () => {
  const r = (recv: string, member: string, on: string, ...args: string[]) =>
    renderDartIntrinsic(prim(on), member, recv, args);

  it("translates the ops Dart spells differently", () => {
    expect(r("s", "toUpper", "string")).toBe("(s.toUpperCase())");
    expect(r("s", "toLower", "string")).toBe("(s.toLowerCase())");
    expect(r("s", "trim", "string")).toBe("(s.trim())");
  });

  it("string ops that already coincide pass through with no wrapper needed", () => {
    expect(r("s", "startsWith", "string", "'x'")).toBe("(s.startsWith('x'))");
    expect(r("s", "endsWith", "string", "'x'")).toBe("(s.endsWith('x'))");
    expect(r("s", "contains", "string", "'x'")).toBe("(s.contains('x'))");
    expect(r("s", "split", "string", "'-'")).toBe("(s.split('-'))");
  });

  it("`replace` maps to `replaceAll` — Dart has no bare all-vs-first ambiguity", () => {
    expect(r("s", "replace", "string", "'-'", "' '")).toBe("(s.replaceAll('-', ' '))");
  });

  // Dart's `String.substring(start, [end])` takes start+END and THROWS a
  // RangeError out of range — the divergence a verbatim emission would hide.
  it("`substring` is start+LENGTH and CLAMPS instead of throwing", () => {
    const two = r("s", "substring", "string", "2", "5") ?? "";
    expect(two).toContain("s.substring(2, math.min((2) + (5), s.length))");
    expect(two, "an out-of-range start must yield '', not a RangeError").toContain(
      "2 >= s.length ? '' :",
    );
    expect(r("s", "substring", "string", "2") ?? "").toContain("s.substring(2)");
  });

  it("`abs`/`min`/`max` route through `math.*`, two-value not aggregate", () => {
    expect(r("n", "abs", "int")).toBe("(n.abs())");
    expect(r("n", "min", "int", "0")).toBe("(math.min(n, 0))");
    expect(r("n", "max", "int", "0")).toBe("(math.max(n, 0))");
  });

  it("`divTrunc` rides Dart's documented truncating-toward-zero `~/`", () => {
    expect(r("n", "divTrunc", "int", "2")).toBe("(n ~/ 2)");
  });

  it("`round` forces AWAY-FROM-ZERO — Dart's `.round()` rounds .5 toward +infinity", () => {
    expect(r("d", "round", "decimal", "2")).toContain(".sign * (((d).abs()");
    expect(r("d", "round", "decimal")).toBe("(d.sign * ((d).abs()).round())");
    // MONEY diverges: it is the wire STRING here (M-T1.21), so the mode is the
    // runtime's own BigInt rounding rather than the double sign/abs dance.
    expect(r("m", "round", "money", "2")).toBe("LoomMoney.round(m, 2)");
    expect(r("m", "round", "money")).toBe("LoomMoney.round(m)");
  });

  it("`floor`/`ceil` keep the receiver type (Dart's bare `.floor()`/`.ceil()` return `int`)", () => {
    expect(r("d", "floor", "decimal")).toBe("(d.floorToDouble())");
    expect(r("d", "ceil", "decimal")).toBe("(d.ceilToDouble())");
    // `floorToDouble` on a money value would not even compile — a Dart `String`
    // has no such method — and the runtime arm keeps the money TYPE (a
    // whole-valued money string), which is the catalogue contract.
    expect(r("m", "floor", "money")).toBe("LoomMoney.floor(m)");
    expect(r("m", "ceil", "money")).toBe("LoomMoney.ceil(m)");
  });

  // `DateTime(y, m, d)` builds a LOCAL-time value even off UTC field reads;
  // `DateTime.utc(...)` is required to stamp the Kind, mirroring the JS
  // (`getUTC*`) and F# (`ToUniversalTime()`) tables' defensive UTC read.
  it("`startOfDay` normalizes to UTC via `DateTime.utc(...)`, not the plain constructor", () => {
    const s = r("t", "startOfDay", "datetime") ?? "";
    expect(s).toContain("DateTime.utc(");
    expect(s).toContain("(t).toUtc().year");
    expect(s).not.toMatch(/^\(DateTime\(/);
  });
});

describe("Flutter Dart intrinsic table — what it declines", () => {
  it("declines a non-primitive receiver, so a collection op falls through", () => {
    const arr: TypeIR = { kind: "array", element: prim("string") } as TypeIR;
    expect(renderDartIntrinsic(arr, "contains", "xs", ["'a'"])).toBeUndefined();
  });

  it("declines a member that is not a catalogue intrinsic on this receiver", () => {
    // `contains` IS an intrinsic on `string` but not on `int` — the receiver
    // qualification is the whole reason `string.contains` (substring test) and
    // `T[].contains` (membership) never collide.
    expect(renderDartIntrinsic(prim("int"), "contains", "n", ["1"])).toBeUndefined();
    expect(renderDartIntrinsic(prim("string"), "nope", "s", [])).toBeUndefined();
  });
});

describe("usesMath — the on-demand `dart:math` import sniff", () => {
  it("fires only when the rendered source actually calls into `math.*`", () => {
    expect(usesMath("Text(state.s.trim())")).toBe(false);
    expect(usesMath("Text((math.min(state.n, 0)).toString())")).toBe(true);
  });
});
