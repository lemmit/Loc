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
// component; Phoenix users get a "not supported" note in the generated
// template — the EEx-NATIVE `<%!-- … --%>` comment form, which is inert in both
// markup and expression position (an HTML comment there was wrapped as
// `<%= <!-- … --> %>` and syntax-errored `mix compile`; see
// `heex-unsupported-primitive.test.ts`).  That
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
 *  A DECLINED entry means this list does NOT drain to zero, and that is the
 *  intended end state — the remaining entry is a refusal with a recorded
 *  decision behind it, not unowned work.  Its reason must say WHICH: a gap
 *  whose reason reads "target X can't do this" invites a drain that then
 *  discovers the target can (that is exactly what happened to `Chart`, below).
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
  // SETTLED — not a TODO.  This reason was REWRITTEN in the DataGrid
  // re-examination; the version it replaces was partly FALSE and is quoted at
  // the bottom so the correction stays legible.
  //
  // WHAT IS TRUE.  `DataGrid` is a TanStack Table row model — multi-column
  // sort, per-column filters, column visibility, client pagination, row
  // selection — wired to each target's reactivity through the
  // `renderDataGridChild` seam, which exists precisely so those semantics are
  // SHARED rather than re-derived per target (D-DATAGRID-TARGETS).  The rule
  // that decision states is "a frontend ships DataGrid iff it can run TanStack
  // itself", and HEEx fails it for the same reason Flutter does: any other way
  // of satisfying the emitter forks the behaviour the seam was built to share.
  // Both roads a Phoenix grid could take fork it:
  //   * hand-rolled server-side — re-deriving `sortingFns.alphanumeric`, the
  //     multi-sort tie-break order, `filterFns.includesString` and TanStack's
  //     pagination edges in Elixir, against a library that keeps moving.  The
  //     emitted grid already carries ONE deliberate override of a TanStack
  //     comparator (`compareDecimal`, react/walker/data-grid-child.ts) and
  //     `data-grid.test.ts` declines to add a second precisely because it would
  //     "FORK TanStack's text/alphanumeric choice" — at ONE column.  A whole
  //     re-implementation is that, everywhere, with no shared spec.
  //   * a `phx-hook` mounting `table-core` over a `phx-update="ignore"`
  //     subtree — a JS-owned island LiveView must not patch, which forfeits the
  //     server-rendered markup every other HEEx primitive is built on
  //     (page objects, the shared chrome-i18n path, `<.input>`/`<.table>`).
  // So this is a REFUSAL, not an unported leg.  Phoenix is not silently
  // degraded either: `Table` on HEEx carries real server-driven sort +
  // pagination (M-T1.1 slice 8, `liveview-emit.ts` `loom-sort`/`loom-page`),
  // and a `DataGrid` anywhere else is a compile error, not a blank space.
  //
  // WHAT THE OLD REASON GOT WRONG, kept as the caution.  It read: "every
  // interaction would be a `handle_event` round-trip RE-QUERYING THE SERVER …
  // and needs backend support for multi-column ORDER BY, which `list/4`'s
  // single sort/dir pair does not have."  Both halves of that blocker are
  // false, and they pointed the drain at the wrong layer:
  //   * `DataGrid` drives NO server read on ANY of the five targets that ship
  //     it.  It grids the array it was handed — `getSortedRowModel` /
  //     `getFilteredRowModel` / `getPaginationRowModel` over `data: rows`, and
  //     `pageSize:` is a CLIENT page size (page-metamodel.md §9.1).  So
  //     `list/4`'s sort/dir pair is not a blocker for it; it is not even on the
  //     path.  (`list/4` really does carry one sort/dir pair —
  //     `vanilla/repository-emit.ts` — that clause was true and irrelevant.)
  //   * "re-querying" is wrong for the same reason: on LiveView those rows are
  //     ALREADY in a socket assign (`liveview-emit.ts` `renderQueryLoadBlock`),
  //     so sort/filter/visibility/paging would be `Enum.sort_by`/`Enum.filter`/
  //     `Enum.slice`/a MapSet over that assign — no DB round trip at all, and
  //     column visibility in particular touches no row model whatsoever.
  // The correct objection was never feasibility.  It is that a feasible
  // re-implementation is a FORK — which is the one thing the seam exists to
  // prevent.
  DataGrid:
    "TanStack row model — HEEx can only fork it (hand-rolled Elixir semantics, or a phx-hook island LiveView must not patch); settled per D-DATAGRID-TARGETS, use Table (server-driven sort + paging on HEEx)",
  // Chart's entry is GONE, and the reason it carried is worth keeping as a
  // caution: it read "no JS-free LiveView charting; the story is a Chart.js
  // hook".  That premise was simply false — a chart plots a grouped
  // projection's rows, which on LiveView are ALREADY in a server assign, so the
  // geometry is arithmetic and the output is inline SVG with no JS and no
  // library.  A pinned gap is a claim about the target, and this one went
  // unexamined for a whole phase because the pin made it look decided.
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
