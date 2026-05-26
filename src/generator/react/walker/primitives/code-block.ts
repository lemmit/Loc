// CodeBlock primitive — syntax-highlighted code via highlight.js CDN.
//
//   CodeBlock {
//     language: "typescript",
//     source:   "aggregate Order {\n  customerId: string\n}",
//     title:    "orders.ddd"   // optional macOS-titlebar style header
//   }
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

import type { ExprIR } from "../../../../ir/loom-ir.js";
import type { WalkContext } from "../../body-walker.js";
import { testidAttr } from "../../body-walker.js";
import { renderPrimitive } from "../context.js";
import { escapeJsxText, stringNamed } from "../shared/args.js";

export function emitCodeBlock(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  const language = stringNamed(call, "language") ?? "plaintext";
  const sourceRaw = stringNamed(call, "source") ?? "";
  const title = stringNamed(call, "title");
  // Flag the shell so it injects highlight.js once across the
  // deployable.  Pages without CodeBlock skip the CDN payload.
  ctx.usesCodeBlock = true;
  // The `<code>` block holds raw source — JSX-escape every
  // significant character so a `>` arrow, `{` brace, or `&` in the
  // code text doesn't open a JSX expression / tag at render time.
  const source = escapeJsxText(sourceRaw);
  return renderPrimitive(ctx, "primitive-code-block", {
    language,
    source,
    title,
    hasTitle: title !== undefined,
    testidAttr: testidAttr(call, ctx),
  });
}
