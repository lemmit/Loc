// The playground's app-level keyboard shortcuts (M-T8.18, audit M14) — the
// PURE half: one keydown → one named action, react-free so
// `test/playground/hotkeys.test.ts` can pin the whole map.
//
// The rule for text entry: while the user is typing (an input, a textarea,
// Monaco's hidden textarea, a contenteditable) the app owns ONLY the keys the
// editor has no business with — ⌘↵ / ⌘⇧↵ (run stages), F8 / ⇧F8 (problems),
// Esc (close overlays).  `?` and ⌘K are ignored there: `?` is a character the
// user may be typing, and inside Monaco ⌘K is a chord prefix (⌘K ⌘C comments
// a line).  The React half (`installHotkeys` in `App.tsx`) reads the target
// and hands the verdict here.

export interface HotkeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type HotkeyAction =
  | "generate"
  | "bundle-boot"
  | "next-problem"
  | "previous-problem"
  | "palette"
  | "shortcuts"
  | "escape";

/** True when the key lands in a text-entry control — the same predicate the
 *  panes' undo routing uses (`builder/undo-keys.ts`), restated here so this
 *  module does not import from `builder/` (M-T8.21 owns that tree). */
export function isTextEntry(tagName: string, contentEditable: string | null | undefined): boolean {
  const tag = tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return contentEditable === "true" || contentEditable === "plaintext-only";
}

/** What a keydown means at the app level, or `null` when the app should
 *  leave it alone (the browser, Monaco or a focused control gets it). */
export function hotkeyAction(e: HotkeyEvent, targetIsTextEntry: boolean): HotkeyAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") return "escape";
  if (e.key === "F8" && !mod && !e.altKey) return e.shiftKey ? "previous-problem" : "next-problem";
  if (e.key === "Enter" && mod && !e.altKey) return e.shiftKey ? "bundle-boot" : "generate";
  if (targetIsTextEntry) return null;
  if (e.key.toLowerCase() === "k" && mod && !e.shiftKey && !e.altKey) return "palette";
  if (e.key === "?" && !mod && !e.altKey) return "shortcuts";
  return null;
}

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** Platform spelling of the modifier — for the shortcut sheet and the
 *  palette's right-hand hints. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl+";

/** Every binding the shortcut sheet lists, in display order.  The two
 *  editor-owned notes (Tab, undo) are prose on the sheet, not rows. */
export const SHORTCUT_ROWS: readonly { keys: string; action: HotkeyAction | "undo" | "redo"; label: string }[] = [
  { keys: `${MOD_LABEL}K`, action: "palette", label: "Command palette" },
  { keys: `${MOD_LABEL}↵`, action: "generate", label: "Generate" },
  { keys: `${MOD_LABEL}⇧↵`, action: "bundle-boot", label: "Bundle, then Boot (Run on mobile)" },
  { keys: "F8", action: "next-problem", label: "Next problem" },
  { keys: "⇧F8", action: "previous-problem", label: "Previous problem" },
  { keys: `${MOD_LABEL}Z`, action: "undo", label: "Undo (also from the visual panes)" },
  { keys: IS_MAC ? "⌘⇧Z" : "Ctrl+⇧Z / Ctrl+Y", action: "redo", label: "Redo" },
  { keys: "Esc", action: "escape", label: "Close the palette, sheet or first-run card" },
  { keys: "?", action: "shortcuts", label: "This sheet (outside inputs)" },
];
