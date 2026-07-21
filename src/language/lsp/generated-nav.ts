// "Go to generated code" — pure logic (M6 phase 3, forward direction only;
// reverse nav from generated code back to `.ddd` is a follow-up, out of
// scope here). No LSP/fs coupling, so it's unit-testable without a running
// language server and safe to import from the browser bundle.
// `ddd-implementation.ts` supplies the LSP glue: cursor → offset, map
// discovery on the filesystem, Location conversion.
//
// Construct ids mirror the generator's own `construct:` strings recorded
// into `.loom/sourcemap.json` — `${ctx.name}.${agg.name}` /
// `${ctx.name}.${agg.name}.${op.name}` (all five backends),
// `${ctx.name}.${wf.name}` (dotnet workflow files only; see
// src/generator/dotnet/workflow-emit.ts). This
// file must stay in sync with those call sites, not invent its own scheme.
// dotnet's `${ctx.name}.${base.name}` TPC-scaffolding construct is
// deliberately NOT recognised here — scaffolding bases have no dedicated
// `.ddd` construct to jump FROM.

import { type AstNode, AstUtils, CstUtils, type LangiumDocument } from "langium";
import type { SourceMap, WireOriginRef } from "../../trace/index.js";
import { matchPath } from "../../trace/index.js";
import { snake } from "../../util/naming.js";
import {
  isAggregate,
  isArea,
  isBoundedContext,
  isComponent,
  isOperation,
  isPage,
  isUi,
  isWorkflow,
} from "../generated/ast.js";

/** Innermost-first construct ids the cursor at `offset` sits inside, or
 *  undefined when it names none of the constructs the generators record
 *  (value objects and events have no construct-granular sourcemap
 *  entries). When the cursor is inside an operation body, both the
 *  operation id AND its owning aggregate id are returned (narrowest
 *  first) — the aggregate's whole-file region is a valid, if coarser,
 *  jump target too. */
export function constructIdAt(document: LangiumDocument, offset: number): string[] | undefined {
  const root = document.parseResult?.value?.$cstNode;
  if (!root) return undefined;
  const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
  const node = leaf?.astNode;
  if (!node) return undefined;

  const op = AstUtils.getContainerOfType(node, isOperation);
  if (op) {
    const agg = AstUtils.getContainerOfType(op, isAggregate);
    const ctx = agg && AstUtils.getContainerOfType(agg, isBoundedContext);
    if (agg && ctx) return [`${ctx.name}.${agg.name}.${op.name}`, `${ctx.name}.${agg.name}`];
  }

  const agg = AstUtils.getContainerOfType(node, isAggregate);
  if (agg) {
    const ctx = AstUtils.getContainerOfType(agg, isBoundedContext);
    if (ctx) return [`${ctx.name}.${agg.name}`];
  }

  const wf = AstUtils.getContainerOfType(node, isWorkflow);
  if (wf) {
    const ctx = AstUtils.getContainerOfType(wf, isBoundedContext);
    if (ctx) return [`${ctx.name}.${wf.name}`];
  }

  // Pages/components (M8 frontend bracket): recorded as
  // `<ui>.<area path…>.<page>` / `<ui>.<component>` — the same id
  // `pageConstructId` (src/ir/util/page-kind.ts) mints at recording time,
  // INLINED here because `language/` may not import `ir/` (pipeline
  // layering). Only hand-written declarations are reachable: a scaffolded
  // page is synthesized with no CST, so a cursor can never sit inside one.
  const page = AstUtils.getContainerOfType(node, isPage);
  if (page) {
    const ui = AstUtils.getContainerOfType(page, isUi);
    if (ui) return [[ui.name, ...areaPathOf(page), page.name].join(".")];
  }

  const component = AstUtils.getContainerOfType(node, isComponent);
  if (component) {
    // A top-level component (declared outside any ui) is recorded under
    // each CONSUMING ui's name — unknowable from the declaration alone, so
    // it stays unreachable here (honest skip, not a guess).
    const ui = AstUtils.getContainerOfType(component, isUi);
    if (ui) return [`${ui.name}.${component.name}`];
  }

  return undefined;
}

/** Names of the `area` blocks enclosing `page`, outermost first — the
 *  `$container` chain between the page and its ui, `snake()`d per segment
 *  because that is what lowering stores on `PageIR.area`
 *  (src/ir/lower/lower-ui.ts, the `area` containment walk) and therefore
 *  what `pageConstructId` recorded into the map. */
function areaPathOf(page: AstNode): string[] {
  const path: string[] = [];
  for (let n = page.$container; n && isArea(n); n = n.$container) {
    path.unshift(snake(n.name));
  }
  return path;
}

/** One hit: a mapped output file (relative to the map's root) plus the
 *  1-based inclusive [startLine, endLine] target range `construct`
 *  recorded there. */
export interface ConstructRegionHit {
  file: string;
  target: [number, number];
}

/** True when `origin`'s chain touches a `source` leaf whose recorded
 *  `.ddd` path matches `docPath` (longest-suffix rule — see `matchPath`).
 *  Walks through `macro`/`derived` wrappers to their leaf source ref(s),
 *  mirroring `resolveToSource` (src/ir/types/origin.ts) without importing
 *  it: `language/` may not value-import `ir/` (pipeline-layering.test.ts),
 *  and the wire shape here already carries plain path strings, so a tiny
 *  local walk is cheaper than threading the IR type through. */
function originTouchesDoc(origin: WireOriginRef, docPath: string): boolean {
  switch (origin.kind) {
    case "source":
      return matchPath(docPath, [origin.path]) !== undefined;
    case "macro":
      if (matchPath(docPath, [origin.call.path]) !== undefined) return true;
      return origin.inner ? originTouchesDoc(origin.inner, docPath) : false;
    case "derived":
      return origin.from ? originTouchesDoc(origin.from, docPath) : false;
  }
}

/** Regions recorded under the FIRST id in `ids` (narrowest-first) that has
 *  any match — never mixes op- and aggregate-level results together —
 *  restricted to regions whose origin resolves back to `docPath`. Dedups
 *  identical (file, target) pairs; stable order: file key sorted, then
 *  target start. */
export function regionsForConstruct(
  map: SourceMap,
  ids: readonly string[],
  docPath: string,
): ConstructRegionHit[] {
  for (const id of ids) {
    const hits: ConstructRegionHit[] = [];
    for (const file of Object.keys(map.files).sort()) {
      for (const region of map.files[file] ?? []) {
        if (region.construct !== id) continue;
        if (!originTouchesDoc(region.origin, docPath)) continue;
        hits.push({ file, target: region.target });
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => (a.file === b.file ? a.target[0] - b.target[0] : a.file < b.file ? -1 : 1));
    const deduped: ConstructRegionHit[] = [];
    for (const h of hits) {
      const prev = deduped[deduped.length - 1];
      if (
        prev &&
        prev.file === h.file &&
        prev.target[0] === h.target[0] &&
        prev.target[1] === h.target[1]
      ) {
        continue;
      }
      deduped.push(h);
    }
    return deduped;
  }
  return [];
}
