import { describe, expect, it } from "vitest";
import {
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_SUB_PRIMITIVES,
} from "../../../src/util/walker-primitive-names.js";
import { SPECS } from "../../../web/src/builder/page/model.js";

// ---------------------------------------------------------------------------
// Page-builder ↔ walker-stdlib COMPLETENESS TRACKER.
//
// The playground's page builder is recognize-or-opaque (web/src/builder/page/
// model.ts): a body call whose name has a `SPECS` entry becomes an editable
// typed node; anything else collapses into an un-editable `Opaque` box holding
// its printed source.  That is a safe fallback, never a good one — a stdlib
// primitive without a spec is a primitive the builder cannot author or edit.
//
// The primitive vocabulary lives in `src/util/walker-primitive-names.ts` (itself
// pinned to the generator's dispatch table by
// test/language/type-system/walker-stdlib-completeness.test.ts).  This test
// pins the builder's `SPECS` against that vocabulary, so ADDING a primitive to
// the language without teaching the builder about it fails CI rather than
// silently regressing another call shape to a blob.
//
// A primitive that genuinely cannot be modelled by the SPECS mechanism (an
// exotic slot shape the positional/named/namedChildren vocabulary can't
// express) is pinned below WITH A REASON instead — same discipline as
// test/generator/elixir/heex-parity.test.ts's KNOWN_HEEX_GAPS.
// ---------------------------------------------------------------------------

/** Stdlib primitives deliberately left without a builder spec, each with WHY.
 *  FROZEN — see the header.  Empty today: every walker primitive is modelled. */
const UNMODELLED_PRIMITIVES: Record<string, string> = {};

const STDLIB = [...WALKER_LAYOUT_PRIMITIVES, ...WALKER_SUB_PRIMITIVES].sort();

describe("page-builder spec completeness", () => {
  it("covers every walker-stdlib primitive (minus the pinned exceptions)", () => {
    const missing = STDLIB.filter((n) => !(n in SPECS) && !(n in UNMODELLED_PRIMITIVES));
    expect(missing, "walker primitives with no page-builder spec").toEqual([]);
  });

  it("every pinned exception is a real stdlib primitive with a rationale", () => {
    for (const [name, why] of Object.entries(UNMODELLED_PRIMITIVES)) {
      expect(STDLIB, `pinned exception '${name}' is not a stdlib primitive`).toContain(name);
      expect(why.trim().length, `pinned exception '${name}' needs a reason`).toBeGreaterThan(0);
      expect(name in SPECS, `pinned exception '${name}' actually has a spec`).toBe(false);
    }
  });

  it("declares no spec for a name the language doesn't know", () => {
    // The reverse edge: a spec for a non-primitive would emit a call the
    // validator rejects as an unresolved builder type.
    const unknown = Object.keys(SPECS).filter((n) => !STDLIB.includes(n));
    expect(unknown, "page-builder specs with no walker primitive").toEqual([]);
  });

  it("guards against a vacuous pass (the stdlib is non-trivial)", () => {
    expect(STDLIB.length).toBeGreaterThan(50);
  });
});
