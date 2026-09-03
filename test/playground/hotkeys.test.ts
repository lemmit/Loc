import { describe, expect, it } from "vitest";
import { hotkeyAction, isTextEntry, SHORTCUT_ROWS } from "../../web/src/util/hotkeys.js";

// The app-level key → action map (M-T8.18, audit M14).  The React half only
// reads the target and calls `hotkeyAction`; what is pinned here is WHICH keys
// the app owns while the user is typing, and that the sheet lists every
// action the map can produce.

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

describe("hotkeyAction", () => {
  it("⌘↵ / Ctrl+↵ generate; ⌘⇧↵ bundles + boots — even inside the editor", () => {
    expect(hotkeyAction(key("Enter", { meta: true }), false)).toBe("generate");
    expect(hotkeyAction(key("Enter", { ctrl: true }), true)).toBe("generate");
    expect(hotkeyAction(key("Enter", { meta: true, shift: true }), true)).toBe("bundle-boot");
    expect(hotkeyAction(key("Enter", { ctrl: true, shift: true }), false)).toBe("bundle-boot");
  });

  it("F8 / ⇧F8 step problems from anywhere", () => {
    expect(hotkeyAction(key("F8"), false)).toBe("next-problem");
    expect(hotkeyAction(key("F8", { shift: true }), true)).toBe("previous-problem");
    expect(hotkeyAction(key("F8", { ctrl: true }), false)).toBeNull();
  });

  it("Esc always reaches the app (it closes overlays)", () => {
    expect(hotkeyAction(key("Escape"), false)).toBe("escape");
    expect(hotkeyAction(key("Escape"), true)).toBe("escape");
  });

  it("⌘K opens the palette and ? the sheet — only outside text entry", () => {
    expect(hotkeyAction(key("k", { meta: true }), false)).toBe("palette");
    expect(hotkeyAction(key("K", { ctrl: true }), false)).toBe("palette");
    expect(hotkeyAction(key("?"), false)).toBe("shortcuts");
    // Typing a `?` in the chat, or ⌘K inside Monaco (a chord prefix), is not ours.
    expect(hotkeyAction(key("?"), true)).toBeNull();
    expect(hotkeyAction(key("k", { meta: true }), true)).toBeNull();
    expect(hotkeyAction(key("k", { meta: true, shift: true }), false)).toBeNull();
  });

  it("a bare Enter, a bare k, or an alt chord is not ours", () => {
    expect(hotkeyAction(key("Enter"), false)).toBeNull();
    expect(hotkeyAction(key("k"), false)).toBeNull();
    expect(hotkeyAction(key("Enter", { meta: true, alt: true }), false)).toBeNull();
    expect(hotkeyAction(key("z", { meta: true }), false)).toBeNull();
  });
});

describe("isTextEntry", () => {
  it("inputs, textareas, selects and contenteditable hosts are text entry", () => {
    expect(isTextEntry("input", null)).toBe(true);
    expect(isTextEntry("TEXTAREA", null)).toBe(true);
    expect(isTextEntry("div", "true")).toBe(true);
    expect(isTextEntry("div", "plaintext-only")).toBe(true);
  });
  it("a button or the pane root is not", () => {
    expect(isTextEntry("button", null)).toBe(false);
    expect(isTextEntry("div", "false")).toBe(false);
  });
});

describe("the shortcut sheet", () => {
  it("lists every action the map can produce, plus undo / redo", () => {
    const listed = new Set(SHORTCUT_ROWS.map((r) => r.action));
    for (const a of [
      "generate",
      "bundle-boot",
      "next-problem",
      "previous-problem",
      "palette",
      "shortcuts",
      "escape",
      "undo",
      "redo",
    ]) {
      expect(listed.has(a as never), `sheet lists ${a}`).toBe(true);
    }
  });
});
