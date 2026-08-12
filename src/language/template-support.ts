// A6 string interpolation — lexer + value-converter support for the
// backtick template terminals declared in `ddd.langium`
// (`TEMPLATE_FULL/START/MIDDLE/END`).
//
// Loom uses `{` / `}` as block delimiters everywhere, so the template
// MIDDLE (`}…{`) and END (`}…\``) terminals — which begin with `}` — would,
// under Chevrotain's single-mode longest-match lexer, greedily swallow any
// ordinary `} … {` block boundary in the whole file.  The fix is a
// two-mode lexer:
//
//   • `default` mode      — all normal tokens; MIDDLE / END are ABSENT, so a
//                           block-closing `}` is always the `}` keyword.
//                           TEMPLATE_START pushes `interpolation`.
//   • `interpolation` mode — the token set MINUS the `{` / `}` block keywords
//                           PLUS MIDDLE / END.  A hole therefore carries no
//                           literal `{ }` block, and the first `}` closes the
//                           hole (MIDDLE keeps the template open, END pops back
//                           to `default`).  Nested templates work via the mode
//                           stack (a hole may contain another backtick string).
//
// The value converter strips each segment's single-char delimiters and
// unescapes `\.` sequences, so `TemplateStr.strings[i]` is the literal
// runtime text (mirroring how `StringLit.value` is delimiter-stripped +
// unescaped) — the lowering / printer consume it directly.

import type { TokenType, TokenVocabulary } from "chevrotain";
import type { CstNode, Grammar, TokenBuilderOptions, ValueType } from "langium";
import { DefaultTokenBuilder, DefaultValueConverter, type GrammarAST } from "langium";
import { applySoftKeywordColonGuard } from "./soft-keyword-colon-guard.js";

const INTERPOLATION_MODE = "interpolation";
const DEFAULT_MODE = "default";

/** The four backtick-template terminal names (see `ddd.langium`). */
const TEMPLATE_TERMINALS = new Set([
  "TEMPLATE_FULL",
  "TEMPLATE_START",
  "TEMPLATE_MIDDLE",
  "TEMPLATE_END",
]);

/**
 * Paren/brace-aware custom matcher for the `TEMPLATE_FORMAT` terminal (i18n
 * ICU format suffix — `, number, ::currency/USD`).
 *
 * A hole is a SINGLE expression, so the only valid `,` at the top level of a
 * hole IS the format separator — but a naive greedy regex terminal would also
 * fire on a call-argument comma (`{max(a, b), number}`) or a list-element comma
 * (`{pick([a, b]), number}`).  Those inner commas sit at a non-zero
 * PAREN/BRACKET depth; the format comma is the one at depth 0.  A regex can't
 * count depth, so this custom pattern does:
 *
 *   1. It only starts at a `,`.
 *   2. It walks the tokens already matched IN THIS HOLE (back to the enclosing
 *      `TEMPLATE_START`/`TEMPLATE_MIDDLE`) and sums `(`/`[` (+1) vs `)`/`]`
 *      (−1).  A non-zero depth means this `,` is inside a call/list — NOT the
 *      format start — so it returns null and the ordinary `,` keyword matches.
 *   3. At depth 0 it captures the RAW suffix from the comma up to the `}` that
 *      closes the hole, BRACE-BALANCED: `{`/`}` inside the suffix nest, and
 *      only the depth-0 `}` (the hole terminator, which the lexer then matches
 *      as `TEMPLATE_MIDDLE`/`TEMPLATE_END`) ends the capture.  Brace-free
 *      slice-1 skeletons stop at the first `}`; slice-2 plural/select bodies
 *      (`, plural, one {…} other {…}}`) are captured whole by the same rule.
 *
 * Chevrotain tries token types in declaration order and takes the first match,
 * so `DddTokenBuilder` places this terminal AHEAD of the `,` keyword in the
 * `interpolation` mode — a depth-0 comma becomes `TEMPLATE_FORMAT`, every other
 * comma falls through to `,`.
 */
function matchTemplateFormat(
  text: string,
  offset: number,
  matchedTokens: { tokenType: { name: string } }[],
): [string] | null {
  if (text[offset] !== ",") return null;

  // A format suffix only exists INSIDE an interpolation hole, so the nearest
  // template-family token going back must be the hole's opener
  // (TEMPLATE_START / TEMPLATE_MIDDLE).  If we instead hit a closer
  // (TEMPLATE_END / TEMPLATE_FULL) or run off the front, this comma is outside
  // any hole → not a format.  This guard also makes Chevrotain's static
  // unreachable-pattern probe (which calls this with an empty token list on a
  // bare `","`) return null, so the `,` keyword stays reachable.
  let holeStart = -1;
  for (let i = matchedTokens.length - 1; i >= 0; i--) {
    const n = matchedTokens[i]!.tokenType.name;
    if (n === "TEMPLATE_START" || n === "TEMPLATE_MIDDLE") {
      holeStart = i + 1;
      break;
    }
    if (n === "TEMPLATE_END" || n === "TEMPLATE_FULL") break;
  }
  if (holeStart === -1) return null;

  // Sum paren/bracket depth over the tokens of the current hole only.
  let depth = 0;
  for (let i = holeStart; i < matchedTokens.length; i++) {
    const n = matchedTokens[i]!.tokenType.name;
    if (n === "(" || n === "[") depth++;
    else if (n === ")" || n === "]") depth--;
  }
  if (depth !== 0) return null;

  // Depth-0 comma → the format start.  Capture up to the hole-closing `}`,
  // balancing any `{`/`}` in the suffix (brace-free in slice 1).
  let i = offset;
  let brace = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") break;
    if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0) break;
      brace--;
    }
    i++;
  }
  return [text.slice(offset, i)];
}

/** Emits a multi-mode lexer definition so the `}`-leading MIDDLE / END
 *  terminals live ONLY in `interpolation` mode (never shadowing the block
 *  `}` keyword), and holes carry no literal brace blocks.  Also applies the
 *  soft-keyword-before-`:` guard (see `soft-keyword-colon-guard.ts`) — a
 *  lexer concern for the same reason the template modes are: the parser
 *  cannot express either one. */
export class DddTokenBuilder extends DefaultTokenBuilder {
  override buildTokens(grammar: Grammar, options?: TokenBuilderOptions): TokenVocabulary {
    const tokens = super.buildTokens(grammar, options) as TokenType[];

    // Before anything mode-specific: make the trailing-modifier keywords lose
    // to `ID` when a `:` follows, so `title: string` + `secret: string` is two
    // fields and not one swallowed one.  Mutates the shared token objects, so
    // both lexer modes below inherit it.
    applySoftKeywordColonGuard(tokens);

    const byName = new Map(tokens.map((t) => [t.name, t]));

    const start = byName.get("TEMPLATE_START");
    const middle = byName.get("TEMPLATE_MIDDLE");
    const end = byName.get("TEMPLATE_END");
    // No template terminals in this grammar build (shouldn't happen) — fall
    // back to the single-mode vocabulary unchanged.
    if (!start || !middle || !end) return tokens;

    start.PUSH_MODE = INTERPOLATION_MODE;
    end.POP_MODE = true;

    const lcurly = byName.get("{");
    const rcurly = byName.get("}");

    // Langium auto-adds a `LONGER_ALT` from the `}` keyword to MIDDLE/END
    // (they start with `}`).  In a multi-mode lexer a `LONGER_ALT` must live
    // in the same mode as its owner, but `}` is `default`-only and MIDDLE/END
    // are `interpolation`-only — so strip that cross-mode reference (in
    // `default`, a `}` is never a hole continuation; in `interpolation`, `}`
    // is absent and MIDDLE/END match directly).
    if (rcurly) {
      const longerAlt = rcurly.LONGER_ALT;
      if (Array.isArray(longerAlt)) {
        const kept = longerAlt.filter((t) => t !== middle && t !== end);
        rcurly.LONGER_ALT = kept.length > 0 ? kept : undefined;
      } else if (longerAlt === middle || longerAlt === end) {
        rcurly.LONGER_ALT = undefined;
      }
    }

    // The ICU format-suffix terminal (`, number, ::currency/USD`): swap its
    // placeholder regex for the paren/brace-aware custom matcher, and confine
    // it to `interpolation` mode AHEAD of the `,` keyword (Chevrotain takes the
    // first matching token in order, so a depth-0 comma wins as TEMPLATE_FORMAT
    // while every deeper comma falls through to `,`).
    const fmt = byName.get("TEMPLATE_FORMAT");
    if (fmt) {
      // Chevrotain custom-pattern token: PATTERN is a matcher fn; START_CHARS_HINT
      // keeps the optimized lexer path (a format only ever begins with `,`).
      (fmt as unknown as { PATTERN: unknown }).PATTERN = matchTemplateFormat;
      (fmt as unknown as { START_CHARS_HINT: string[] }).START_CHARS_HINT = [","];
      (fmt as unknown as { LINE_BREAKS: boolean }).LINE_BREAKS = false;

      // Langium auto-adds a `LONGER_ALT` from the `,` keyword to TEMPLATE_FORMAT
      // (the placeholder regex begins with `,`).  As with the `}`→MIDDLE/END
      // case above, a cross-mode LONGER_ALT breaks the multi-mode lexer (`,` is
      // present in both modes, TEMPLATE_FORMAT only in `interpolation`), and the
      // custom matcher already decides format-vs-comma itself — so strip it.
      const comma = byName.get(",");
      if (comma) {
        const la = comma.LONGER_ALT;
        if (Array.isArray(la)) {
          const kept = la.filter((t) => t !== fmt);
          comma.LONGER_ALT = kept.length > 0 ? kept : undefined;
        } else if (la === fmt) {
          comma.LONGER_ALT = undefined;
        }
      }
    }

    // `default`: everything EXCEPT the hole-continuation terminals and the
    // interpolation-only format suffix.
    const defaultMode = tokens.filter((t) => t !== middle && t !== end && t !== fmt);
    // `interpolation`: everything EXCEPT the block braces (a hole has none),
    // keeping MIDDLE / END so the first `}` closes the hole, with the format
    // suffix FIRST so it outranks the `,` keyword at a depth-0 comma.
    const interpolationRest = tokens.filter((t) => t !== lcurly && t !== rcurly && t !== fmt);
    const interpolationMode = fmt ? [fmt, ...interpolationRest] : interpolationRest;

    return {
      modes: {
        [DEFAULT_MODE]: defaultMode,
        [INTERPOLATION_MODE]: interpolationMode,
      },
      defaultMode: DEFAULT_MODE,
    };
  }
}

/** `TEMPLATE_*` value converter — strip the single-char delimiters and
 *  unescape, so `strings[i]` is the literal text.  Plain terminals defer to
 *  the default converter (which handles `STRING`, `INT`, … ). */
export class DddValueConverter extends DefaultValueConverter {
  protected override runConverter(
    rule: GrammarAST.AbstractRule,
    input: string,
    cstNode: CstNode,
  ): ValueType {
    if (TEMPLATE_TERMINALS.has(rule.name)) {
      return unescapeTemplateSegment(input.slice(1, -1));
    }
    return super.runConverter(rule, input, cstNode);
  }
}

/** Process `\.` escapes in a template segment.  Mirrors the STRING escape
 *  set and adds the template-specific `` \` `` / `\{` / `\}`. */
function unescapeTemplateSegment(text: string): string {
  return text.replace(/\\(.)/g, (_match, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "`":
        return "`";
      case "{":
        return "{";
      case "}":
        return "}";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return ch;
    }
  });
}
