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
  // `Icon`'s `label:` is an ACCESSIBLE NAME, not visible text — a
  // meaning-bearing glyph opts out of decorative-by-default with it and becomes
  // a named `role="img"`.  A user-AUDIBLE string is still a user-visible slot:
  // shipping it in English at every locale is the same defect as an untranslated
  // caption, which is why `buttonAria`/`toolbarAria` are already here.
  Icon: [{ role: "iconLabel", kind: "named", name: "label" }],
  // `CodeBlock`'s `title:` captions the sample ("orders.ddd", "Request body") —
  // authored prose in text position.  The code SOURCE is deliberately not a
  // slot: it is code, and translating it would break it.
  CodeBlock: [{ role: "codeBlockTitle", kind: "named", name: "title" }],
  // The controlled inputs' first positional is the field LABEL — the most-read
  // authored prose in any form ("Email address", "Quantity").  All seven share
  // ONE role: the same caption in a `Field` and in a `Toggle` is the same
  // message, and a per-primitive role would split one translation into seven.
  Field: [{ role: "inputLabel", kind: "positional", index: 0 }],
  NumberField: [{ role: "inputLabel", kind: "positional", index: 0 }],
  PasswordField: [{ role: "inputLabel", kind: "positional", index: 0 }],
  MultilineField: [{ role: "inputLabel", kind: "positional", index: 0 }],
  SelectField: [{ role: "inputLabel", kind: "positional", index: 0 }],
  Toggle: [{ role: "inputLabel", kind: "positional", index: 0 }],
  FileUpload: [{ role: "inputLabel", kind: "positional", index: 0 }],
  // `Tab("Overview", body)` — the tab's visible caption.  The `value`/slug the
  // switcher keys on is derived from the SOURCE literal, not from this slot, so
  // translating the caption never moves the anchor.
  Tab: [{ role: "tabLabel", kind: "positional", index: 0 }],
  // `Column("Job Name", o => o.name)` — the table/grid header.  Shared by
  // `Table` and `DataGrid`, which both read `Column` calls.  The `field:`/
  // accessor (what sorting and filtering key on) is a separate arg, so a
  // translated header cannot break either.
  Column: [{ role: "columnHeader", kind: "positional", index: 0 }],
};
