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

/** Primitives the TSX walker renders that the HEEx walker does NOT, each with
 *  WHY Phoenix omits it.  FROZEN — see the header.
 *
 *  Two categories:
 *    DECLINED — a standalone HEEx renderer doesn't make sense (the primitive
 *      needs a form/changeset context or stateful LiveView wiring that only
 *      exists elsewhere).  Same class of call as the Elixir-workflow / parallel-
 *      walker declines: not a TODO, a reviewed decision.
 *    DEFERRED — implementable, but needs a dedicated change (and a Phoenix
 *      `mix compile` validation cycle), not a markup mapping.
 *
 *  (The cleanly-mappable display primitives — Bold/Italic/InlineCode, Divider/
 *  Image/Stat, Avatar/Loader, Money — now have HEEx renderers; see git history.)
 */
//
//  EMPTY — every TSX-rendered primitive now has a HEEx renderer.  The
//  standalone form-input family (Field/NumberField/PasswordField/
//  MultilineField/SelectField/Toggle) renders the app's `<.input>` with a
//  `phx-change` that writes the bound page `state` field back via a hoisted
//  `handle_event` (the LiveView analogue of a React controlled input);
//  in-form inputs still go through Form-level dispatch.  A newly-added
//  TSX-only primitive re-introduces a gap and fails this test until it gets a
//  `heex` renderer or is pinned here with a reason.
// Empty — every TSX-rendered primitive now has a HEEx renderer.  ProvenanceInfo
// (the last gap) landed a parallel HEEx `<details>` disclosure over the
// co-located `<field>_provenance` jsonb column read straight off the Ecto struct
// (M-T1.19, renderProvenanceInfo in heex-primitives.ts).
const KNOWN_HEEX_GAPS: Record<string, string> = {
  // DEFERRED — DataGrid is a TanStack-Table-backed grid (multi-column sort,
  // per-column filters, column visibility).  It is not a markup mapping: the
  // React emission is a hook-bearing CHILD COMPONENT holding client-side row
  // model state, and LiveView has no client row model — every interaction
  // would be a `handle_event` round-trip re-querying the server, which is a
  // different design (and needs backend support for multi-column ORDER BY,
  // which `list/4`'s single sort/dir pair does not have).
  //
  // Phoenix is NOT left silently degraded: `Table` on HEEx gained real
  // server-driven sort + pagination (M-T1.1 slice 8), and a `DataGrid` on a
  // non-React frontend is a compile error, not a blank space.
  DataGrid: "TanStack client row model has no LiveView analogue; use Table (server-driven on HEEx)",
  // DEFERRED — Chart (M-T1.3 Phase 4) is react + mantine@v9 only for now,
  // behind `loom.chart-unsupported-target`.  A LiveView chart is not a markup
  // mapping: HEEx has no JS-free charting option, so the Phase 5+ design is a
  // Chart.js client hook (a dedicated change with a `mix compile` validation
  // cycle), not a `primitive-chart.heex.hbs`.
  Chart:
    "no JS-free LiveView charting; the Phase 5+ story is a Chart.js hook, not a markup mapping",
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
