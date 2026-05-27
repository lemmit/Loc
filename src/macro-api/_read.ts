// Typed AST-node read accessors for the macro-api — the read-side
// mirror of `_mk.ts`'s write-side `mk<>` builders.
//
// Langium's generated AST union types (`MacroArg.value: MacroArgValue
// = MacroArgBool | MacroArgInt | MacroArgRef | MacroArgRefList |
// MacroArgString`) carry a `$type` discriminator literal on each
// variant, but TypeScript does NOT narrow the union via a plain
// `v.$type === "..."` check the way an ergonomic discriminated union
// would.  In practice each access through `.string` / `.bool` / `.int`
// / `.ref` / `.refs` needs an inline cast.
//
// Rather than scatter `(v as any).<field>` reads across the macro
// expander and the structural printer, we funnel every MacroArgValue
// read through a tiny set of typed accessors here.  Each accessor
// type-checks the `$type` once and returns the payload as a real
// TypeScript value — the one structural cast lives in this file.
//
// Importers: `src/language/ddd-macro-expander.ts` and
// `src/language/print/print-structural.ts`.

import type {
  MacroArgBool,
  MacroArgInt,
  MacroArgRef,
  MacroArgRefList,
  MacroArgString,
  MacroArgValue,
} from "../language/generated/ast.js";

/** Read the string payload of a `MacroArgString`, or `undefined` if
 *  `v` is some other variant. */
export function readArgString(v: MacroArgValue): string | undefined {
  return v.$type === "MacroArgString" ? (v as MacroArgString).string : undefined;
}

/** Read the boolean payload of a `MacroArgBool`, or `undefined` if
 *  `v` is some other variant.  The underlying grammar field is
 *  the literal `"true" | "false"`; the accessor returns a real
 *  `boolean`. */
export function readArgBool(v: MacroArgValue): boolean | undefined {
  if (v.$type !== "MacroArgBool") return undefined;
  return (v as MacroArgBool).bool === "true";
}

/** The literal `"true" | "false"` payload of a `MacroArgBool`, or
 *  `undefined` if `v` is some other variant.  Useful for the
 *  structural printer which round-trips the source token. */
export function readArgBoolLiteral(v: MacroArgValue): "true" | "false" | undefined {
  return v.$type === "MacroArgBool" ? (v as MacroArgBool).bool : undefined;
}

/** Read the integer payload of a `MacroArgInt`, or `undefined` if
 *  `v` is some other variant.  The Langium `INT` terminal `returns
 *  number`, so the field is already a real number. */
export function readArgInt(v: MacroArgValue): number | undefined {
  return v.$type === "MacroArgInt" ? (v as MacroArgInt).int : undefined;
}

/** Read the ref-text payload of a `MacroArgRef`, or `undefined` if
 *  `v` is some other variant.  Note: this is a plain identifier
 *  string, not a Langium `Reference<>` — the macro expander does
 *  its own lookup against the per-document inventory. */
export function readArgRef(v: MacroArgValue): string | undefined {
  return v.$type === "MacroArgRef" ? (v as MacroArgRef).ref : undefined;
}

/** Read the ref-text-list payload of a `MacroArgRefList`, or `[]`
 *  if `v` is some other variant or the list is absent.  See
 *  `readArgRef` for the not-a-Reference caveat. */
export function readArgRefs(v: MacroArgValue): readonly string[] {
  return v.$type === "MacroArgRefList" ? ((v as MacroArgRefList).refs ?? []) : [];
}
