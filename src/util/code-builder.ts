// ---------------------------------------------------------------------------
// Tiny procedural code-builder used by every generator.  One primitive:
// `lines(...parts)` concatenates strings / string[] / null / undefined /
// false with `\n` separators, dropping nullish-and-false entries.  Lets
// the caller describe a file shape declaratively without managing
// newlines or conditional-fragment empties by hand.
//
// No escaping, no runtime template parsing.  If a template needs richer
// logic, that logic lives in TypeScript next to the builder call.
// ---------------------------------------------------------------------------

export type LinesPart = string | LinesPart[] | null | undefined | false;

/** Joins parts with `\n`, flattening arrays and skipping nullish/false. */
export function lines(...parts: LinesPart[]): string {
  const out: string[] = [];
  const push = (p: LinesPart): void => {
    if (p == null || p === false) return;
    if (Array.isArray(p)) {
      for (const child of p) push(child);
      return;
    }
    out.push(p);
  };
  for (const p of parts) push(p);
  return out.join("\n");
}
