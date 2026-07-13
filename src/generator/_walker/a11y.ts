// ---------------------------------------------------------------------------
// Per-primitive accessibility contract — the single source of truth for the
// WCAG 2.2 AA semantics each walker primitive must emit.
//
// See docs/old/proposals/accessibility.md.  The thesis: the page DSL is a closed,
// semantically-named primitive library, so every fact a correct a11y
// implementation needs (role, accessible name, keyboard pattern, heading
// level, landmark, live-region politeness) is derivable from the IR.  This
// module declares that obligation as data on each `PrimitiveDef`; later phases
// consume it (Phase 2 walker emit, Phase 3 `loom.a11y-*` validation) — Phase 1
// is data only, no emit change.
//
// A primitive is either explicitly `"presentational"` (nothing required — it
// carries no ARIA obligation, e.g. a generic flex container or a formatted-text
// span) or an `A11yObligation` object describing what the emit must clear.  The
// field is REQUIRED on `PrimitiveDef`, so adding a primitive without an a11y
// decision is a compile error — the "correct by construction, not by lint"
// rule from the proposal.  A completeness test
// (test/generator/walker/a11y-contract-completeness.test.ts) additionally pins
// the shape so a malformed contract fails CI.
// ---------------------------------------------------------------------------

/** Keyboard interaction pattern the design-pack template must honour. */
export type A11yKeyboard =
  | "activate" // Enter/Space activate the control (button-like).
  | "arrows"; // Arrow keys move within a composite widget (tablist, etc.).

/** Focus-management obligation the walker/shell must wire. */
export type A11yFocus =
  | "trap-restore" // Trap focus while open, restore to the opener on close (dialog).
  | "move"; // Move focus into this region when it appears (route → <main>/<h1>).

/** A page-structure landmark this primitive contributes.  Distinct from
 *  `role` (a widget/structure ARIA role): a landmark is a top-level
 *  navigational region a screen reader enumerates. */
export type A11yLandmark = "navigation" | "region" | "form" | "search";

/** Live-region politeness for async/status surfaces. */
export type A11yLive = "polite" | "assertive";

/** The a11y obligation a non-presentational primitive's emit must clear.
 *  Every field is optional; a primitive declares only the facts that apply.
 *  All facts are derivable from the IR except those explicitly gated by an
 *  author hint (`alt:` / `decorative` / `label:`) via `needsName`/`needsAlt`. */
export interface A11yObligation {
  /** ARIA role the primitive's root element must carry.  Omit when the
   *  design pack's native element already conveys the role (a real
   *  `<button>` needs no `role="button"`); present when the semantic element
   *  is synthetic (a `<div>`-based dialog needs `role="dialog"`). */
  role?: string;
  /** Requires a discernible accessible name.  Derived from a structural
   *  source (an operation name, link text, a field label) or the `label:`
   *  author hint; `loom.a11y-icon-only-no-name` fires when none is derivable. */
  needsName?: boolean;
  /** Requires human-authored alt text (`Image`/`Avatar`).  Satisfied by a
   *  derivable display expression, the `alt:` hint, or `decorative`
   *  (→ `alt=""`); `loom.a11y-missing-alt` fires otherwise. */
  needsAlt?: boolean;
  /** Field-label association: emit `<label for>` ↔ control `id`, plus
   *  `aria-invalid` / `aria-describedby` wiring to the validation error. */
  labelled?: "associate";
  /** Keyboard interaction pattern the pack template must honour. */
  keyboard?: A11yKeyboard;
  /** Dialog semantics — `aria-modal="true"` on the surface. */
  modal?: boolean;
  /** Focus-management obligation. */
  focus?: A11yFocus;
  /** Composite-widget child primitive this owns (e.g. `Tabs` owns `Tab`). */
  owns?: string;
  /** Live-region politeness — the surface announces async updates. */
  live?: A11yLive;
  /** Loading placeholder — content is `aria-busy` and hidden from AT while
   *  pending (`Loader` / `Skeleton`). */
  busy?: boolean;
  /** Page-structure landmark this primitive contributes. */
  landmark?: A11yLandmark;
  /** Heading whose level is DERIVED from surrounding `nesting` container
   *  depth (never a skipped level) rather than authored. */
  headingLevel?: "derive";
  /** Container that increments heading-nesting depth for the derivation
   *  above (`Section` / `Card`). */
  nesting?: boolean;
  /** Icon-family default: decorative (`aria-hidden`) when inside a named
   *  control, requiring a name only when standalone and meaning-bearing
   *  (accessibility.md open question 1 — derive-from-context, with
   *  `loom.a11y-icon-only-no-name` as the backstop). */
  decorativeByDefault?: boolean;
}

/** The a11y contract on a primitive: either the explicit "nothing required"
 *  marker or a concrete obligation. */
export type A11yContract = "presentational" | A11yObligation;
