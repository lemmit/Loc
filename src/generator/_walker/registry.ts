// ---------------------------------------------------------------------------
// Walker primitive registry — typed dispatch table consumed by both
// per-platform walkers (src/generator/react/body-walker.ts for TSX,
// src/generator/phoenix-live-view/heex-walker.ts for HEEx).
//
// One entry per closed-primitive-library name (`Stack`, `Heading`,
// `Button`, …).  The entry carries:
//
//   - `group`              : layout / sub / scaffold — drives the
//                            language-side admissibility sets in
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

import type { ExprIR } from "../../ir/loom-ir.js";
import type { WalkContext as HeexWalkContext } from "../phoenix-live-view/heex-walker.js";
// Re-exported renderers from the Phoenix/HEEx walker.  Each function
// takes `(call, ctx)` and returns the HEEx fragment.
import {
  renderAction as renderActionHeex,
  renderAlert as renderAlertHeex,
  renderAnchor as renderAnchorHeex,
  renderBadge as renderBadgeHeex,
  renderBreadcrumbs as renderBreadcrumbsHeex,
  renderButton as renderButtonHeex,
  renderCard as renderCardHeex,
  renderContainer as renderContainerHeex,
  renderDateDisplay as renderDateDisplayHeex,
  renderEmpty as renderEmptyHeex,
  renderEnumBadge as renderEnumBadgeHeex,
  renderForm as renderFormHeex,
  renderGrid as renderGridHeex,
  renderGroup as renderGroupHeex,
  renderHeading as renderHeadingHeex,
  renderIdLink as renderIdLinkHeex,
  renderKeyValueRow as renderKeyValueRowHeex,
  renderModal as renderModalHeex,
  renderPaper as renderPaperHeex,
  renderQueryView as renderQueryViewHeex,
  renderSkeleton as renderSkeletonHeex,
  renderStack as renderStackHeex,
  renderTableColumn as renderTableColumnHeex,
  renderTable as renderTableHeex,
  renderText as renderTextHeex,
  renderToolbar as renderToolbarHeex,
} from "../phoenix-live-view/heex-walker.js";
import type { WalkContext as TsxWalkContext } from "../react/body-walker.js";
import { emitCodeBlock } from "../react/walker/primitives/code-block.js";
// Re-exported emitters from the React/TSX walker.  Each function
// takes `(call, ctx, depth)` and returns the JSX fragment.
import {
  emitAction,
  emitButton,
  emitIdLink,
  emitQueryView,
} from "../react/walker/primitives/controls.js";
import {
  emitAlert,
  emitBadge,
  emitBreadcrumbs,
  emitDivider,
  emitPaper,
  emitSkeleton,
  emitSlot,
  emitStat,
} from "../react/walker/primitives/display.js";
import {
  emitCreateForm,
  emitModal,
  emitOperationForm,
  emitWorkflowForm,
} from "../react/walker/primitives/forms.js";
import { emitIcon } from "../react/walker/primitives/icon.js";
import {
  emitField,
  emitNumberField,
  emitPasswordField,
  emitToggle,
} from "../react/walker/primitives/inputs.js";
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
} from "../react/walker/primitives/layout.js";
import { emitTable } from "../react/walker/primitives/table.js";
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
} from "../react/walker/primitives/text.js";

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

/** Grouping — drives the three language-side admissibility sets:
 *    layout   → top-level layout / display / formatter primitives.
 *    sub      → sub-elements only valid nested inside a parent
 *               (`Tab` inside `Tabs`, `Column` inside `Table`).
 *    scaffold → `scaffoldList`/`scaffoldDetails`/… expander
 *               sentinels + the singleton page sentinels (`Home`,
 *               `WorkflowsIndex`, `ViewsIndex`). */
export type PrimitiveGroup = "layout" | "sub" | "scaffold";

export interface PrimitiveDef {
  group: PrimitiveGroup;
  /** Whether the validator accepts this name as a v2 `BuilderCall`
   *  type without it resolving to a user-declared type.  Always
   *  true today — kept as an explicit flag so future "internal-only"
   *  primitives (lowered to via IR rewrites, never written by users)
   *  can opt out by setting this to false. */
  admissibleInSource: boolean;
  /** React/TSX target renderer, or undefined if the TSX walker does
   *  NOT dispatch on this primitive directly (e.g. `For` is
   *  source-admissible but unimplemented; `Tab`/`Column` only
   *  appear as children of their parent which consumes them
   *  inline). */
  tsx?: TsxRenderer;
  /** Phoenix/HEEx target renderer, or undefined if the HEEx walker
   *  does NOT support this primitive — Phoenix supports a subset
   *  today (no Field/Toggle/Money/Avatar/etc.).  When undefined,
   *  the HEEx walker emits a visible HEEx comment marking the
   *  divergence rather than silently producing wrong markup. */
  heex?: HeexRenderer;
}

/** The typed dispatch table.  Single source of truth: adding a new
 *  primitive here + writing the renderer(s) is all it takes.  The
 *  language-side admissibility sets in walker-stdlib.ts are pinned
 *  to this table by test/language/walker-stdlib-completeness.test.ts. */
export const WALKER_PRIMITIVES: Record<string, PrimitiveDef> = {
  // --- Layout / surface --------------------------------------------------
  Stack: { group: "layout", admissibleInSource: true, tsx: emitStack, heex: renderStackHeex },
  Group: { group: "layout", admissibleInSource: true, tsx: emitGroup, heex: renderGroupHeex },
  Grid: { group: "layout", admissibleInSource: true, tsx: emitGrid, heex: renderGridHeex },
  Container: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitContainer,
    heex: renderContainerHeex,
  },
  Tabs: { group: "layout", admissibleInSource: true, tsx: emitTabs },
  Toolbar: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitToolbar,
    heex: renderToolbarHeex,
  },
  Empty: { group: "layout", admissibleInSource: true, tsx: emitEmpty, heex: renderEmptyHeex },
  Card: { group: "layout", admissibleInSource: true, tsx: emitCard, heex: renderCardHeex },
  Paper: { group: "layout", admissibleInSource: true, tsx: emitPaper, heex: renderPaperHeex },
  Breadcrumbs: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitBreadcrumbs,
    heex: renderBreadcrumbsHeex,
  },
  KeyValueRow: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitKeyValueRow,
    heex: renderKeyValueRowHeex,
  },
  // --- Phase 6 — semantic anchor target + sticky-position wrapper -------
  // HEEx renderer is intentionally absent: the Phoenix walker falls
  // through to the visible "not supported" comment.
  Section: { group: "layout", admissibleInSource: true, tsx: emitSection },
  Sticky: { group: "layout", admissibleInSource: true, tsx: emitSticky },
  // --- Inputs (TSX-only; HEEx renders inputs via Form-level dispatch) ----
  Field: { group: "layout", admissibleInSource: true, tsx: emitField },
  NumberField: { group: "layout", admissibleInSource: true, tsx: emitNumberField },
  PasswordField: { group: "layout", admissibleInSource: true, tsx: emitPasswordField },
  Toggle: { group: "layout", admissibleInSource: true, tsx: emitToggle },
  // `Switch`, `MultilineField`, `SelectField` are source-admissible
  // for future extension but no renderer is wired up yet on either
  // target.  Today they fall through to "unknown layout component" —
  // that path stays unchanged.
  Switch: { group: "layout", admissibleInSource: true },
  MultilineField: { group: "layout", admissibleInSource: true },
  SelectField: { group: "layout", admissibleInSource: true },
  // --- Display -----------------------------------------------------------
  Loader: { group: "layout", admissibleInSource: true, tsx: emitLoader },
  Anchor: { group: "layout", admissibleInSource: true, tsx: emitAnchor, heex: renderAnchorHeex },
  Image: { group: "layout", admissibleInSource: true, tsx: emitImage },
  Avatar: { group: "layout", admissibleInSource: true, tsx: emitAvatar },
  Slot: { group: "layout", admissibleInSource: true, tsx: emitSlot },
  Heading: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitHeading,
    heex: renderHeadingHeex,
  },
  Text: { group: "layout", admissibleInSource: true, tsx: emitText, heex: renderTextHeex },
  // Inline-emphasis primitives — TSX only today; Phoenix/HEEx does
  // not have pack templates for these and falls through to the
  // visible "not supported" comment.
  Bold: { group: "layout", admissibleInSource: true, tsx: emitBold },
  Italic: { group: "layout", admissibleInSource: true, tsx: emitItalic },
  InlineCode: { group: "layout", admissibleInSource: true, tsx: emitInlineCode },
  Button: { group: "layout", admissibleInSource: true, tsx: emitButton, heex: renderButtonHeex },
  Stat: { group: "layout", admissibleInSource: true, tsx: emitStat },
  Badge: { group: "layout", admissibleInSource: true, tsx: emitBadge, heex: renderBadgeHeex },
  Divider: { group: "layout", admissibleInSource: true, tsx: emitDivider },
  Table: { group: "layout", admissibleInSource: true, tsx: emitTable, heex: renderTableHeex },
  Money: { group: "layout", admissibleInSource: true, tsx: emitMoney },
  DateDisplay: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitDateDisplay,
    heex: renderDateDisplayHeex,
  },
  EnumBadge: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitEnumBadge,
    heex: renderEnumBadgeHeex,
  },
  IdLink: { group: "layout", admissibleInSource: true, tsx: emitIdLink, heex: renderIdLinkHeex },
  Skeleton: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitSkeleton,
    heex: renderSkeletonHeex,
  },
  Alert: { group: "layout", admissibleInSource: true, tsx: emitAlert, heex: renderAlertHeex },
  QueryView: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitQueryView,
    heex: renderQueryViewHeex,
  },
  Modal: { group: "layout", admissibleInSource: true, tsx: emitModal, heex: renderModalHeex },
  // --- Phase 3 — code/icon primitives ------------------------------------
  // HEEx renderer is intentionally absent: the Phoenix walker falls
  // through to the visible "not supported" comment.
  CodeBlock: { group: "layout", admissibleInSource: true, tsx: emitCodeBlock },
  Icon: { group: "layout", admissibleInSource: true, tsx: emitIcon },
  // --- Named-leaf form variants (post-#512) ------------------------------
  CreateForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitCreateForm,
    heex: renderFormHeex,
  },
  OperationForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitOperationForm,
    heex: renderFormHeex,
  },
  WorkflowForm: {
    group: "layout",
    admissibleInSource: true,
    tsx: emitWorkflowForm,
    heex: renderFormHeex,
  },
  // --- Legacy archetype names (admissible, lower as `custom` page
  //     origins post-#515; no walker renderer needed) -------------------
  List: { group: "layout", admissibleInSource: true },
  Detail: { group: "layout", admissibleInSource: true },
  MasterDetail: { group: "layout", admissibleInSource: true },
  // --- Action primitive --------------------------------------------------
  Action: { group: "layout", admissibleInSource: true, tsx: emitAction, heex: renderActionHeex },
  // --- For-comprehension (source-admissible only today) -----------------
  For: { group: "layout", admissibleInSource: true },
  // --- Sub-element primitives (always nested inside a parent) ----------
  // `Tab` is consumed inline by `Tabs`; `Column` by `Table`.  Validator
  // accepts them as builder-call types; the HEEx `Column` renderer is
  // wired through Table so it stays out of the top-level dispatch.
  Tab: { group: "sub", admissibleInSource: true },
  Column: { group: "sub", admissibleInSource: true, heex: renderTableColumnHeex },
  // --- Scaffold-internal sentinels (recognised by inferPageOrigin) ----
  scaffoldList: { group: "scaffold", admissibleInSource: true },
  scaffoldDetails: { group: "scaffold", admissibleInSource: true },
  scaffoldOperations: { group: "scaffold", admissibleInSource: true },
  scaffoldNewForm: { group: "scaffold", admissibleInSource: true },
  scaffoldWorkflowForm: { group: "scaffold", admissibleInSource: true },
  scaffoldViewList: { group: "scaffold", admissibleInSource: true },
  Home: { group: "scaffold", admissibleInSource: true },
  WorkflowsIndex: { group: "scaffold", admissibleInSource: true },
  ViewsIndex: { group: "scaffold", admissibleInSource: true },
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
