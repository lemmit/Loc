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

const INTERPOLATION_MODE = "interpolation";
const DEFAULT_MODE = "default";

/** The four backtick-template terminal names (see `ddd.langium`). */
const TEMPLATE_TERMINALS = new Set([
  "TEMPLATE_FULL",
  "TEMPLATE_START",
  "TEMPLATE_MIDDLE",
  "TEMPLATE_END",
]);

/** Emits a multi-mode lexer definition so the `}`-leading MIDDLE / END
 *  terminals live ONLY in `interpolation` mode (never shadowing the block
 *  `}` keyword), and holes carry no literal brace blocks. */
export class DddTokenBuilder extends DefaultTokenBuilder {
  override buildTokens(grammar: Grammar, options?: TokenBuilderOptions): TokenVocabulary {
    const tokens = super.buildTokens(grammar, options) as TokenType[];
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

    // `default`: everything EXCEPT the hole-continuation terminals.
    const defaultMode = tokens.filter((t) => t !== middle && t !== end);
    // `interpolation`: everything EXCEPT the block braces (a hole has none),
    // keeping MIDDLE / END so the first `}` closes the hole.
    const interpolationMode = tokens.filter((t) => t !== lcurly && t !== rcurly);

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
