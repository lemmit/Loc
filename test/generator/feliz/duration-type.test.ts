// The `duration` TYPE arm on Feliz — `typeToFs` had none, so a duration fell
// through to `string`.
//
// The VALUE side already agreed with .NET: `FS_LEAVES.duration` builds a
// `System.TimeSpan.FromMilliseconds …` and the temporal binary arms consume one
// (`DateTime.Add(TimeSpan)`).  Only the TYPE spelling disagreed — a
// duration-typed binding would be declared `string` while its initializer
// produced a `TimeSpan`, which Fable rejects.
//
// The earlier attempt at this arm was REVERTED because `typeToFs` also feeds
// `wire.ts`'s `wireFieldType`, whose Thoth decoder table (`decoderExprFor`) has
// no duration arm and falls through to `Decode.string` — so a `System.TimeSpan`
// record field would have been paired with a string decoder.  This fixes both
// halves at once: the state/expression side gets `System.TimeSpan`, and the wire
// side REJECTS a duration outright rather than pairing a TimeSpan with
// `Decode.string`.
//
// Scoping the wire side that way is safe because a duration can never BE a wire
// field: `duration` is expression-only and has no spelling in the grammar's
// `PrimitiveType` rule, so no declared property, `derived <name>: <TypeRef>`, or
// action param can be duration-typed — and `wireShape` is built from declared
// types alone.  The last case below proves that from the grammar rather than
// asserting it in prose.

import { describe, expect, it } from "vitest";
import { FS_LEAVES } from "../../../src/generator/feliz/fs-expr.js";
import { fsZeroValue, typeToFs } from "../../../src/generator/feliz/type-fs.js";
import { decoderExprFor, wireFieldType } from "../../../src/generator/feliz/wire.js";
import type { TypeIR } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/parse.js";

const DURATION: TypeIR = { kind: "primitive", name: "duration" };

describe("feliz — the `duration` type arm", () => {
  it("spells a duration `System.TimeSpan`, not `string`", () => {
    expect(typeToFs(DURATION)).toBe("System.TimeSpan");
    // The exact defect: the missing arm fell through to the `string` default.
    expect(typeToFs(DURATION)).not.toBe("string");
  });

  it("agrees with the type `FS_LEAVES.duration` actually constructs", () => {
    // The value side builds a TimeSpan; the type side must name that type, or
    // the binding does not typecheck under Fable.
    expect(FS_LEAVES.duration("days", "7")).toContain("System.TimeSpan");
    expect(FS_LEAVES.duration("days", "7")).toContain(typeToFs(DURATION));
  });

  it("carries the arm through the composite type constructors", () => {
    expect(typeToFs({ kind: "optional", inner: DURATION })).toBe("System.TimeSpan option");
    expect(typeToFs({ kind: "array", element: DURATION })).toBe("System.TimeSpan list");
  });

  it("zero-values a duration as `TimeSpan.Zero`, not the empty string", () => {
    expect(fsZeroValue(DURATION)).toBe("System.TimeSpan.Zero");
    expect(fsZeroValue(DURATION)).not.toBe('""');
  });

  it("REJECTS a duration on the wire instead of pairing TimeSpan with Decode.string", () => {
    // Both halves of the wire pair must refuse — leaving either one silent is
    // precisely how the reverted attempt emitted un-Fable-able F#.
    expect(() => wireFieldType(DURATION)).toThrow(/duration.*never reaches a wire field/);
    expect(() => decoderExprFor(DURATION)).toThrow(/duration.*never reaches a wire field/);
    // Non-duration types are untouched by the guard.
    expect(wireFieldType({ kind: "primitive", name: "datetime" })).toBe("System.DateTime");
    expect(decoderExprFor({ kind: "primitive", name: "datetime" })).toBe("Decode.datetimeUtc");
  });

  it("proves a duration can never BE a wire field — the grammar cannot spell one", async () => {
    // `wireShape` is built from DECLARED types (properties, containments, and
    // `derived <name>: <TypeRef>` — all of which name a `TypeRef`).  If the
    // grammar has no `duration` spelling, no declared type can be one.
    const sys = (fieldType: string) => `
system Dur {
  subdomain S { context Shop {
    aggregate Order {
      startAt: datetime
      span: ${fieldType}
    }
    repository Orders for Order { }
  } }
  api A from S
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
}`;
    // `duration` is not in `PrimitiveType`, so it parses as a NamedType and
    // fails to LINK — the field can never reach the wire shape.
    const bad = await parseString(sys("duration"), { validate: true });
    expect(bad.errors.join("\n")).toMatch(
      /Could not resolve reference to NamedDecl named 'duration'/,
    );
    // Control: the same position accepts a real primitive, so the failure above
    // is about `duration` specifically, not a malformed fixture.
    const good = await parseString(sys("datetime"), { validate: true });
    expect(good.errors).toEqual([]);
  });
});
