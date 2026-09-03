// ---------------------------------------------------------------------------
// Document validation policy — WHAT IS EVEN WORTH SAYING once the parse broke.
//
// Langium's default runs every phase unconditionally: lexer errors, then
// parser errors, then linking errors, then the AST validators.  On a file
// that parses cleanly that is exactly right.  On a file with ONE syntax error
// it is a fire hose of fiction, because every later phase is reading an AST
// that is missing whole subtrees.  A single unsupported operator in a page
// body produced, on the field-test model:
//
//   * 7 × "v2 syntax: construct 'Alert' with builder-call form" at 1:1 —
//     the validator walking a `ui` block the parser never finished, with no
//     CST to attach to, so every one of them landed on line 1;
//   * 3 × "Duplicate api 'issues'" — the same declaration recovered twice;
//   * "Could not resolve reference to Ui named 'WebApp'" — the `ui` the
//     parser dropped;
//   * 6 further parse errors, each one the previous one's resynchronisation.
//
// Fifteen errors, one cause, and the cause was not among them.  So:
//
//   1. STOP AFTER A LEX/PARSE ERROR.  Linking and validation are skipped
//      wholesale — nothing they could say about a truncated AST is
//      trustworthy.  Langium already has the switches for this
//      (`stopAfterLexingErrors` / `stopAfterParsingErrors`); Loom just turns
//      them on for every caller instead of leaving them to each entry point.
//   2. REPORT THE FIRST PARSE ERROR ONLY.  After a mismatch the parser
//      resynchronises and everything it says next is downstream of a guess.
//      One accurate position beats seven speculative ones; the next run
//      reports the next real error.
//   3. REPORT IT WHERE IT ACTUALLY IS — see `refineParseErrorOffset` in
//      `parse-errors.ts` for the ALL(*) builder-call walk-back.
//
// The IR phases were already gated on a clean parse (`hasParseError` in
// `src/api/index.ts`, the early `process.exit` in `runParse`), so this closes
// the last phase that spoke over a broken AST.
// ---------------------------------------------------------------------------

import {
  type Cancellation,
  DefaultDocumentValidator,
  type LangiumCoreServices,
  type LangiumDocument,
  type ParseResult,
  type ValidationOptions,
} from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import { refineParseErrorOffset, ruleParserOf, sourceTextOf } from "./parse-errors.js";

export class DddDocumentValidator extends DefaultDocumentValidator {
  private readonly coreServices: LangiumCoreServices;

  constructor(services: LangiumCoreServices) {
    super(services);
    this.coreServices = services;
  }

  /** Every caller gets the stop-after-lex/parse policy, whatever options it
   *  passed.  An explicit `false` from a caller is honoured — the LSP or a
   *  test may deliberately want the noisy behaviour — but nobody has to
   *  remember to ask for the quiet one. */
  override validateDocument(
    document: LangiumDocument,
    options: ValidationOptions = {},
    cancelToken?: Cancellation.CancellationToken,
  ): Promise<Diagnostic[]> {
    return super.validateDocument(
      document,
      {
        stopAfterLexingErrors: true,
        stopAfterParsingErrors: true,
        ...options,
      },
      cancelToken,
    );
  }

  /** One parse diagnostic per document, at the innermost position we can
   *  justify.  Everything after the first error is recovery noise. */
  protected override processParsingErrors(
    parseResult: ParseResult,
    diagnostics: Diagnostic[],
    options: ValidationOptions,
  ): void {
    const [first] = parseResult.parserErrors;
    if (!first) return;

    const before = diagnostics.length;
    super.processParsingErrors({ ...parseResult, parserErrors: [first] }, diagnostics, options);
    const diagnostic = diagnostics[before];
    if (!diagnostic) return;

    const text = sourceTextOf(parseResult);
    if (!text) return;
    const refined = refineParseErrorOffset(first, text, ruleParserOf(this.coreServices));
    if (!refined) return;
    const start = offsetToPosition(text, refined.offset);
    diagnostic.range = {
      start,
      end: { line: start.line, character: start.character + refined.length },
    };
    diagnostic.message = refined.message;
  }
}

/** Line/character for an absolute offset.  The refinement walk works in
 *  offsets (it slices the source), and the diagnostic wants a position;
 *  `TextDocument` is not reachable from `processParsingErrors`, so convert
 *  here rather than thread a document through. */
function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: Math.max(0, Math.min(offset, text.length) - lineStart) };
}
