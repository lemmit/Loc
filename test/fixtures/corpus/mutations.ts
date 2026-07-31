// Corpus mutation catalog — the INPUT half of the honest-gate invariant.
//
// Every gate in `test/conformance/` is a function of the 32 hand-authored
// fixtures beside this file.  That is their weakness: G1 and G2 (the two
// boot-break shapes fixed in #2316) escaped every one of them for a single
// reason — no human had written those programs into a fixture.  The gates were
// fine; their DOMAIN was 32 files.
//
// A mutation takes a fixture and returns a VARIANT of it.  The variants are not
// a list of past bugs (that is what a regression test is, and #2316 already
// added those).  Each family names a SEAM — a place the validator and the
// emitters can disagree — and enumerates it mechanically, so the matrix grows
// on its own when the compiler grows:
//
//   M1  capability-member collision   — derived from `builtinCapabilities()`
//   M2  slot transposition            — derived from each fixture's own AST
//   M3  seeded AST edit               — random, nightly (not yet implemented)
//
// The invariant asserted over the variants lives in
// `test/conformance/corpus-mutation.test.ts`: a variant is either REJECTED with
// a `loom.*` diagnostic, or it generates cleanly on every backend the feature
// declares.  Anything in between — accepted, emitted, and broken — is the class
// this catalog exists to find.

import { AstUtils } from "langium";
import {
  isAggregate,
  isDerivedProp,
  isEntityPart,
  isProperty,
  isValueObject,
  type Model,
  type Property,
} from "../../../src/language/generated/ast.js";
import { builtinCapabilities } from "../../../src/macros/prelude.js";

/** A source-to-source edit.  Returns `null` when the fixture has no site the
 *  mutation applies to — a skip, not a failure. */
export interface Mutation {
  /** Stable id, used as the test name and to pin a failure. */
  readonly id: string;
  /** One line on which seam this probes (shown on failure). */
  readonly seam: string;
  apply(src: string, ast: Model): string | null;
}

// ---------------------------------------------------------------------------
// The seam table — read off the compiler, not written down here.
// ---------------------------------------------------------------------------

/** Every field name the built-in capabilities splice into an aggregate.
 *
 *  Deriving this from `builtinCapabilities()` rather than hardcoding it is the
 *  point: `versioned` contributing `version` is what made G2 reachable, and a
 *  capability that gains a member tomorrow widens this matrix with no edit
 *  here.  Sorted so the generated test names are stable across runs. */
export function splicedMemberNames(): readonly string[] {
  const names = new Set<string>();
  for (const cap of builtinCapabilities().values()) {
    for (const m of cap.members) if (isProperty(m)) names.add(m.name);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// M1 — capability-member collision
// ---------------------------------------------------------------------------
//
// G2 was ONE cell of this family: a user-declared `version: string` on an
// aggregate the `versioned` capability also targets.  `mergeScopedMembers`
// dropped the injected member on the name clash but left the aggregate TAGGED,
// so the emitters treated a text column as the optimistic-concurrency counter
// and Postgres refused the table (`"version" TEXT NOT NULL DEFAULT 1`).
//
// The seam is "a user member shadows a spliced one", and it has
// |splicedMemberNames()| x |declaration kinds| cells, of which G2 is one.

/** Declaration kinds a capability member can be shadowed in. */
const HOSTS = ["aggregate", "entityPart", "valueObject"] as const;
type Host = (typeof HOSTS)[number];

/** The first user-declared property inside a host of the given kind, skipping
 *  any that already carries a spliced name (mutating it would be a no-op). */
function firstPropertyIn(ast: Model, host: Host): Property | undefined {
  const reserved = new Set(splicedMemberNames());
  for (const node of AstUtils.streamAllContents(ast)) {
    if (!isProperty(node)) continue;
    const owner = node.$container;
    const kind: Host | undefined = isAggregate(owner)
      ? "aggregate"
      : isEntityPart(owner)
        ? "entityPart"
        : isValueObject(owner)
          ? "valueObject"
          : undefined;
    if (kind === host && !reserved.has(node.name)) return node;
  }
  return undefined;
}

/** Whole-word rename of `from` -> `to` across the source.
 *
 *  Deliberately textual, and deliberately renaming REFERENCES too: renaming
 *  only the declaration would leave dangling refs and the variant would fail on
 *  an unresolved name, which is a different (and uninteresting) diagnostic.
 *  Renaming every occurrence yields a program that differs from the fixture in
 *  exactly one thing — the identifier — which is the variable under test. */
function renameIdentifier(src: string, from: string, to: string): string {
  return src.replace(new RegExp(`\\b${from}\\b`, "g"), to);
}

export function capabilityCollisionMutations(): Mutation[] {
  const out: Mutation[] = [];
  for (const host of HOSTS) {
    for (const name of splicedMemberNames()) {
      out.push({
        id: `M1.${host}.${name}`,
        seam: `a user-declared ${host} member shadows the \`${name}\` capability splices`,
        apply(src, ast) {
          const target = firstPropertyIn(ast, host);
          if (target === undefined) return null;
          return renameIdentifier(src, target.name, name);
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// M2 — slot transposition
// ---------------------------------------------------------------------------
//
// G1 was ONE cell of this family: a field `= default` whose expression reads
// `this`.  A default is not a body — it is spliced where no instance exists,
// most visibly into the create-request wire schema at MODULE scope — so
// `avgPrice: decimal = this.total / this.count` emitted
// `z.coerce.number().default(this.total / this.count)` (TS2683 plus a boot-time
// TypeError) on Hono, a `NameError` on Python, and was silently DROPPED on .NET
// and Java, quietly turning the field into required create input.
//
// The seam is "an expression moves into a slot where no instance exists", and a
// fixture's own `derived` members are exactly the supply of instance-dependent
// expressions.  Transposing one into a default slot is mechanical, derived from
// the fixture rather than from the bug: `derived isDraft: bool = status ==
// Status.Draft` becomes `isDraft: bool = status == Status.Draft`.
//
// Note this reaches a case G1's own regression test does not: the reference is
// a BARE sibling (`status`), not a spelled-out `this.status`.  Both lower to a
// this-prop ref, so `loom.field-default-not-constant` should own both — but only
// if it tests the resolved refKind rather than the surface syntax.

/** `derived <name>: <type> = <expr>` → `<name>: <type> = <expr>`, dropping the
 *  keyword so the computed expression lands in a stored field's default slot. */
const DERIVED_DECL = /^([ \t]*)derived[ \t]+(\w+)[ \t]*:/m;

export function slotTranspositionMutations(): Mutation[] {
  return [
    {
      id: "M2.derived-to-default",
      seam: "an instance-dependent `derived` expression moves into a default slot, where no instance exists",
      apply(src, ast) {
        // AST-gated: only mutate a fixture that actually declares one, so the
        // textual rewrite can't fire on a stray comment mentioning `derived`.
        const hasDerived = [...AstUtils.streamAllContents(ast)].some(isDerivedProp);
        if (!hasDerived || !DERIVED_DECL.test(src)) return null;
        return src.replace(DERIVED_DECL, "$1$2:");
      },
    },
  ];
}

/** The deterministic, per-PR mutation set for a fixture. */
export function mutationsFor(): Mutation[] {
  return [...capabilityCollisionMutations(), ...slotTranspositionMutations()];
}
