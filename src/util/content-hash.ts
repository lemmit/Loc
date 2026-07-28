// ---------------------------------------------------------------------------
// Stable content hash for i18n keys and validation-message codes.
//
// A single hash primitive shared by the whole i18n key family — the
// validation-message wire `code` (`src/util/message-code.ts`) and the
// user-visible-string catalog keys (`src/generator/_walker/i18n-extract.ts`).
// Keeping them on one function means the shape and stability story stay
// identical everywhere: the same source text always yields the same 6-char
// hash, and any rephrase yields a new one (D-I18N-KEY's content-hash posture
// for inline literals — a reword is a delete-old + add-new in the `ddd i18n
// sync` diff, never a silent re-translation).
//
// Browser-safe by construction: the generators run in the playground, so this
// uses a pure-JS FNV-1a hash (no `node:crypto`). It is NOT cryptographic —
// content strings need collision-avoidance, not strength. The i18n mission may
// later formalise the algorithm (sha512-6 in the Node CLI, matching FormatJS's
// default extractor); the 6-char shape stays stable across that change.
// ---------------------------------------------------------------------------

/** A stable 6-char FNV-1a content hash (lowercase base-36) of `text`. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}
