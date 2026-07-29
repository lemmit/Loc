// ---------------------------------------------------------------------------
// Stable content key for a user-facing validation message.
//
// A messaged `invariant`/`check`/`precondition` carries author-written text; the
// wire (ProblemDetails `errors[].code`) needs a STABLE, machine-readable key a
// client can localise by. Per "derive, don't stamp" the code is a pure function
// of the text — never stored on the IR, always recomputed here — so the same
// message always yields the same code and a rephrase yields a new one (matching
// D-I18N-KEY's content-hash posture for inline literals: a reword is a
// delete-old + add-new in the i18n sync diff, not a silent re-translation).
//
// Browser-safe by construction (see `content-hash.ts`, the shared primitive
// this delegates to). It is NOT cryptographic — message strings need
// collision-avoidance, not strength. The i18n mission may later formalise the
// algorithm (sha512-6 in the Node CLI); the `msg.<hash>` shape stays stable.
// ---------------------------------------------------------------------------

import { contentHash } from "./content-hash.js";

/** The stable wire `code` for a user-facing validation message string. */
export function messageCode(text: string): string {
  return `msg.${contentHash(text)}`;
}
