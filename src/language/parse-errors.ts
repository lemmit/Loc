// ---------------------------------------------------------------------------
// Phase ① parse-error reporting — the two things a syntax error has to do.
//
// SAY WHAT IS WRONG, SHORTLY.  Chevrotain's default "no viable alternative"
// message dumps every lookahead path it considered:
//
//     Expecting: one of these possible Token sequences:
//       1. [mantine]
//       2. [shadcn]
//       … 12 more numbered lines …
//     but found: 'mantinee'
//
// That is a machine's working, not a diagnostic — and on wider alternations
// it runs to over a hundred numbered lines.  Every alternative here is a
// CLOSED SET the author was choosing from (design packs, platforms, storage
// kinds, keywords in a member position), so the useful reply is the nearest
// member of that set plus a handful of the rest.  `buildNoViableAltMessage`
// and `buildEarlyExitMessage` below render exactly that, with the candidate
// list capped at `MAX_CANDIDATES`.
//
// POINT AT THE CAUSE.  Loom's parser runs on chevrotain's ALL(*) lookahead,
// which picks an alternative by SIMULATING it against the real token stream.
// So a `Stack { … }` whose body contains a syntax error 17 lines down does
// not fail inside `Stack` — the whole `BuilderCall` alternative simply loses
// the lookahead race to bare `NameRef`, and the error surfaces at `Stack`'s
// own `{`, followed by a run of recovery cascades.  The author is sent to a
// line that is correct.
//
// `refineParseErrorOffset` walks that back: a mismatch ON a `{` whose
// preceding token is a plain name is the signature of a swallowed builder
// call, so we re-parse from that name with the `BuilderCall` rule and take
// the position the inner parse fails at.  The inner parse can hit the same
// shape one level down (`Stack { … Text { … } … }`), so it iterates, and
// each step must move strictly forward — the walk terminates on the
// innermost failure or gives up and keeps the original position.
//
// Layering: `src/language/` (phase ①), imported by `ddd-module.ts` for the
// service bindings.  Node-free, so the playground gets the same messages.
// ---------------------------------------------------------------------------

import type { IRecognitionException, IToken, TokenType } from "chevrotain";
import type { LangiumCoreServices, ParseResult } from "langium";
import { LangiumParserErrorMessageProvider } from "langium";
import { diagMessage } from "../diagnostics/messages.js";
import { nearestName } from "../util/edit-distance.js";

/** How many of the expected tokens a message names before it stops.  Five is
 *  enough to show the SHAPE of the closed set (`node`, `dotnet`, `react`, …)
 *  without turning the diagnostic back into a token dump. */
const MAX_CANDIDATES = 5;

/** How many nested builder-call levels the position walk will descend before
 *  giving up.  A page body nests a handful deep; the bound only exists so a
 *  pathological input cannot spin. */
const MAX_REFINEMENT_DEPTH = 24;

/** Keyword token types are minted from the literal they match, so their
 *  `name` IS the source text (`mantine`, `platform`, `{`).  Terminals keep
 *  their grammar name (`ID`, `STRING`, `INT`).  Only the former is worth
 *  quoting back at the author or running a did-you-mean over. */
function isKeywordToken(tt: TokenType): boolean {
  return typeof tt.PATTERN === "string";
}

/** The source text a token type stands for. */
function labelOf(tt: TokenType): string {
  const raw = tt.LABEL ?? tt.name;
  return raw.endsWith(":KW") ? raw.slice(0, raw.length - 3) : raw;
}

/** The distinct FIRST tokens of the lookahead paths, in grammar order.
 *  Only the first token of each path can be the one that was expected HERE;
 *  the rest of a path describes what would follow, which is noise at the
 *  point of failure. */
function firstTokenLabels(paths: TokenType[][]): { keywords: string[]; terminals: string[] } {
  const keywords: string[] = [];
  const terminals: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const head = path[0];
    if (!head) continue;
    const label = labelOf(head);
    if (seen.has(label)) continue;
    seen.add(label);
    (isKeywordToken(head) ? keywords : terminals).push(label);
  }
  return { keywords, terminals };
}

/** A token image that could be a misspelling of a word — a did-you-mean over
 *  punctuation ("did you mean '!'?" for `?`) is noise, so only word-shaped
 *  images and candidates take part. */
function isWordLike(image: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(image);
}

/** Render the capped candidate list: keywords quoted (they are literal source
 *  text), terminal names angle-bracketed so `<STRING>` reads as a placeholder
 *  rather than a keyword the author could type.  A did-you-mean candidate is
 *  hoisted to the front so the sample always contains the one the author most
 *  likely wanted, even in a wide alternation. */
function renderCandidates(
  keywords: string[],
  terminals: string[],
  suggestion: string | undefined,
): string {
  const ordered = suggestion ? [suggestion, ...keywords.filter((k) => k !== suggestion)] : keywords;
  const all = [...ordered.map((k) => `'${k}'`), ...terminals.map((t) => `<${t}>`)];
  const shown = all.slice(0, MAX_CANDIDATES);
  const hidden = all.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
}

/** The shared body of both alternation failures: what was found, the nearest
 *  legal spelling of it, and a capped sample of what was legal here. */
export function unexpectedTokenMessage(actual: IToken, paths: TokenType[][]): string {
  const { keywords, terminals } = firstTokenLabels(paths);
  const suggestion = isWordLike(actual.image)
    ? nearestName(actual.image, keywords.filter(isWordLike))
    : undefined;
  return diagMessage("loom.parse-error#unexpected-token", {
    found: actual.image,
    suggestion: suggestion ? ` Did you mean '${suggestion}'?` : "",
    candidates: renderCandidates(keywords, terminals, suggestion),
  });
}

/**
 * Langium's provider with the two token-dump messages replaced.  The
 * mismatched-token and redundant-input messages are already short, so they
 * keep Langium's wording (and every test that pins it).
 */
export class DddParserErrorMessageProvider extends LangiumParserErrorMessageProvider {
  override buildNoViableAltMessage(options: {
    expectedPathsPerAlt: TokenType[][][];
    actual: IToken[];
    previous: IToken;
    customUserDescription: string;
    ruleName: string;
  }): string {
    const actual = options.actual[0];
    if (!actual) return super.buildNoViableAltMessage(options);
    return unexpectedTokenMessage(actual, options.expectedPathsPerAlt.flat());
  }

  override buildEarlyExitMessage(options: {
    expectedIterationPaths: TokenType[][];
    actual: IToken[];
    previous: IToken;
    customUserDescription: string;
    ruleName: string;
  }): string {
    const actual = options.actual[0];
    if (!actual) return super.buildEarlyExitMessage(options);
    return unexpectedTokenMessage(actual, options.expectedIterationPaths);
  }
}

// ---------------------------------------------------------------------------
// Position refinement — walking an ALL(*) alternative rejection back to the
// inner token that actually failed.
// ---------------------------------------------------------------------------

/** A refined parse failure: where it really is, and what the inner parse
 *  said about it. */
export interface RefinedParseError {
  /** Absolute offset into the ORIGINAL document text. */
  offset: number;
  /** Length of the offending token, for the diagnostic range. */
  length: number;
  message: string;
}

/**
 * Where the bare name immediately before `braceOffset` starts, or `undefined`
 * when there is none.  This reads the SOURCE, not the exception's
 * `previousToken`: after an ALL(*) alternative loses the lookahead race,
 * `previousToken` is the last token the parser actually consumed, which can
 * be an arbitrary distance back (on the field-test repro it was the `2` of a
 * `level: 2` on the line above).  The text never lies about what precedes the
 * brace.
 *
 * A name directly before `{` is the builder-call signature — `Stack {`,
 * `Text {`.  Soft keywords lex as their own token types, so matching on the
 * characters rather than the token type keeps them in.
 */
function nameStartBefore(text: string, braceOffset: number): number | undefined {
  let i = braceOffset - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(text[i]!)) i--;
  const start = i + 1;
  if (start >= end) return undefined;
  if (!/[A-Za-z_]/.test(text[start]!)) return undefined;
  return start;
}

/** True when `err` has the swallowed-builder-call signature: the parser choked
 *  ON an opening brace that directly follows a bare name.  That is never a
 *  real "unexpected `{`" — the name+brace pair is a builder call the ALL(*)
 *  lookahead refused because something INSIDE it does not parse. */
function swallowedBuilderCallHead(err: IRecognitionException, text: string): number | undefined {
  const token = err.token;
  if (token?.image !== "{" || Number.isNaN(token.startOffset)) return undefined;
  return nameStartBefore(text, token.startOffset);
}

/** The parser seam the walk needs — just enough of `LangiumParser` to re-run
 *  one rule over a slice of text. */
interface RuleParser {
  parse(input: string, options?: { rule?: string }): ParseResult<object>;
}

/**
 * Walk a parse failure inward to the token that actually broke.
 *
 * Returns `undefined` when the failure is not a swallowed builder call, when
 * the re-parse finds nothing deeper, or when anything throws — in every case
 * the caller keeps chevrotain's original position, so this can only improve a
 * diagnostic, never invent one.
 */
export function refineParseErrorOffset(
  err: IRecognitionException,
  text: string,
  parser: RuleParser,
): RefinedParseError | undefined {
  let base = swallowedBuilderCallHead(err, text);
  if (base === undefined) return undefined;

  let best: RefinedParseError | undefined;
  for (let depth = 0; depth < MAX_REFINEMENT_DEPTH; depth++) {
    let inner: IRecognitionException | undefined;
    try {
      // Parse the builder call from its type name to the end of the file:
      // only the FIRST inner error matters, so trailing text the rule cannot
      // consume is irrelevant.
      inner = parser.parse(text.slice(base), { rule: "BuilderCall" }).parserErrors[0];
    } catch {
      return best;
    }
    if (!inner?.token || Number.isNaN(inner.token.startOffset)) return best;
    const offset = base + inner.token.startOffset;
    // Strictly forward, or the walk is not converging — bail rather than loop.
    if (offset <= (best?.offset ?? err.token.startOffset)) return best;
    best = {
      offset,
      length: Math.max(1, inner.token.image.length),
      message: inner.message,
    };
    if (inner.token.image !== "{") return best;
    const nested = nameStartBefore(text, offset);
    if (nested === undefined) return best;
    base = nested;
  }
  return best;
}

/** The source text behind a parse result, or `undefined` when the parse
 *  produced no CST to read it from. */
export function sourceTextOf(parseResult: ParseResult<object>): string | undefined {
  const root = (parseResult.value as { $cstNode?: { root?: { fullText?: string } } } | undefined)
    ?.$cstNode?.root;
  return typeof root?.fullText === "string" ? root.fullText : undefined;
}

/** The `LangiumParser` re-parse seam, resolved lazily so the provider never
 *  holds a service reference the browser bundle would keep alive. */
export function ruleParserOf(services: LangiumCoreServices): RuleParser {
  return services.parser.LangiumParser as unknown as RuleParser;
}
