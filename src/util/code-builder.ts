// ---------------------------------------------------------------------------
// Tiny procedural code-builder used by every generator.  Two primitives:
//
//   1. `lines(...parts)` — concatenates strings / string[] / null / undefined
//      with `\n` separators, dropping nullish entries.  Lets the caller
//      describe a file shape declaratively without managing newlines by
//      hand.
//
//   2. `Block` — a stateful indenter for output where nested braces or
//      C-style indentation matter.  Owns its own `\n` joining; callers
//      add lines and let the builder track depth.
//
// Both are intentionally minimal — no escaping, no runtime template
// parsing.  If a template needs richer logic, that logic lives in
// TypeScript next to the builder call.
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

export interface BlockOptions {
  /** Indent string applied per depth level.  Default: 4 spaces. */
  indent?: string;
}

/** Indenting line buffer.  Use `line(s)`, `blank()`, `indent()`/`dedent()`,
 * or the `openBrace`/`closeBrace` shorthand.  `toString()` joins the buffer
 * with `\n` and appends a trailing newline. */
export class Block {
  private readonly buf: string[] = [];
  private depth = 0;
  private readonly unit: string;

  constructor(opts: BlockOptions = {}) {
    this.unit = opts.indent ?? "    ";
  }

  line(s = ""): this {
    this.buf.push(s.length === 0 ? "" : this.unit.repeat(this.depth) + s);
    return this;
  }

  /** Pushes the literal string verbatim — no indentation prefix added.
   * Useful when stitching pre-rendered multi-line fragments. */
  raw(s: string): this {
    this.buf.push(s);
    return this;
  }

  blank(): this {
    this.buf.push("");
    return this;
  }

  indent(): this {
    this.depth++;
    return this;
  }

  dedent(): this {
    if (this.depth > 0) this.depth--;
    return this;
  }

  openBrace(prefix: string): this {
    this.line(`${prefix} {`);
    this.indent();
    return this;
  }

  closeBrace(suffix = ""): this {
    this.dedent();
    this.line(`}${suffix}`);
    return this;
  }

  toString(): string {
    return this.buf.join("\n") + "\n";
  }
}
