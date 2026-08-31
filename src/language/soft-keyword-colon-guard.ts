// Soft-keyword-before-`:` lexer guard — "a word followed by a colon is a
// DECLARATION, never the previous declaration's trailing modifier".
//
// ## The bug class this closes (pairwise finding F4)
//
// Loom's house rule is "never steal a domain word": a keyword the grammar
// mints for its own syntax stays usable as an ordinary identifier (see
// `CommonSoftKeywords` / `LooseName` / `NameRefIdent` in `ddd.langium`, and
// the `keyword-identifier-completeness` gate that pins it).  That admission
// is done in the PARSER — the keyword is listed as an alternative next to
// `ID` in every identifier rule.
//
// It is not enough for one shape of keyword: the ones the grammar also uses
// as a **trailing modifier** on a member.  `Property` is
//
//     name ':' type ( provenanced | sensitive(...) | <access> )* ('=' expr)? …
//
// and the grammar is newline-insensitive, so a modifier-less property
// followed by a property NAMED one of those modifiers is swallowed:
//
//     title: string
//     secret: string     // parsed as `title: string secret`, then the `:`
//                        // is a syntax error — reported on the WRONG line
//
// Reorder the two fields and it parses; put a `= default` on the first one
// and it parses.  So the failure depends on the *preceding* member, which is
// why it survived so long — every fixture that happened to declare the field
// first never saw it.
//
// The same shape appears one layer down in `TypeRef`, whose union / carrier
// words (`or`, `option`, `paged`, `envelope`) are trailing too — `title:
// string` + `option: string` swallows identically — and in the `check … `
// / `invariant …` **`message "…"`** clause.
//
// ## Why this is a LEXER fix and not a grammar fix
//
// The decision "is this token a modifier or the start of the next member?"
// is a repetition-exit decision inside `Property`.  Chevrotain computes
// lookahead paths for an optional/repeated production against the rest of
// the SAME rule; here the rest is all-optional, so the "exit" path can be
// empty, the two alternatives are indistinguishable at any `k`, and the
// greedy "enter the loop" branch wins.  No amount of `maxLookahead`, rule
// re-ordering, or unordered-group rewriting expresses "modifier, unless the
// next token is `:`" — Langium's grammar language has no syntactic
// predicate.
//
// The lexer can say it in one line, and it is the same seam `DddTokenBuilder`
// already uses for the template terminals: **a guarded keyword whose very
// next non-space character is `:` does not match as a keyword at all**, so
// the ordinary `ID` terminal takes it and the parser sees a new member.  A
// keyword is only ever a modifier in a position where a `:` cannot follow, so
// this loses no legitimate parse (asserted below by construction, and pinned
// by `soft-keyword-colon-guard.test.ts` + the keyword-identifier probe).
//
// ## Membership rule for GUARDED_SOFT_KEYWORDS
//
// A keyword belongs here iff BOTH hold:
//
//   1. it is admissible as an identifier in a `<name> ':' …` declaration
//      position (`Property.name`, `LooseName`, `StateFieldName`, …), AND
//   2. the grammar NEVER writes it immediately before a `':'` keyword — i.e.
//      no rule of the shape `'kw' ':' …`.  (Many soft keywords DO: `kind:`,
//      `title:`, `route:`, `persistence:`, `shape:`, `use:`, … — guarding
//      those would break the block syntax that reads them.)
//
// `guardedKeywordsUsedBeforeColon` (below) re-derives (2) from the grammar AST
// and is asserted empty by `soft-keyword-colon-guard.test.ts`, so a future
// grammar rule that starts using a guarded word before a colon fails loudly
// instead of silently un-parsing that rule.

import type { TokenType } from "chevrotain";
import { AstUtils, type Grammar, type GrammarAST } from "langium";

/**
 * The soft keywords that must lose to `ID` when a `:` follows.
 *
 * Derived empirically (probe: "is `<kw>` declarable as a field alone but NOT
 * as the second field after a modifier-less property?") and verified against
 * the membership rule above.  Grouped by the trailing clause that swallowed
 * them:
 *
 * - `FieldAccess` — the property access modifier (`ddd.langium`, `FieldAccess`)
 * - `TypeRef` — union / carrier suffix words
 * - the `check` / `invariant` / `precondition` `message "…"` clause
 */
export const GUARDED_SOFT_KEYWORDS: readonly string[] = [
  // FieldAccess: `amount: money secret`
  "immutable",
  "internal",
  "managed",
  "secret",
  "token",
  // TypeRef suffixes / union: `email: string option`, `rows: Row paged`
  "envelope",
  "option",
  "or",
  "paged",
  // `check <expr> message "…"` / `invariant <expr> message "…"`
  "message",
];

/** `kw` followed (across any run of whitespace) by `:` is NOT this keyword.
 *  Whitespace is allowed in the lookahead so the odd `secret\n: string`
 *  layout resolves the same way as the usual one-line form. */
function guardedPattern(keyword: string): RegExp {
  return new RegExp(`${keyword}(?!\\s*:)`);
}

/**
 * Rewrite the guarded keyword tokens in place so each declines to match when
 * a `:` follows.  Called by `DddTokenBuilder.buildTokens` on the flat token
 * list, BEFORE it is split into lexer modes — the token objects are shared by
 * both modes, so one rewrite covers `default` and `interpolation` alike.
 *
 * `LONGER_ALT` (→ `ID`) is left untouched: `secretive` still matches the
 * keyword pattern at `secret` and is then extended to the longer `ID`.
 * `START_CHARS_HINT` / `LINE_BREAKS` are set explicitly so Chevrotain keeps
 * its optimized first-char dispatch for a pattern it cannot analyse statically
 * (a lookahead defeats its regexp introspection) and emits no line-terminator
 * warning.
 *
 * @returns the names actually guarded (a keyword absent from this grammar
 *          build is skipped, not an error).
 */
export function applySoftKeywordColonGuard(tokens: TokenType[]): string[] {
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const guarded: string[] = [];
  for (const keyword of GUARDED_SOFT_KEYWORDS) {
    const token = byName.get(keyword);
    if (!token) continue;
    const mutable = token as unknown as {
      PATTERN: unknown;
      START_CHARS_HINT: string[];
      LINE_BREAKS: boolean;
    };
    mutable.PATTERN = guardedPattern(keyword);
    mutable.START_CHARS_HINT = [keyword[0] as string];
    mutable.LINE_BREAKS = false;
    guarded.push(keyword);
  }
  return guarded;
}

/**
 * Re-derive membership rule (2) from the grammar AST: report every guarded
 * keyword the grammar DOES write immediately before a `':'`.  A non-empty
 * result means the guard would break that rule's syntax and the keyword must
 * leave `GUARDED_SOFT_KEYWORDS` (or the rule must change).
 *
 * Consumed by `soft-keyword-colon-guard.test.ts`; exported here so the rule
 * and its check live next to each other.
 */
export function guardedKeywordsUsedBeforeColon(grammar: Grammar): string[] {
  const guarded = new Set(GUARDED_SOFT_KEYWORDS);
  const offenders = new Set<string>();

  // Deliberately OVER-approximate: every guarded keyword appearing ANYWHERE
  // inside the element that precedes a `':'` counts, not just a bare `'kw' ':'`
  // sibling pair — so `('secret' | 'x') ':'` or `('secret' y)? ':'` is caught
  // too.  A false positive fails this check and gets reviewed; a false negative
  // would silently un-parse a rule.  Erring toward the reviewable direction is
  // the whole point of the check.
  const guardedKeywordsIn = (node: GrammarAST.AbstractElement): string[] =>
    [node, ...AstUtils.streamAllContents(node)]
      .filter((n): n is GrammarAST.Keyword => n.$type === "Keyword")
      .map((k) => k.value)
      .filter((v) => guarded.has(v));

  for (const node of AstUtils.streamAllContents(grammar)) {
    if (node.$type !== "Group" && node.$type !== "UnorderedGroup") continue;
    const elements = (node as GrammarAST.Group).elements ?? [];
    for (let i = 1; i < elements.length; i++) {
      const next = elements[i];
      const here = elements[i - 1];
      if (!here || next?.$type !== "Keyword") continue;
      if ((next as GrammarAST.Keyword).value !== ":") continue;
      for (const v of guardedKeywordsIn(here)) offenders.add(v);
    }
  }
  return [...offenders].sort();
}
