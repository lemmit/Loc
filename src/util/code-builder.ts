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

/** Re-indents every line of each part by `spaces` leading spaces and
 *  returns the flattened line list (so it drops straight into a
 *  `lines(...)` call without re-joining).  Flattens arrays and skips
 *  nullish/false exactly like `lines`; multiline strings are split so a
 *  nested block indents uniformly, and blank lines stay blank (no
 *  trailing whitespace).  Use it instead of a hand-rolled
 *  `block.map((l) => `  ${l}`)` when wrapping an already-built body in
 *  an extra layer of nesting. */
export function indent(spaces: number, ...parts: LinesPart[]): string[] {
  const pad = " ".repeat(spaces);
  const out: string[] = [];
  const push = (p: LinesPart): void => {
    if (p == null || p === false) return;
    if (Array.isArray(p)) {
      for (const child of p) push(child);
      return;
    }
    for (const line of p.split("\n")) out.push(line === "" ? "" : pad + line);
  };
  for (const p of parts) push(p);
  return out;
}
