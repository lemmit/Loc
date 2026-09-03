// ---------------------------------------------------------------------------
// Linker — identical to Langium's, minus one `console.warn`.
//
// `DefaultLinker.createLinkingError` warns on stderr when a reference is
// resolved before its document reaches `ComputedScopes`:
//
//     Attempted reference resolution before document reached ComputedScopes
//     state (file:///…/main.ddd).
//
// In a stock Langium language that IS a bug hint, which is why it is there.
// In Loom it is expected, and it is expected BY DESIGN: the macro expander
// (`src/macros/expander.ts`) runs as a `DocumentState.IndexedContent` hook —
// deliberately before scope computation, so the members it synthesises are
// in the tree the scope pass then walks.  Reading a macro argument's
// reference there is precisely "resolution before ComputedScopes", and any
// `.ddd` whose macro arguments do not all resolve prints the warning once per
// probe.  On the field-test corpus a single mistyped type (`str` for
// `string`) printed it three times ahead of the one real diagnostic.
//
// The warning is therefore noise about a decision this codebase already made,
// and it goes to stderr where it cannot be filtered by the caller.  The
// linking ERROR it accompanies is untouched — same message, same range, same
// diagnostic.  If early resolution ever does become a bug here, the failing
// reference still reports itself.
// ---------------------------------------------------------------------------

import { type AstNodeDescription, DefaultLinker, type LinkingError, type ReferenceInfo } from "langium";

export class DddLinker extends DefaultLinker {
  protected override createLinkingError(
    refInfo: ReferenceInfo,
    targetDescription?: AstNodeDescription,
  ): LinkingError {
    const referenceType = this.reflection.getReferenceType(refInfo);
    return {
      info: refInfo,
      message: `Could not resolve reference to ${referenceType} named '${refInfo.reference.$refText}'.`,
      targetDescription,
    };
  }
}
