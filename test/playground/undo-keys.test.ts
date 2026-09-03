import { describe, expect, it } from "vitest";
import { isTextEntryTag, undoKeyAction } from "../../web/src/builder/undo-keys.js";

// The panes' ⌘Z / ⌘⇧Z routing (M-T8.17 slice 2).  The React half only calls
// these two; what is pinned here is that text controls keep their native
// undo and that the three platform spellings of redo all resolve.

const key = (
  k: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("undoKeyAction", () => {
  it("⌘Z / Ctrl+Z undo; ⌘⇧Z / Ctrl+⇧Z / Ctrl+Y redo", () => {
    expect(undoKeyAction(key("z", { meta: true }), false)).toBe("undo");
    expect(undoKeyAction(key("z", { ctrl: true }), false)).toBe("undo");
    expect(undoKeyAction(key("Z", { meta: true, shift: true }), false)).toBe("redo");
    expect(undoKeyAction(key("Z", { ctrl: true, shift: true }), false)).toBe("redo");
    expect(undoKeyAction(key("y", { ctrl: true }), false)).toBe("redo");
  });

  it("a bare key, an alt chord, or ⌘Y is not ours", () => {
    expect(undoKeyAction(key("z"), false)).toBeNull();
    expect(undoKeyAction(key("z", { meta: true, alt: true }), false)).toBeNull();
    expect(undoKeyAction(key("y", { meta: true }), false)).toBeNull();
    expect(undoKeyAction(key("a", { meta: true }), false)).toBeNull();
  });

  it("inside a text control the browser's own undo wins", () => {
    expect(undoKeyAction(key("z", { meta: true }), true)).toBeNull();
    expect(undoKeyAction(key("z", { meta: true, shift: true }), true)).toBeNull();
  });
});

describe("isTextEntryTag", () => {
  it("inputs, textareas, selects and contenteditable hosts are text entry", () => {
    expect(isTextEntryTag("input", null)).toBe(true);
    expect(isTextEntryTag("TEXTAREA", null)).toBe(true);
    expect(isTextEntryTag("select", null)).toBe(true);
    expect(isTextEntryTag("div", "true")).toBe(true);
    expect(isTextEntryTag("div", "plaintext-only")).toBe(true);
  });
  it("a button, a canvas node or the pane root is not", () => {
    expect(isTextEntryTag("button", null)).toBe(false);
    expect(isTextEntryTag("div", null)).toBe(false);
    expect(isTextEntryTag("div", "false")).toBe(false);
  });
});
