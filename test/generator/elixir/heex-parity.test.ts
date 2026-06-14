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
const KNOWN_HEEX_GAPS: Record<string, string> = {
  // --- DECLINED: form-input family --------------------------------------
  // In LiveView an input only exists inside `<.simple_form for={@x_form}>`
  // with a changeset + `validate`/`submit` handle_event clauses (HEEx renders
  // them via Form-level dispatch, `renderFieldInputForField`).  A *standalone*
  // input has no form/changeset to bind to, so there is no sensible per-
  // primitive HEEx renderer — they are form sub-elements on Phoenix.
  Field: "DECLINED — form sub-element; standalone input has no LiveView changeset to bind",
  NumberField: "DECLINED — form sub-element; standalone input has no LiveView changeset to bind",
  PasswordField: "DECLINED — form sub-element; standalone input has no LiveView changeset to bind",
  MultilineField: "DECLINED — form sub-element; standalone input has no LiveView changeset to bind",
  SelectField: "DECLINED — form sub-element; standalone input has no LiveView changeset to bind",
  Toggle: "DECLINED — form sub-element; standalone boolean input has no LiveView changeset to bind",
  // --- DECLINED: stateful topology --------------------------------------
  Tabs: "DECLINED — interactive tab-switching needs LiveView handle_event + an active-tab assign (stateful topology), not a markup mapping",
  // DestroyForm is also stateful, and additionally uncovered by any compile
  // gate.  A LiveView delete is a `handle_event` clause calling the Ash
  // destroy code-interface (`<Context>.destroy_<agg>!(id)`) + a
  // `push_navigate` to the aggregate's list route — and that navigation uses
  // a *compile-checked* verified route (`~p"/…"`).  No example or scaffold
  // emits DestroyForm, so `build-generated-phoenix` would NOT compile-validate
  // it; shipping the wiring blind risks a broken `~p` route that passes CI but
  // breaks for any user who writes DestroyForm.  Implementing it properly means
  // adding the handler/Ash-destroy wiring AND Phoenix example coverage — a
  // focused effort, not a markup mapping.
  DestroyForm:
    "DECLINED — stateful LiveView delete (handle_event + Ash destroy + compile-checked ~p route nav), and uncovered by any compile gate; needs handler wiring + example coverage, not a markup mapping",
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
