// Preview select mode: `data-testid` → the `.ddd` declaration that renders it
// (M-T8.20 slice 4).
//
// The click happens inside the preview iframe, where the only durable handle
// on an element is the `data-testid` the generated pages stamp on every
// primitive.  Turning that back into a page is a two-step walk over data the
// playground already has:
//
//   1. WHICH FILE emits the id?  The generated tree is right here — find the
//      page file whose source contains the id as a string literal.  Matching
//      the emitted TEXT (rather than reproducing the walker's id-derivation
//      rules) means this keeps working for every design pack and every
//      frontend framework, and cannot drift from what actually shipped.
//   2. WHICH DECLARATION produced that file?  `.loom/sourcemap.json` already
//      answers that — the same reverse lookup the correspondence hover uses.
//
// Pure: no React, no DOM, no worker.

import { sourceSpanFor } from "./correspondence.js";
import type { LoomSourceMap, VirtualFile } from "./protocol.js";

export interface SelectTarget {
  /** The `data-testid` that was clicked. */
  testid: string;
  /** Generated page file that emits it. */
  file: string;
  /** Dotted construct id — `WebApp.products.List`. */
  construct?: string;
  /** `.ddd` path + 1-based line range of the declaration, when the sourcemap
   *  resolved the file (absent for a page the recorder did not map). */
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  /** 1-based line in the GENERATED file where the id appears — what the
   *  reverse lookup was made at, and a useful thing to reveal. */
  generatedLine: number;
}

/** Page files, by framework.  A `data-testid` also appears in the emitted
 *  Playwright page objects and the smoke spec; those are test scaffolding,
 *  not the thing that renders it, so the page directories are matched
 *  explicitly rather than searching the whole tree. */
function isPageFile(path: string): boolean {
  if (!path.includes("/src/pages/")) return false;
  return (
    path.endsWith(".tsx") ||
    path.endsWith(".vue") ||
    path.endsWith(".svelte") ||
    path.endsWith(".ts") ||
    path.endsWith(".html") ||
    path.endsWith(".heex") ||
    path.endsWith(".ex")
  );
}

/**
 * Resolve a clicked `data-testid` to the generated page and the `.ddd`
 * declaration behind it.
 *
 * Returns `null` when no generated page emits the id — which is the honest
 * answer for a testid coming from a design pack's own chrome, or from an
 * element the preview is showing after the source moved on.  When several
 * pages emit the same id (a shared component), the first in path order wins
 * and the caller can still see which file it picked.
 */
export function resolveTestId(
  files: readonly VirtualFile[],
  map: LoomSourceMap | null,
  testid: string,
  dddSourceText?: string,
): SelectTarget | null {
  if (!testid) return null;
  // Match the emitted attribute, not a bare substring: `data-testid="x"`
  // must not be found by searching for `x` inside a longer id.
  const needles = [`"${testid}"`, `'${testid}'`];
  const candidates = files
    .filter((f) => isPageFile(f.path))
    .filter((f) => needles.some((n) => f.content.includes(n)))
    .sort((a, b) => a.path.localeCompare(b.path));
  const page = candidates[0];
  if (!page) return null;

  const lines = page.content.split("\n");
  const generatedLine =
    lines.findIndex((l) => needles.some((n) => l.includes(n))) + 1 || 1;

  const target: SelectTarget = { testid, file: page.path, generatedLine };
  if (!map) return target;
  const back = sourceSpanFor(map, page.path, generatedLine, undefined, dddSourceText);
  if (!back) return target;
  target.construct = back.construct;
  target.sourcePath = back.path;
  target.sourceLine = back.startLine;
  target.sourceEndLine = back.endLine;
  return target;
}

/** The node path an agent prompt names — `WebApp.products.List` when the
 *  sourcemap resolved a construct, else the page file. */
export function selectNodePath(target: SelectTarget): string {
  return target.construct ?? target.file;
}
