// ---------------------------------------------------------------------------
// Shared JS/TS regex-literal renderer.
//
// `matches("…")` carries a JavaScript-compatible regex SOURCE (validated at
// parse time via `new RegExp(...)`).  Three emitters have to paste that source
// into generated JS/TS as a `/…/` literal: the domain-layer expression
// renderer (`typescript/render-expr.ts`), the wire-boundary zod refine +
// `.regex(...)` chain (`zod-refine.ts`), and Angular's
// `Validators.pattern(...)` (`angular/form-validators.ts`).  Each used to
// hand-roll `source.replace(/\//g, "\\/")`, which silently produces broken
// output for two inputs — hence this single home (generator-code-review
// 2026-08-17, C4).
//
// Lives under `_expr/` because that is the shared seam every platform
// generator may import (a plain `generator/typescript/` export would be a
// sibling-platform edge for Angular; see
// `test/platform/pipeline-layering.test.ts`).
// ---------------------------------------------------------------------------

/** Convert a regex source string into a `/pattern/` literal.  Escapes the
 *  closing slash (`/` → `\/`); the value's other backslashes are part of the
 *  regex source and pass through unchanged.  Two edge cases can't sit in a
 *  `/…/` literal and fall back to the `RegExp` constructor (a plain string
 *  literal): an EMPTY pattern (bare `//` is a line comment) and a source that
 *  ends in a dangling odd backslash or contains a newline (the trailing `\`
 *  would escape our closing slash, breaking the file's parse). */
export function asRegexLiteral(source: string): string {
  if (source === "") return 'new RegExp("")';
  const escaped = source.replace(/\//g, "\\/");
  const trailingBackslashes = /\\*$/.exec(escaped)?.[0].length ?? 0;
  if (/[\n\r]/.test(escaped) || trailingBackslashes % 2 === 1) {
    return `new RegExp(${JSON.stringify(source)})`;
  }
  return `/${escaped}/`;
}
