// CodeBlock primitive — syntax-highlighted code via highlight.js CDN.
//
//   CodeBlock {
//     "aggregate Order {\n  customerId: string\n}",   // positional source
//     language: "typescript",
//     title:    "orders.ddd"                          // optional title
//   }
//
//   // Equivalent — named-arg shape:
//   CodeBlock { source: "...", language: "typescript" }
//
// Both shapes are admissible.  The Phoenix backend accepts the
// positional form (see `renderCodeBlock` in
// `src/generator/elixir/heex-walker.ts:1660+`), and the
// React emitter mirrors that surface — a positional first arg wins
// over a missing `source:` named arg.  Without this, a write like
// `CodeBlock { "x", language: "ts" }` silently emitted an empty
// `<code></code>` (the same source compiled on Phoenix).
//
// Renders to a `<pre><code class="language-...">...</code></pre>`
// block.  The shell template (`vite/index-html.hbs`) injects the
// highlight.js CDN tags when at least one page on the deployable uses
// CodeBlock — the walker flags that via `ctx.usesCodeBlock` and the
// React generator's orchestrator (`src/generator/react/index.ts`)
// aggregates the flag across all pages.
//
// The `source` string is rendered as JSX text inside the `<code>`
// element, so JSX-significant punctuation must be HTML-entity-escaped.
// `escapeJsxText` now handles `&` / `{` / `}` / `<` / `>` for exactly
// this case — arbitrary code text round-trips cleanly.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { renderPrimitive } from "../render-primitive.js";
import { firstPositionalText, stringNamed } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { testidAttr } from "../walker-core.js";

export function emitCodeBlock(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const language = stringNamed(call, "language") ?? "plaintext";
  // `source:` named arg wins when present; otherwise fall back to the
  // first positional string literal so the Phoenix-style call shape
  // (`CodeBlock { "...code...", language: "ts" }`) emits the same code.
  const sourceRaw = stringNamed(call, "source") ?? firstPositionalText(call) ?? "";
  const title = stringNamed(call, "title");
  // Flag the shell so it injects highlight.js once across the
  // deployable.  Pages without CodeBlock skip the CDN payload.
  ctx.usesCodeBlock = true;
  // The `<code>` block holds raw source — JSX-escape every
  // significant character so a `>` arrow, `{` brace, or `&` in the
  // code text doesn't open a JSX expression / tag at render time.
  const source = ctx.target.escapeText(sourceRaw);
  return renderPrimitive(ctx, "primitive-code-block", {
    language,
    source,
    title,
    hasTitle: title !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}
