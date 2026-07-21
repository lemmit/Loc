// Flutter parity FREEZE test (proposal `flutter-parity-and-native-gates.md`,
// mission M-E) — the analogue of `test/generator/elixir/heex-parity.test.ts`.
//
// The plain parity test (`parity.test.ts`) proves the lint FINDS a marker and
// reports a clean bill for a gap-free ui.  That's necessary but not sufficient:
// it passes only because its showcase avoids the primitives/form-fields the
// Flutter target still drops, so on its own it would silently tolerate EVERY
// gap.  This test closes that hole.
//
// It generates a fixture that DELIBERATELY exercises the known-dropped
// form-fields (nested-VO sub-field, mixed value-object array, bool/enum element
// arrays) AND a standalone input primitive (`Field`), then asserts the parity
// findings equal a PINNED allowlist — each entry carrying a reason and the
// owning follow-up mission.  The discipline mirrors heex-parity /
// pipeline-layering / walker-stdlib-completeness:
//   - a NEW gap (a finding not on the list) fails CI — it must be rendered or
//     explicitly pinned with a reason,
//   - CLOSING a gap (M-B lands a real widget, so a marker disappears) ALSO fails
//     here — delete the entry, a welcome direction.
// The known gaps stay a reviewed decision, never silent drift.

import { describe, expect, it } from "vitest";
import { analyzeFlutterParity } from "../../../src/generator/flutter/parity.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// A flutter ui whose CreateForm's aggregate exercises the four form-field drop
// sites (M-A markers) and whose page hosts a standalone `Field` (the pack's
// no-renderer fallback, M-D).  Every one of these is a KNOWN gap pinned below.
const GAP_EXERCISER = `
system Par {
  api A from D
  subdomain D { context C {
    valueobject Geo { lat: decimal  lng: decimal }
    valueobject Addr { line: string  geo: Geo }
    valueobject LineItem { sku: string  active: bool }
    enum Color { red  green }
    aggregate Item {
      name: string
      addr: Addr
      lines: LineItem[]
      flags: bool[]
      colors: Color[]
    }
    repository Items for Item {}
  } }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: flutter
    api Shop: A
    page Home {
      route: "/"
      state { s: string = "" }
      body: Stack { Heading { "H", level: 1 }, Field("Name", bind: s) }
    }
    page NewItem { route: "/new" body: Stack { Heading { "New", level: 1 }, CreateForm { of: Item } } }
  }
  deployable api1 { platform: node contexts: [C] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}`;

/** The FROZEN set of Flutter parity gaps the GAP_EXERCISER fixture provokes,
 *  keyed by the exact marker message the lint reports, each with WHY it's still a
 *  gap and the mission that owns closing it.
 *
 *    M-A — the drop is now LOUD (this slice): the emitter marks it instead of
 *      silently omitting it.  The marker's presence is the reviewed decision.
 *    M-B — closing the gap means emitting a real Dart widget (standalone inputs,
 *      nested/array-of-VO sub-forms), which needs the flutter-build CI gate to
 *      validate — a separate follow-up.
 *    M-C — auth-gate parity (not exercised by this fixture; listed for the enum). */
const KNOWN_FLUTTER_GAPS: Record<string, { reason: string; mission: "M-A" | "M-B" | "M-C" }> = {
  "TODO(flutter form-field): addr.geo — nested value-object sub-field dropped (deferred, M-B)": {
    reason:
      "createInputFields flattens one VO level only; a VO nested inside a VO sub-field has no widget yet.",
    mission: "M-B",
  },
  "TODO(flutter form-field): lines — value-object array with a non-scalar sub-field dropped (deferred, M-B)":
    {
      reason:
        "the object-array row editor renders text/number cells only; a bool/enum/datetime/nested VO sub-field defers the whole array.",
      mission: "M-B",
    },
  "TODO(flutter form-field): flags — bool element array dropped (deferred, M-B)": {
    reason:
      "the scalar-array row editor renders text/number rows only; a repeatable bool (checkbox) row editor is unbuilt.",
    mission: "M-B",
  },
  "TODO(flutter form-field): colors — enum element array dropped (deferred, M-B)": {
    reason:
      "the scalar-array row editor renders text/number rows only; a repeatable enum (dropdown) row editor is unbuilt.",
    mission: "M-B",
  },
  'flutter pack: no renderer for "primitive-field"': {
    reason:
      "the flutterMaterial walking-skeleton pack ships no standalone-input renderer; a bare Field/Toggle/etc. falls back to the pack no-renderer line.",
    mission: "M-B",
  },
};

describe("flutter parity freeze (M-E)", () => {
  it("the parity findings equal the pinned known-gap allowlist", async () => {
    const files = await generateSystemFiles(GAP_EXERCISER);
    const actual = analyzeFlutterParity(files)
      .map((f) => f.message)
      .sort();
    expect(actual).toEqual(Object.keys(KNOWN_FLUTTER_GAPS).sort());
  });

  it("every pinned gap carries a non-empty reason and an owning mission", () => {
    for (const [msg, { reason, mission }] of Object.entries(KNOWN_FLUTTER_GAPS)) {
      expect(reason.trim().length, `pinned flutter gap '${msg}' needs a reason`).toBeGreaterThan(0);
      expect(["M-A", "M-B", "M-C"]).toContain(mission);
    }
  });

  it("both marker families are exercised (guard against a vacuous pass)", async () => {
    // A regression that stops emitting EITHER family (the M-A form-field TODOs or
    // the M-D pack no-renderer line) would silently shrink the finding set; assert
    // both are present so the freeze can't pass while a whole channel goes dark.
    const findings = analyzeFlutterParity(await generateSystemFiles(GAP_EXERCISER));
    expect(findings.some((f) => f.kind === "todo")).toBe(true);
    expect(findings.some((f) => f.kind === "diagnostic")).toBe(true);
  });
});
