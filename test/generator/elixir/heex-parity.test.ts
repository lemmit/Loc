import { describe, expect, it } from "vitest";
import { WALKER_PRIMITIVES } from "../../../src/generator/_walker/registry.js";

// ---------------------------------------------------------------------------
// React/Vue ↔ Phoenix/HEEx walker PARITY TRACKER (architecture-review finding #5).
//
// `WALKER_PRIMITIVES` (src/generator/_walker/registry.ts) is the single
// dispatch table.  Each primitive carries a `tsx` renderer — consumed by the
// shared `walkBody` engine that React, Vue and Svelte all drive — and
// optionally a `heex` renderer.  The Phoenix/HEEx engine runs a *parallel*
// recursion core (elixir/heex-walker-core.ts) because LiveView's output
// topology diverges, but it dispatches per-primitive off THIS SAME table
// (`heex-walker-core.ts`: `const def = WALKER_PRIMITIVES[name]; def.heex(...)`).
// So there is no separate HEEx primitive list to drift — coverage is
// single-source-of-truth here.
//
// The one remaining drift risk: a primitive the TSX walker renders but the
// HEEx walker does NOT (`tsx` set, `heex` undefined).  React/Vue users get the
// component; Phoenix users get a visible "not supported" HEEx comment.  That
// gap is legitimate — LiveView can't mirror every primitive — but it must be a
// DELIBERATE, reviewed choice, not a silent regression a contributor introduces
// by adding a `tsx`-only primitive and forgetting Phoenix.
//
// This test FREEZES the current gap.  Adding a new TSX-only primitive fails CI
// until the author either (a) writes the `heex` renderer, or (b) lists the name
// below with the reason Phoenix omits it.  CLOSING a gap (adding a `heex`
// renderer) also fails here — delete the entry, a welcome direction.  The same
// pinned-allowlist discipline as pipeline-layering.test.ts and
// walker-stdlib-completeness.test.ts.
// ---------------------------------------------------------------------------

/** Primitives the TSX walker renders that the HEEx walker intentionally does
 *  not, each with WHY Phoenix omits it.  FROZEN — see the header. */
const KNOWN_HEEX_GAPS: Record<string, string> = {
  // Form inputs — HEEx renders inputs through Form-level dispatch
  // (renderFormHeex builds the `<.simple_form>` fields), not as standalone
  // walker primitives, so these have no per-primitive `heex` renderer.
  Field: "input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  NumberField: "input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  PasswordField: "input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  MultilineField: "input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  SelectField: "input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  Toggle: "boolean input — rendered via HEEx Form-level dispatch, not a standalone primitive",
  // (Bold / Italic / InlineCode now have HEEx renderers — `<strong>`/`<em>`/
  //  `<code>` — so they are no longer gaps.)
  // Confirmation destroy form — renderFormHeex covers the create/op/workflow
  // shapes only; the LiveView destroy-confirm is the Elixir track's, not ported.
  DestroyForm:
    "destroy-confirm form — renderFormHeex covers create/op/workflow shapes only; not yet ported",
  // Display primitives with no HEEx renderer yet (TSX-only today).
  Loader: "loading-spinner display — no HEEx renderer yet",
  Image: "image display — no HEEx renderer yet",
  Avatar: "avatar display — no HEEx renderer yet",
  Slot: "named-slot passthrough — no HEEx equivalent wired",
  Stat: "stat/metric display — no HEEx renderer yet",
  Divider: "visual divider — no HEEx renderer yet",
  Money: "money formatter display — no standalone HEEx renderer yet",
  Tabs: "tabbed layout — no HEEx renderer; LiveView tab/navigation topology diverges from the JSX Tabs component",
};

describe("HEEx walker parity (finding #5)", () => {
  it("the TSX-rendered-without-HEEx gap matches the pinned list", () => {
    const actualGap = Object.entries(WALKER_PRIMITIVES)
      .filter(([, def]) => def.tsx !== undefined && def.heex === undefined)
      .map(([name]) => name)
      .sort();
    expect(actualGap).toEqual(Object.keys(KNOWN_HEEX_GAPS).sort());
  });

  it("every pinned gap carries a non-empty rationale", () => {
    for (const [name, why] of Object.entries(KNOWN_HEEX_GAPS)) {
      expect(why.trim().length, `pinned HEEx gap '${name}' needs a reason`).toBeGreaterThan(0);
    }
  });

  it("HEEx covers a healthy share of the primitive table (guard against vacuous pass)", () => {
    const heexCovered = Object.values(WALKER_PRIMITIVES).filter((d) => d.heex).length;
    expect(heexCovered).toBeGreaterThan(15);
  });
});
