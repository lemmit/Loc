// The `.loom/` bundle, as views (M-T8.20 slice 1).
//
// `generate system` already emits a documentation bundle beside the code —
// five mermaid diagrams, a LikeC4 model, four traceability reports, a wire
// spec, an AsyncAPI document (`docs/loom-artifacts.md`).  Until now the
// playground showed them the only way it shows anything generated: as rows in
// a file tree, sorted first because their folder starts with a dot.
//
// This module is the pure half of turning them into VIEWS.  It answers "which
// artifacts exist in this generate, what do we call them, and in what order" —
// nothing more.  The rendering is the existing `preview/doc-viewers.tsx`
// (mermaid → SVG, markdown → HTML); the files stay browsable under
// *Generated* exactly as before.  Deliberately re-derives nothing: every entry
// here is a file the build worker already produced.

import type { ApiOperationView, VirtualFile } from "../build/protocol.js";
import { DIAGRAMS, TRACEABILITY_VIEW } from "../layout/vocabulary.js";

/** One `.loom/` artifact, named for a human. */
export interface LoomDoc {
  /** Full generated path, e.g. `.loom/er.mmd` — what the viewer opens. */
  path: string;
  /** Basename, the key the label tables are written against. */
  name: string;
  label: string;
  blurb?: string;
  content: string;
}

const LOOM_PREFIX = ".loom/";

/** Diagram order — most-asked-first, not alphabetical: the domain model and
 *  the ER diagram are what a reader opens; deployment is what they check
 *  last. */
const DIAGRAM_ORDER = [
  "domain.mmd",
  "er.mmd",
  "workflows.mmd",
  "sequence.mmd",
  "deployment.mmd",
  "traceability.mmd",
];

/** Report order, same principle: the narrative report, then coverage, then
 *  the two reference tables. */
const REPORT_ORDER = [
  "traceability.md",
  "coverage.md",
  "gaps.md",
  "traceability-matrix.md",
  "datasources.md",
];

/** Every `.loom/*.mmd` in this generate, in reading order.  A diagram the
 *  emitter does not produce for this source is simply absent — never a row
 *  that opens an empty viewer. */
export function diagramDocs(files: readonly VirtualFile[]): LoomDoc[] {
  return loomDocs(files, ".mmd", DIAGRAM_ORDER, DIAGRAMS.label, DIAGRAMS.blurb);
}

/** Every rendered `.loom/*.md` report in this generate. */
export function traceabilityDocs(files: readonly VirtualFile[]): LoomDoc[] {
  return loomDocs(files, ".md", REPORT_ORDER, TRACEABILITY_VIEW.label, {});
}

function loomDocs(
  files: readonly VirtualFile[],
  extension: string,
  order: readonly string[],
  labels: Record<string, string>,
  blurbs: Record<string, string>,
): LoomDoc[] {
  const out: LoomDoc[] = [];
  for (const file of files) {
    if (!file.path.startsWith(LOOM_PREFIX)) continue;
    if (!file.path.endsWith(extension)) continue;
    // `.loom/snapshots/**` is provenance data, not a view.
    const name = file.path.slice(LOOM_PREFIX.length);
    if (name.includes("/")) continue;
    out.push({
      path: file.path,
      name,
      label: labels[name] ?? name,
      ...(blurbs[name] ? { blurb: blurbs[name] } : {}),
      content: file.content,
    });
  }
  out.sort((a, b) => rank(order, a.name) - rank(order, b.name) || a.name.localeCompare(b.name));
  return out;
}

function rank(order: readonly string[], name: string): number {
  const i = order.indexOf(name);
  return i < 0 ? order.length : i;
}

/** One aggregate's HTTP surface — the API view's unit. */
export interface OperationGroup {
  /** `Products.Product` — context-qualified, because two contexts may each
   *  declare an aggregate of the same name. */
  key: string;
  context: string;
  aggregate: string;
  operations: ApiOperationView[];
}

/** Group the derived operations by owning aggregate, preserving the
 *  derivation's own order within a group (which mirrors every backend's
 *  route-registration order — static find paths before `/{id}`). */
export function groupOperations(ops: readonly ApiOperationView[]): OperationGroup[] {
  const groups = new Map<string, OperationGroup>();
  for (const op of ops) {
    const key = `${op.context}.${op.aggregate}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, context: op.context, aggregate: op.aggregate, operations: [] };
      groups.set(key, group);
    }
    group.operations.push(op);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
