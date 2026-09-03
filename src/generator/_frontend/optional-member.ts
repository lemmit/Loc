import type { TypeIR } from "../../ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Optional-receiver member reads for the type-checked frontends.
//
// `p.budget.amount` where the model declares `budget: Budget?` is a NULL
// DEREFERENCE: the wire ships `budget: null` for a project that has none, so
// the read throws at runtime and — on the two frontends whose templates are
// type-checked — fails the build outright (`ng build`'s TS2531 "Object is
// possibly 'null'", svelte-check's "'…' is possibly 'null' or 'undefined'").
// The JS `?.` short-circuit is the whole fix: `p.budget?.amount` is `undefined`
// rather than a throw, and the interpolation renders empty.
//
// Supplied to `WalkerTarget.renderMemberRead`, which the shared walker consults
// before its verbatim `<recv>.<member>` emit.  Only the JS-embedded targets use
// it: Feliz spells options in F# (`Option.map`), and its own seam already owns
// that spelling.
// ---------------------------------------------------------------------------

/** Spell one member read, null-safe when the RECEIVER's declared type is
 *  optional.  Returns `undefined` for a non-optional receiver (and for a
 *  receiver whose type the IR left unresolved) so the caller falls through to
 *  the walker's verbatim emit and every non-optional read stays byte-identical. */
export function optionalChainedMemberRead(spec: {
  receiver: string;
  member: string;
  receiverType: TypeIR | undefined;
}): string | undefined {
  return spec.receiverType?.kind === "optional"
    ? `${spec.receiver}?.${spec.member}`
    : undefined;
}
