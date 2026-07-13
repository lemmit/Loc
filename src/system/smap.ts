import type { SourceMapRegion } from "../generator/_trace/sourcemap.js";
import { offsetToLineCol } from "../generator/_trace/sourcemap.js";
import { resolveToSource } from "../ir/types/origin.js";

// ---------------------------------------------------------------------------
// JSR-45 SMAP sidecars — Milestone 10 phase 6b of docs/old/proposals/source-map-
// and-debugging.md.  Java sibling of sourcemap-v3.ts: instead of a
// browser/Node Source Map v3 JSON document, JDWP debuggers (and `javap`)
// understand the JSR-045 "Debugging support for other languages" TEXT
// format, carried on a compiled class's `SourceDebugExtension` attribute.
// This module only renders that text; attaching it to a `.class` file (via
// ASM, at Gradle build time) happens inside the GENERATED project's own
// build script — see the `injectSmap` task emitted by
// `src/generator/java/emit/program.ts`.  `src/system/` stays browser-safe:
// no `fs`, no bytecode manipulation, just string rendering — same
// discipline as `sourcemap-v3.ts`.
//
// Format (JSR-045 §3 — the shape javac/Kotlin/JSP compilers emit):
//
//     SMAP
//     <generated-file-basename>
//     Loom
//     *S Loom
//     *F
//     + <id> <source-basename>
//     <source-absolute-path>
//     *L
//     <InputStartLine>#<FileID>:<OutputStartLine>
//     *E
//
// Same narrowest-containing-region rule and honest-skip convention as
// `renderSourceMapV3`: a region survives only when its origin resolves to a
// real `.ddd` span AND that span's file has text in `sourceTexts`; if
// nothing survives, there is no sidecar (`undefined`) rather than one with
// no useful content.  Unlike v3 (0-based line/col pairs in a JSON
// mappings string), SMAP line numbers are plain 1-based integers — exactly
// what `offsetToLineCol` already returns, so no local adjustment is needed
// here (contrast v3's `- 1` at its own call site).
// ---------------------------------------------------------------------------

/** A recorded region that survived the `sourceTexts` filter, with its
 *  origin resolved to a real source span and its start converted to a
 *  1-based `.ddd` line. */
interface ResolvedRegion {
  target: [number, number];
  path: string;
  line: number;
}

/** Narrowest region covering generated line `line` — the same tie-break
 *  rule as `sourcemap-v3.ts`'s `narrowestRegion` (smallest target range
 *  wins; ties keep the earlier region).  Replicated rather than shared:
 *  each renderer stays a self-contained leaf mirroring its sibling's
 *  shape, per the brief pinning `src/system/` files independent of one
 *  another's internals. */
function narrowestRegion(
  regions: readonly ResolvedRegion[],
  line: number,
): ResolvedRegion | undefined {
  let best: ResolvedRegion | undefined;
  for (const r of regions) {
    if (line < r.target[0] || line > r.target[1]) continue;
    if (!best || r.target[1] - r.target[0] < best.target[1] - best.target[0]) best = r;
  }
  return best;
}

/** Render one JSR-45 SMAP text document from a single generated `.java`
 *  file's recorded regions.  Returns `undefined` when nothing survives the
 *  `sourceTexts` filter — an honest skip (no sidecar), mirroring
 *  `renderSourceMapV3`.
 *
 *  One `*L` entry per generated line that has a covering region, mapping
 *  it to the (1-based) `.ddd` line of that region's resolved origin span
 *  START.  Lines with no covering region get no entry.  Coalescing
 *  consecutive lines that share the same input line into a `RepeatCount`
 *  is legal JSR-45 but deliberately skipped — one entry per mapped
 *  generated line is trivially correct, and correctness beats
 *  compactness here (see the brief). */
export function renderSmap(
  regions: readonly SourceMapRegion[],
  generatedFileName: string,
  sourceTexts: ReadonlyMap<string, string>,
): string | undefined {
  const resolved: ResolvedRegion[] = [];
  for (const region of regions) {
    const source = resolveToSource(region.origin);
    if (!source) continue;
    const text = sourceTexts.get(source.path);
    if (text === undefined) continue;
    const { line } = offsetToLineCol(text, source.span.start);
    resolved.push({ target: region.target, path: source.path, line });
  }
  if (resolved.length === 0) return undefined;

  // File section: one `+ <id> <basename>` / absolute-path pair per distinct
  // source, deduped + sorted (same convention as v3's `sources`) so file
  // IDs are stable regardless of region recording order.
  const sources = [...new Set(resolved.map((r) => r.path))].sort();
  const fileIdOf = new Map(sources.map((p, i) => [p, i + 1] as const));
  const fileSection = sources.flatMap((p) => [
    `+ ${fileIdOf.get(p)} ${p.split("/").pop() ?? p}`,
    p,
  ]);

  const maxLine = Math.max(...resolved.map((r) => r.target[1]));
  const lineSection: string[] = [];
  for (let line = 1; line <= maxLine; line++) {
    const region = narrowestRegion(resolved, line);
    if (!region) continue;
    lineSection.push(`${region.line}#${fileIdOf.get(region.path)}:${line}`);
  }

  const generatedBase = generatedFileName.split("/").pop() ?? generatedFileName;
  return `${[
    "SMAP",
    generatedBase,
    "Loom",
    "*S Loom",
    "*F",
    ...fileSection,
    "*L",
    ...lineSection,
    "*E",
  ].join("\n")}\n`;
}
