// Macro definition surface — the public API that stdlib and
// project-local macro modules write against.
//
// A macro is a TypeScript function from typed args to a list of
// AST fragments that get spliced into the host declaration's body.
// The expander (`src/language/ddd-macro-expander.ts`) invokes
// `expand()` once per `with X(...)` call site, validates the args
// against `params`, and splices the result into the host.
//
// All AST nodes returned from `expand()` MUST be constructed via
// the factories in `./factories.ts` so they carry origin metadata
// pointing back at the `with` invocation — that's how validator
// diagnostics on synthesised members resolve to the user's source
// instead of an unhelpful "no source location" stub.

import type { Aggregate, AggregateMember, Ui, UiMember } from "../language/generated/ast.js";

/** Macros attach to one of a fixed set of host kinds.  Each kind
 * determines (a) the AST type of `target` in `ExpandContext`,
 * (b) the member type the macro is required to return, (c) which
 * `with` clause positions can invoke it (validator-enforced). */
export type MacroTarget = "aggregate" | "ui";

/** Maps a target kind to the AST type of the host node. */
export interface TargetNodeOf {
  aggregate: Aggregate;
  ui: Ui;
}

/** Maps a target kind to the member type the macro must return. */
export interface MemberTypeOf {
  aggregate: AggregateMember;
  ui: UiMember;
}

/** Declares a typed parameter on a macro.  The validator parses
 * `with X(name: value)` arguments per this spec, defaults missing
 * optional params, and reports type mismatches with diagnostics
 * pointing at the offending arg. */
export type ParamType =
  | { kind: "string"; default?: string }
  | { kind: "bool"; default?: boolean }
  | { kind: "int"; default?: number }
  | { kind: "ref"; of: NamedDeclKind; optional?: true }
  | { kind: "refList"; of: NamedDeclKind; default?: [] };

/** Named-decl kinds that a macro arg can cross-reference.  Limited
 * to the set actually useful at expansion time — extend when a new
 * macro needs it. */
export type NamedDeclKind =
  | "Aggregate"
  | "Module"
  | "BoundedContext"
  | "Workflow"
  | "View"
  | "ValueObject"
  | "EnumDecl";

/** A declared parameter list: name -> spec. */
export type ParamSpec = Record<string, ParamType>;

/** TypeScript translation of a ParamSpec value-at-runtime.  Each
 * field's type is inferred from its declared `kind`. */
export type ParamValues<P extends ParamSpec> = {
  [K in keyof P]: ParamValue<P[K]>;
};

type ParamValue<T extends ParamType> = T extends { kind: "string" }
  ? string
  : T extends { kind: "bool" }
    ? boolean
    : T extends { kind: "int" }
      ? number
      : T extends { kind: "ref"; optional: true }
        ? unknown | undefined
        : T extends { kind: "ref" }
          ? unknown
          : T extends { kind: "refList" }
            ? readonly unknown[]
            : never;

/** Context passed to a macro's `expand` function.  `target` is the
 * host AST node (an `Aggregate` for trait macros, `Ui` for
 * scaffold-style macros).  `args` is the parsed, type-checked,
 * default-filled argument bag.  `origin` is an opaque token that
 * the factories use to tag synthesised nodes for diagnostics. */
export interface ExpandContext<P extends ParamSpec, T extends MacroTarget> {
  target: TargetNodeOf[T];
  args: ParamValues<P>;
  origin: OriginToken;
}

/** Opaque origin tag attached to every synthesised AST node by the
 * factories.  Carries a reference back to the `with X(...)` call
 * site's CST node so diagnostic renderers can report errors on
 * synthesised members against the user's source position.
 * Construction is internal to the expander; macro authors never
 * touch the inside. */
export interface OriginToken {
  readonly _kind: "macro-origin";
  readonly macroName: string;
  /** The MacroCall AST node whose expansion produced any nodes
   * tagged with this token.  May lack CST info if it was itself
   * macro-emitted (future: nested macro calls). */
  readonly callNode: import("../language/generated/ast.js").MacroCall;
}

/** A macro registered with the compiler.  Stdlib ships these
 * pre-built; project-local `.loom/macros/*.ts` modules export
 * them via `export default defineMacro({ ... })`. */
export interface MacroDefinition<P extends ParamSpec = ParamSpec, T extends MacroTarget = MacroTarget> {
  /** Identifier the user writes in `with <name>(...)`. */
  name: string;
  /** Host kind this macro attaches to. */
  target: T;
  /** Typed parameter declaration.  May be omitted for zero-arg
   * macros like `auditable()`. */
  params?: P;
  /** Optional human description, surfaced in hover/completion. */
  description?: string;
  /** Optional version of the macro API this macro was authored
   * against.  Currently informational; will gate API compatibility
   * once the surface stabilises. */
  apiVersion?: 1;
  /** The expansion function.  Returns the list of members to
   * splice into the host.  Members MUST be constructed via the
   * factories so they carry origin metadata. */
  expand(ctx: ExpandContext<P, T>): MemberTypeOf[T][];
}

/** Identity function with type inference — the canonical entry
 * point for macro authors. */
export function defineMacro<P extends ParamSpec, T extends MacroTarget>(
  def: MacroDefinition<P, T>,
): MacroDefinition<P, T> {
  return def;
}
