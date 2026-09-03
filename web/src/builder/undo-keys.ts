// Pure half of the panes' Undo / Redo keyboard routing (M-T8.17 slice 2) —
// react-free so `test/playground/undo-keys.test.ts` can pin it.
//
// ⌘Z / Ctrl+Z → undo, ⌘⇧Z / Ctrl+⇧Z / Ctrl+Y → redo, but ONLY when the key
// lands somewhere that isn't a text-entry control: inside a TextInput the
// browser's own undo must win (the user is undoing their typing, not the
// last source splice).

export interface UndoKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type UndoKeyAction = "undo" | "redo" | null;

/** What a keydown means for the pane's source-level undo stack. */
export function undoKeyAction(e: UndoKeyEvent, targetIsTextEntry: boolean): UndoKeyAction {
  if (targetIsTextEntry) return null;
  if (e.altKey) return null;
  if (!(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  // Windows/Linux muscle memory: Ctrl+Y is redo.  Not ⌘Y — on macOS that is
  // the browser's history shortcut.
  if (k === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}

/** True for the DOM targets whose native undo must not be hijacked. */
export function isTextEntryTag(tagName: string, contentEditable: string | null | undefined): boolean {
  const tag = tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return contentEditable === "true" || contentEditable === "plaintext-only";
}
