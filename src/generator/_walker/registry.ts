// ---------------------------------------------------------------------------
// Walker primitive registry — typed dispatch table consumed by both
// per-platform walkers (src/generator/react/body-walker.ts for TSX,
// src/generator/elixir/heex-walker.ts for HEEx).
//
// One entry per closed-primitive-library name (`Stack`, `Heading`,
// `Button`, …).  The entry carries:
//
//   - `group`              : layout / sub — drives the language-side
//                            admissibility sets in
//                            src/language/walker-stdlib.ts.
//   - `admissibleInSource` : whether the validator accepts the name
//                            as a v2 `BuilderCall` type without it
//                            resolving to a user-declared type.
//   - `tsx`                : renderer for the React/TSX target, or
//                            undefined if the TSX walker doesn't
//                            handle this primitive directly (Action /
//                            user-component / helper / fallthrough).
//   - `heex`               : renderer for the Phoenix/HEEx target,
//                            or undefined if HEEx doesn't support
//                            the primitive (Phoenix supports a
//                            subset — Field/Toggle/Money/Avatar/etc.
//                            currently fall through with a visible
//                            comment in generated output).
//
// Before this registry existed, both walkers hand-coded a `switch`
// over primitive names and the language-side stdlib mirrored them
// with three `ReadonlySet<string>` exports — three sources of truth
// kept in sync by code review.  Now:
//
//   - The walkers consume `WALKER_PRIMITIVES[name].tsx?.(call, ctx,
//     depth)` (or `.heex(call, ctx)`).  No switches.
//   - The language-side stdlib's three sets are pinned to this
//     registry by `test/language/walker-stdlib-completeness.test.ts`
//     — drift surfaces as a test failure, not as a runtime gap.
//
// Adding a 34th layout primitive is now a one-file change here +
// implementing the renderer(s); the language-side set is verified
// against the registry by the completeness test, and the walkers
// pick the renderer up via this registry without code changes.
//
// Layering note: this module lives under `src/generator/` so it can
// import the per-platform renderer functions.  `src/language/` does
// NOT import this module — the language-side admissibility sets in
// walker-stdlib.ts are hand-listed and pinned via a test.  This
// preserves the one-directional rule "language/ knows nothing about
// generator/" from CLAUDE.md.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import type { WalkContext as HeexWalkContext } from "../elixir/heex-walker.js";
// Re-exported renderers from the Phoenix/HEEx walker.  Each function
// takes `(call, ctx)` and returns the HEEx fragment.
import {
  renderAction as renderActionHeex,
  renderAlert as renderAlertHeex,
  renderAnchor as renderAnchorHeex,
  renderAvatar as renderAvatarHeex,
  renderBadge as renderBadgeHeex,
  renderBold as renderBoldHeex,
  renderBreadcrumbs as renderBreadcrumbsHeex,
  renderButton as renderButtonHeex,
  renderCard as renderCardHeex,
  renderCodeBlock as renderCodeBlockHeex,
  renderContainer as renderContainerHeex,
  renderDateDisplay as renderDateDisplayHeex,
  renderDestroyForm as renderDestroyFormHeex,
  renderDivider as renderDividerHeex,
  renderEmpty as renderEmptyHeex,
  renderEnumBadge as renderEnumBadgeHeex,
  renderField as renderFieldHeex,
  renderFor as renderForHeex,
  renderForm as renderFormHeex,
  renderGrid as renderGridHeex,
  renderGroup as renderGroupHeex,
  renderHeading as renderHeadingHeex,
  renderIcon as renderIconHeex,
  renderIdLink as renderIdLinkHeex,
  renderImage as renderImageHeex,
  renderInlineCode as renderInlineCodeHeex,
  renderItalic as renderItalicHeex,
  renderKeyValueRow as renderKeyValueRowHeex,
  renderLoader as renderLoaderHeex,
  renderModal as renderModalHeex,
  renderMoney as renderMoneyHeex,
  renderMultilineField as renderMultilineFieldHeex,
  renderNumberField as renderNumberFieldHeex,
  renderPaper as renderPaperHeex,
  renderPasswordField as renderPasswordFieldHeex,
  renderQueryView as renderQueryViewHeex,
  renderSection as renderSectionHeex,
  renderSelectField as renderSelectFieldHeex,
  renderSkeleton as renderSkeletonHeex,
  renderSlot as renderSlotHeex,
  renderStack as renderStackHeex,
  renderStat as renderStatHeex,
  renderSticky as renderStickyHeex,
  renderTableColumn as renderTableColumnHeex,
  renderTable as renderTableHeex,
  renderTabs as renderTabsHeex,
  renderText as renderTextHeex,
  renderToggle as renderToggleHeex,
  renderToolbar as renderToolbarHeex,
} from "../elixir/heex-walker.js";
import type { A11yContract } from "./a11y.js";
import { emitCodeBlock } from "./primitives/code-block.js";
// Re-exported emitters from the React/TSX walker.  Each function
// takes `(call, ctx, depth)` and returns the JSX fragment.
import { emitAction, emitButton, emitIdLink, emitQueryView } from "./primitives/controls.js";
import {
  emitAlert,
  emitBadge,
  emitBreadcrumbs,
  emitDivider,
  emitPaper,
  emitSkeleton,
  emitSlot,
  emitStat,
} from "./primitives/display.js";
import { emitFor } from "./primitives/for.js";
import {
  emitCreateForm,
  emitDestroyForm,
  emitModal,
  emitOperationForm,
  emitWorkflowForm,
} from "./primitives/forms.js";
import { emitIcon } from "./primitives/icon.js";
import {
  emitField,
  emitMultilineField,
  emitNumberField,
  emitPasswordField,
  emitSelectField,
  emitToggle,
} from "./primitives/inputs.js";
import {
  emitCard,
  emitContainer,
  emitGrid,
  emitGroup,
  emitSection,
  emitStack,
  emitSticky,
  emitTabs,
  emitToolbar,
} from "./primitives/layout.js";
import { emitTable } from "./primitives/table.js";
import {
  emitAnchor,
  emitAvatar,
  emitBold,
  emitDateDisplay,
  emitEmpty,
  emitEnumBadge,
  emitHeading,
  emitImage,
  emitInlineCode,
  emitItalic,
  emitKeyValueRow,
  emitLoader,
  emitMoney,
  emitText,
} from "./primitives/text.js";
import type { WalkContext as TsxWalkContext } from "./walker-core.js";

/** Renderer signature for the React/TSX target.  Returns the
 *  rendered JSX fragment.  Reads/writes pass through `ctx` (the
 *  TSX walker's combined `WalkEnv & Sink`). */
export type TsxRenderer = (
  call: ExprIR & { kind: "call" },
  ctx: TsxWalkContext,
  depth: number,
) => string;

/** Renderer signature for the Phoenix/HEEx target.  Returns the
 *  rendered HEEx fragment.  Reads/writes pass through `ctx`. */
export type HeexRenderer = (call: ExprIR & { kind: "call" }, ctx: HeexWalkContext) => string;

/** Grouping — drives the language-side admissibility sets:
 *    layout → top-level layout / display / formatter primitives.
 *    sub    → sub-elements only valid nested inside a parent
 *             (`Tab` inside `Tabs`, `Column` inside `Table`). */
export type PrimitiveGroup = "layout" | "sub";

export interface PrimitiveDef {
  group: PrimitiveGroup;
  /** Whether the validator accepts this name as a v2 `BuilderCall`
   *  type without it resolving to a user-declared type.  Always
   *  true today — kept as an explicit flag so future "internal-only"
   *  primitives (lowered to via IR rewrites, never written by users)
   *  can opt out by setting this to false. */
  admissibleInSource: boolean;
  /** React/TSX target renderer, or undefined if the TSX walker does
   *  NOT dispatch on this primitive directly (e.g. `Tab`/`Column` only
   *  appear as children of their parent, which consumes them inline). */
  tsx?: TsxRenderer;
  /** Phoenix/HEEx target renderer, or undefined if the HEEx walker
   *  does NOT support this primitive — Phoenix supports a subset
   *  today (no Field/Toggle/Money/Avatar/etc.).  When undefined,
   *  the HEEx walker emits a visible HEEx comment marking the
   *  divergence rather than silently producing wrong markup. */
  heex?: HeexRenderer;
  /** WCAG 2.2 AA obligation this primitive's emit must clear — the
   *  single source of truth for the a11y semantics later phases render
   *  (accessibility.md).  Either `"presentational"` (no ARIA obligation)
   *  or a concrete `A11yObligation`.  REQUIRED: a new primitive without
   *  an a11y decision fails to type-check.  Phase 1 is data only — no
   *  emit consumes it yet. */
  a11y: A11yContract;
}

/** The typed dispatch table.  Single source of truth: adding a new
 *  primitive here + writing the renderer(s) is all it takes.  The
 *  language-side admissibility sets in walker-stdlib.ts are pinned
 *  to this table by test/language/walker-stdlib-completeness.test.ts. */
export const WALKER_PRIMITIVES: Record<string, PrimitiveDef> = {
  // --- Layout / surface --------------------------------------------------
  // Generic flex/grid/surface containers carry no ARIA obligation of their
  // own — their children carry the semantics.  Exceptions below (Tabs,
  // Toolbar, Breadcrumbs, Section, Card) own a role/landmark or contribute
  // to heading-level derivation.
  Stack: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitStack,
    heex: renderStackHeex,
    a11y: "presentational",
  },
  Group: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitGroup,
    heex: renderGroupHeex,
    a11y: "presentational",
  },
  Grid: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitGrid,
    heex: renderGridHeex,
    a11y: "presentational",
  },
  Container: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitContainer,
    heex: renderContainerHeex,
    a11y: "presentational",
  },
  // Composite widget: a `tablist` owning `Tab`s, arrow-key navigable.
  Tabs: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitTabs,
    heex: renderTabsHeex,
    a11y: { role: "tablist", keyboard: "arrows", owns: "Tab" },
  },
  // A `toolbar` groups controls and needs an accessible name (aria-label).
  Toolbar: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitToolbar,
    heex: renderToolbarHeex,
    a11y: { role: "toolbar", needsName: true },
  },
  Empty: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitEmpty,
    heex: renderEmptyHeex,
    a11y: "presentational",
  },
  // A card is visual grouping, not a landmark, but it increments the
  // heading-nesting depth used to derive `Heading` levels.
  Card: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitCard,
    heex: renderCardHeex,
    a11y: { nesting: true },
  },
  Paper: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitPaper,
    heex: renderPaperHeex,
    a11y: "presentational",
  },
  // A breadcrumb trail is a navigation landmark (`<nav aria-label>`).
  Breadcrumbs: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitBreadcrumbs,
    heex: renderBreadcrumbsHeex,
    a11y: { landmark: "navigation", needsName: true },
  },
  // Description-list row (`<dt>`/`<dd>`) — native semantics, no ARIA.
  KeyValueRow: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitKeyValueRow,
    heex: renderKeyValueRowHeex,
    a11y: "presentational",
  },
  // --- Phase 6 — semantic anchor target + sticky-position wrapper -------
  // HEEx renderer is intentionally absent: the Phoenix walker falls
  // through to the visible "not supported" comment.
  // A `<section>` is a region landmark (when named) and increments the
  // heading-nesting depth.
  Section: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSection,
    heex: renderSectionHeex,
    a11y: { landmark: "region", nesting: true },
  },
  Sticky: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSticky,
    heex: renderStickyHeex,
    a11y: "presentational",
  },
  // --- Inputs (TSX-only; HEEx renders inputs via Form-level dispatch) ----
  // (`Switch` is deliberately absent: docs/page-metamodel.md removed it from
  // the closed set — control-flow `Switch` is subsumed by `match`, and the
  // boolean input is `Toggle`.)
  // Every input associates a `<label>` with its control + wires
  // aria-invalid/aria-describedby to the validation error.
  Field: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitField,
    heex: renderFieldHeex,
    a11y: { labelled: "associate" },
  },
  NumberField: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitNumberField,
    heex: renderNumberFieldHeex,
    a11y: { labelled: "associate" },
  },
  PasswordField: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitPasswordField,
    heex: renderPasswordFieldHeex,
    a11y: { labelled: "associate" },
  },
  // A boolean toggle is a `switch` with an associated label.
  Toggle: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitToggle,
    heex: renderToggleHeex,
    a11y: { role: "switch", labelled: "associate" },
  },
  MultilineField: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitMultilineField,
    heex: renderMultilineFieldHeex,
    a11y: { labelled: "associate" },
  },
  SelectField: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSelectField,
    heex: renderSelectFieldHeex,
    a11y: { labelled: "associate" },
  },
  // --- Display -----------------------------------------------------------
  // A loading spinner announces busy state politely.
  Loader: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitLoader,
    heex: renderLoaderHeex,
    a11y: { role: "status", live: "polite", busy: true },
  },
  // A link needs discernible text (native `<a href>` role="link").
  Anchor: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitAnchor,
    heex: renderAnchorHeex,
    a11y: { needsName: true },
  },
  Image: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitImage,
    heex: renderImageHeex,
    a11y: { needsAlt: true },
  },
  Avatar: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitAvatar,
    heex: renderAvatarHeex,
    a11y: { needsAlt: true },
  },
  // Children passthrough — carries no semantics of its own.
  Slot: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSlot,
    heex: renderSlotHeex,
    a11y: "presentational",
  },
  // Heading level is derived from Section/Card nesting depth — never authored.
  Heading: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitHeading,
    heex: renderHeadingHeex,
    a11y: { headingLevel: "derive" },
  },
  Text: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitText,
    heex: renderTextHeex,
    a11y: "presentational",
  },
  // Inline-emphasis primitives — `<strong>`/`<em>`/`<code>` spans on
  // both targets (TSX via the design pack; HEEx via plain inline tags).
  // Native inline semantics; no ARIA obligation.
  Bold: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitBold,
    heex: renderBoldHeex,
    a11y: "presentational",
  },
  Italic: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitItalic,
    heex: renderItalicHeex,
    a11y: "presentational",
  },
  InlineCode: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitInlineCode,
    heex: renderInlineCodeHeex,
    a11y: "presentational",
  },
  // A command control — button role, accessible name, Enter/Space activation.
  Button: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitButton,
    heex: renderButtonHeex,
    a11y: { role: "button", needsName: true, keyboard: "activate" },
  },
  // A stat tile is decorative presentation of a value (proposal example).
  Stat: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitStat,
    heex: renderStatHeex,
    a11y: "presentational",
  },
  Badge: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitBadge,
    heex: renderBadgeHeex,
    a11y: "presentational",
  },
  Divider: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitDivider,
    heex: renderDividerHeex,
    a11y: { role: "separator" },
  },
  // A data table — native `<table>` semantics; Column supplies columnheaders.
  Table: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitTable,
    heex: renderTableHeex,
    a11y: { role: "table", owns: "Column" },
  },
  Money: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitMoney,
    heex: renderMoneyHeex,
    a11y: "presentational",
  },
  DateDisplay: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitDateDisplay,
    heex: renderDateDisplayHeex,
    a11y: "presentational",
  },
  EnumBadge: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitEnumBadge,
    heex: renderEnumBadgeHeex,
    a11y: "presentational",
  },
  // A link to an entity — link text derived from the entity display.
  IdLink: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitIdLink,
    heex: renderIdLinkHeex,
    a11y: { needsName: true },
  },
  // Loading placeholder — content hidden from AT (aria-busy) while pending.
  Skeleton: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSkeleton,
    heex: renderSkeletonHeex,
    a11y: { busy: true, live: "polite" },
  },
  // An alert announces assertively.
  Alert: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitAlert,
    heex: renderAlertHeex,
    a11y: { role: "alert", live: "assertive" },
  },
  QueryView: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitQueryView,
    heex: renderQueryViewHeex,
    a11y: "presentational",
  },
  // A dialog — role, aria-modal, named, focus trap + restore on close.
  Modal: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitModal,
    heex: renderModalHeex,
    a11y: { role: "dialog", modal: true, needsName: true, focus: "trap-restore" },
  },
  // --- Phase 3 — code/icon primitives ------------------------------------
  // HEEx renderer is intentionally absent: the Phoenix walker falls
  // through to the visible "not supported" comment.
  CodeBlock: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitCodeBlock,
    heex: renderCodeBlockHeex,
    a11y: "presentational",
  },
  // Decorative by default (aria-hidden inside a named control); a standalone
  // meaning-bearing icon needs a name (accessibility.md open question 1).
  Icon: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitIcon,
    heex: renderIconHeex,
    a11y: { decorativeByDefault: true },
  },
  // --- Named-leaf form variants (post-#512) ------------------------------
  // A form is a named landmark; submit success/error announce via live regions
  // (derived structure) and fields self-associate their labels.
  CreateForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitCreateForm,
    heex: renderFormHeex,
    a11y: { landmark: "form", needsName: true, live: "polite" },
  },
  OperationForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitOperationForm,
    heex: renderFormHeex,
    a11y: { landmark: "form", needsName: true, live: "polite" },
  },
  WorkflowForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitWorkflowForm,
    heex: renderFormHeex,
    a11y: { landmark: "form", needsName: true, live: "polite" },
  },
  // Confirmation-only destroy form (loom-forms.md).  HEEx renders a
  // confirm-delete `<.button>` wired to the aggregate's delete context function
  // (renderDestroyForm); the create/op/workflow form shapes use renderFormHeex.
  DestroyForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitDestroyForm,
    heex: renderDestroyFormHeex,
    a11y: { landmark: "form", needsName: true },
  },
  // --- Action primitive --------------------------------------------------
  // A command control like Button; name derived from the operation (or the
  // `label:` hint when icon-only), Enter/Space activation.
  Action: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitAction,
    heex: renderActionHeex,
    a11y: { role: "button", needsName: true, keyboard: "activate" },
  },
  // --- For-comprehension — list rendering with an item lambda.
  // TSX `.map` + keyed Fragment / Vue `v-for` / Svelte `{#each}` via
  // the target's `renderForEach` seam; HEEx `for`-comprehension block.
  // Structural repeat — the rendered items carry their own semantics.
  For: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitFor,
    heex: renderForHeex,
    a11y: "presentational",
  },
  // --- Sub-element primitives (always nested inside a parent) ----------
  // `Tab` is consumed inline by `Tabs`; `Column` by `Table`.  Validator
  // accepts them as builder-call types; the HEEx `Column` renderer is
  // wired through Table so it stays out of the top-level dispatch.
  Tab: { group: "sub", admissibleInSource: true, a11y: { role: "tab", needsName: true } },
  Column: {
    group: "sub",
    admissibleInSource: true,
    heex: renderTableColumnHeex,
    a11y: { role: "columnheader", needsName: true },
  },
};

/** True when `name` is a registered walker primitive (any group).
 *  Mirrors the old `isWalkerPrimitive` from walker-stdlib.ts but
 *  resolves through the registry so the language-side check and the
 *  generator-side dispatch can never disagree on what's admissible. */
export function isRegisteredPrimitive(name: string): boolean {
  return Object.hasOwn(WALKER_PRIMITIVES, name);
}

/** Names of every primitive in the named group, lexically sorted.
 *  Consumed by `test/language/walker-stdlib-completeness.test.ts`
 *  to pin the language-side sets against this registry. */
export function namesInGroup(group: PrimitiveGroup): string[] {
  return Object.keys(WALKER_PRIMITIVES)
    .filter(
      (k) => WALKER_PRIMITIVES[k]!.group === group && WALKER_PRIMITIVES[k]!.admissibleInSource,
    )
    .sort();
}
