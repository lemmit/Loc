// ---------------------------------------------------------------------------
// User-visible text slots per walker primitive (M-T1.11, i18n).
//
// The single source of truth for "which argument of a page primitive holds
// end-user-facing text". Consumed across two layers, so it lives in `src/util`
// (pure data, no imports — safe to import upward from both):
//
//   - the language validator `loom.user-visible-concat`
//     (src/language/validators/i18n-strings.ts) — bans string `+` in these
//     slots, since concatenation can't be translated;
//   - the generator extraction pass
//     (src/generator/_walker/i18n-extract.ts) — pulls the literal in each slot
//     into the `.loom/messages.en.json` catalog.
//
// Each slot is verified against its primitive's emitter
// (src/generator/_walker/primitives/*). Listing a primitive is safe even when
// the slot is often dynamic — a non-literal slot is simply skipped by both
// consumers.
// ---------------------------------------------------------------------------

/** Where a user-visible string sits inside a primitive call. `role` is the
 *  human-readable slot label baked into the i18n catalog key. */
export type UserVisibleSlot =
  | { role: string; kind: "positional"; index: number }
  | { role: string; kind: "named"; name: string };

/** primitive name → its user-visible text slot(s). */
export const USER_VISIBLE_SLOTS: Record<string, readonly UserVisibleSlot[]> = {
  Heading: [{ role: "heading", kind: "positional", index: 0 }],
  Text: [{ role: "text", kind: "positional", index: 0 }],
  Bold: [{ role: "bold", kind: "positional", index: 0 }],
  Italic: [{ role: "italic", kind: "positional", index: 0 }],
  InlineCode: [{ role: "code", kind: "positional", index: 0 }],
  Empty: [{ role: "empty", kind: "positional", index: 0 }],
  Anchor: [{ role: "anchor", kind: "positional", index: 0 }],
  KeyValueRow: [{ role: "keyValue", kind: "positional", index: 0 }],
  Badge: [{ role: "badge", kind: "positional", index: 0 }],
  Button: [
    { role: "button", kind: "positional", index: 0 },
    { role: "buttonAria", kind: "named", name: "label" },
  ],
  Stat: [
    { role: "statLabel", kind: "positional", index: 0 },
    { role: "statValue", kind: "positional", index: 1 },
  ],
  Card: [{ role: "cardTitle", kind: "positional", index: 0 }],
  Alert: [
    { role: "alert", kind: "positional", index: 0 },
    { role: "alertTitle", kind: "named", name: "title" },
  ],
  Toolbar: [{ role: "toolbarAria", kind: "named", name: "label" }],
  Divider: [{ role: "dividerLabel", kind: "named", name: "label" }],
  Modal: [{ role: "modalTitle", kind: "named", name: "title" }],
};
