// The builders' tiny inline-SVG icon set (M-T8.21 slice 3, audit M13).
//
// The visual panes used to render their row / node controls as bare unicode
// glyphs — ✎ × ↑ ↓ ƒx ⋯ ⇄ — inside buttons with no accessible name: a screen
// reader announced "button", the glyphs fell back to whatever font the OS
// had, and at 11 px `ƒx` and `×` were hard to tell from text.  The playground
// already inlines Tabler paths rather than pulling `@tabler/icons-react` for
// a couple of buttons (`preview/Preview.tsx`); this is the same idea for the
// builders, in one place.
//
// Every icon is `aria-hidden` — the NAME lives on the button as `aria-label`
// (`builder/system/ExpressionEditor.tsx`'s convention), so the icon is pure
// decoration to assistive tech and the label is what `builder-scaffold.spec`'s
// accessible-name walk checks.

import type { JSX } from "react";

interface IconProps {
  size?: number;
  /** Stroke width — Tabler's default is 2; the 12 px builders read better at 2.25. */
  strokeWidth?: number;
}

function Svg({ size = 12, strokeWidth = 2.25, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

/** Tabler `pencil` — rename / edit. */
export function IconPencil(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  );
}

/** Tabler `x` — delete / remove / close. */
export function IconX(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M18 6l-12 12" />
      <path d="M6 6l12 12" />
    </Svg>
  );
}

/** Tabler `arrow-up` — move up. */
export function IconArrowUp(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="M18 11l-6 -6" />
      <path d="M6 11l6 -6" />
    </Svg>
  );
}

/** Tabler `arrow-down` — move down. */
export function IconArrowDown(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 5v14" />
      <path d="M18 13l-6 6" />
      <path d="M6 13l6 6" />
    </Svg>
  );
}

/** Tabler `math-function` — the structured (`ƒx`) expression editor toggle. */
export function IconFx(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 10h1c1 0 1 1 2.016 3.527c.984 2.473 .984 3.473 1.984 3.473h1" />
      <path d="M13 17c1.5 0 3 -2 4 -3.5s2.5 -3.5 4 -3.5" />
      <path d="M3 19c0 1.5 .5 2 2 2s2 -.5 2 -2v-14c0 -1.5 .5 -2 2 -2s2 .5 2 2" />
      <path d="M5 12h6" />
    </Svg>
  );
}

/** Tabler `dots` — "more clauses" (the collapsed detail block). */
export function IconDots(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    </Svg>
  );
}

/** Tabler `arrows-exchange` — rebind a cross-reference (`for` / `from`). */
export function IconExchange(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 10h14l-4 -4" />
      <path d="M17 14h-14l4 4" />
    </Svg>
  );
}

/** Tabler `arrow-left` — back / up one level. */
export function IconArrowLeft(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M5 12l6 6" />
      <path d="M5 12l6 -6" />
    </Svg>
  );
}

/** The collapsed-detail toggles a model node can carry, keyed rather than
 *  stringly so the pane says WHAT the block is and the node picks the icon +
 *  label (`SystemBuilderV2Pane` used to hand the glyph itself). */
export type DetailToggleKind = "rebind" | "clauses";

export const DETAIL_TOGGLE: Record<DetailToggleKind, { label: string; Icon: (p: IconProps) => JSX.Element }> = {
  rebind: { label: "change the target", Icon: IconExchange },
  clauses: { label: "edit this member's clauses", Icon: IconDots },
};
