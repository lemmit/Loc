// Scalar intrinsics on the Feliz (F#/Fable) frontend — the third leg of the
// frontend-intrinsic work, after the shared JS table (`_expr/js-intrinsics.ts`)
// and the walker-totality gate.
//
// Feliz was the loudest of the three ratcheted targets and the cheapest to fix:
// `fs-expr.ts` already carried a correct-but-PARTIAL F# mapping, wired only to
// the MVU update/action path.  The VIEW path had no intrinsic arm at all, so a
// page body fell through walker-core's `method-call` default and emitted Loom's
// own spelling verbatim — `(model.S.toUpper())`, which is not F#.
//
// Two properties are pinned here:
//
//   1. COVERAGE — every `INTRINSIC_SIGNATURES` row has an F# arm.  The
//      catalogue is the source of truth, so a new row fails this test until
//      Feliz renders it, exactly as `intrinsic-completeness.test.ts` does for
//      the five backends.
//   2. ONE TABLE, BOTH PATHS — the view path and the update path must agree.
//      Before this change they could not: one knew seven ops and threw on the
//      rest, the other knew none.  `s.replace(a, b)` must not mean one thing in
//      a page body and another in an action body.
//
// The snippets themselves are checked against the CATALOGUE CONTRACT (the
// comment block in `src/util/intrinsics.ts`), not against .NET's defaults —
// three of them deliberately diverge from what the bare .NET member does:
// `substring` clamps where .NET throws, `round` forces away-from-zero where
// .NET defaults to banker's, and `startOfDay` normalizes to UTC where `.Date`
// would truncate in the value's own Kind.
//
// Fable compilation of every arm is proven by `generated-feliz-build.yml`
// (`dotnet fable`), not by this suite — a string table cannot prove that.

import { describe, expect, it } from "vitest";
import { FS_INTRINSIC_RENDERERS, renderFsIntrinsic } from "../../../src/generator/feliz/fs-expr.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { INTRINSIC_SIGNATURES, intrinsicKey } from "../../../src/util/intrinsics.js";

const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;

describe("Feliz F# intrinsic table — coverage", () => {
  it("has an arm for every catalogue row", () => {
    const missing = INTRINSIC_SIGNATURES.filter(
      (s) => !FS_INTRINSIC_RENDERERS[intrinsicKey(s.receiver, s.name)],
    ).map((s) => intrinsicKey(s.receiver, s.name));
    expect(
      missing,
      "every INTRINSIC_SIGNATURES row needs an F# arm — otherwise the Feliz walker " +
        "falls through to a VERBATIM `recv.member(args)`, which is not F#",
    ).toEqual([]);
  });

  it("carries no arm the catalogue does not declare", () => {
    const declared = new Set(INTRINSIC_SIGNATURES.map((s) => intrinsicKey(s.receiver, s.name)));
    expect(Object.keys(FS_INTRINSIC_RENDERERS).filter((k) => !declared.has(k))).toEqual([]);
  });
});

describe("Feliz F# intrinsic table — the catalogue contract", () => {
  const r = (recv: string, member: string, on: string, ...args: string[]) =>
    renderFsIntrinsic(prim(on), member, recv, args);

  it("translates the ops .NET spells differently (the LOUD failures)", () => {
    expect(r("s", "toUpper", "string")).toBe("(s.ToUpper())");
    expect(r("s", "toLower", "string")).toBe("(s.ToLower())");
    expect(r("s", "trim", "string")).toBe("(s.Trim())");
    expect(r("n", "abs", "int")).toBe("(abs n)");
    expect(r("n", "min", "int", "0")).toBe("(min n 0)");
    expect(r("n", "max", "int", "0")).toBe("(max n 0)");
  });

  it("`replace` replaces ALL — .NET's Replace already does, unlike JS's", () => {
    expect(r("s", "replace", "string", '"-"', '" "')).toBe('(s.Replace("-", " "))');
  });

  // .NET's Substring(start, length) agrees with Loom on the ARG MEANING but
  // THROWS where Loom clamps — the divergence a verbatim emission would hide.
  it("`substring` is start+LENGTH and CLAMPS instead of throwing", () => {
    const two = r("s", "substring", "string", "2", "5") ?? "";
    expect(two).toContain("s.Substring(2, min (5) (s.Length - 2))");
    expect(two, 'an out-of-range start must yield "", not an exception').toContain(
      'if 2 >= s.Length then ""',
    );
    expect(r("s", "substring", "string", "2") ?? "").toContain("s.Substring(2)");
  });

  // A Loom `T[]` is an F# `list` on this target (`FS_LEAVES.list`, and the
  // `List.*` collection arms), so an array-returning intrinsic must materialize.
  it("`split` yields an F# list, not an array", () => {
    expect(r("s", "split", "string", '"-"')).toBe(
      '(s.Split([| "-" |], System.StringSplitOptions.None) |> List.ofArray)',
    );
  });

  it("`round` forces AWAY-FROM-ZERO — .NET defaults to banker's half-even", () => {
    expect(r("d", "round", "decimal", "2")).toContain("System.MidpointRounding.AwayFromZero");
    expect(r("d", "round", "decimal")).toContain("System.MidpointRounding.AwayFromZero");
    expect(r("m", "round", "money", "2")).toContain("System.MidpointRounding.AwayFromZero");
  });

  it("`floor`/`ceil` keep the receiver type (a whole-valued decimal, not an int)", () => {
    expect(r("d", "floor", "decimal")).toBe("(System.Math.Floor(d))");
    expect(r("d", "ceil", "decimal")).toBe("(System.Math.Ceiling(d))");
  });

  it("`divTrunc` rides F#'s natively-truncating integer division", () => {
    expect(r("n", "divTrunc", "int", "2")).toBe("(n / 2)");
  });

  // `.Date` alone truncates in the value's OWN Kind; the catalogue says the day
  // boundary is UTC on every target, in memory as well as in SQL.
  it("`startOfDay` normalizes to UTC and stamps the Kind", () => {
    const s = r("t", "startOfDay", "datetime") ?? "";
    expect(s).toContain("ToUniversalTime()");
    expect(s).toContain("System.DateTimeKind.Utc");
    // Rebuilt from the UTC-normalized Y/M/D rather than the bare `.Date`
    // property, which would truncate in whatever Kind the value carries.
    expect(s).toContain("d.Year, d.Month, d.Day, 0, 0, 0");
    expect(s).not.toBe("(t.Date)");
  });
});

describe("Feliz F# intrinsic table — what it declines", () => {
  it("declines a non-primitive receiver, so a collection op falls through", () => {
    const arr: TypeIR = { kind: "array", element: prim("string") } as TypeIR;
    expect(renderFsIntrinsic(arr, "contains", "xs", ['"a"'])).toBeUndefined();
  });

  it("declines a member that is not a catalogue intrinsic on this receiver", () => {
    // `contains` IS an intrinsic on `string` but not on `int` — the receiver
    // qualification is the whole reason `string.contains` (substring test) and
    // `T[].contains` (membership) never collide.
    expect(renderFsIntrinsic(prim("int"), "contains", "n", ["1"])).toBeUndefined();
    expect(renderFsIntrinsic(prim("string"), "nope", "s", [])).toBeUndefined();
  });
});
