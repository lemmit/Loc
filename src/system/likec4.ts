import type { DeployableIR, SystemIR } from "../ir/types/loom-ir.js";
import { descriptorFor } from "../platform/metadata.js";
import { lines } from "../util/code-builder.js";

// ---------------------------------------------------------------------------
// `<system>/.loom/architecture.c4` artifact — a LikeC4 model derived
// from the Loom IR (https://likec4.dev).  It complements the Mermaid
// views with a navigable C4 architecture model:
//
//   - the system as a `system` element,
//   - each deployable as a `container` (technology = its platform),
//   - the modules a deployable includes as `component`s within it,
//   - a shared `database` element when any backend deployable persists,
//   - relationships: frontend → backend ("calls"), backend → database.
//
// Like the Mermaid artifacts this is a derived view, not a contract —
// no DSL drives it.  The playground renders it in-browser by rebuilding
// the model from the sibling `.c4.json` (see `buildC4Spec` below) and
// laying it out with Graphviz WASM.  The `.c4` text also opens directly
// in the LikeC4 CLI / VS Code extension.
// ---------------------------------------------------------------------------

// Whether a deployable owns persistence — derived from the platform
// registry's `needsDb`, NOT a hand-frozen set (derive, don't stamp).
// A stamped list silently omits new DB backends: it had dropped the
// `pythonApi → db` edge because `python` was never added to it.
const persists = (d: DeployableIR): boolean => descriptorFor(d.platform).needsDb;

// A frontend deployable (React/Vue/Svelte/Angular/static SPA) inherits its
// `contextNames` from the backend it targets purely so the page emitter has
// every aggregate's wire shape in scope (enrichment #4).  That is NOT domain
// ownership: the bounded contexts live in the backend, and the SPA's only
// architectural relationship is the `calls` edge to it.  So artifacts must not
// portray a frontend as *owning* (component) or *serving* those contexts —
// that was the false "claims contexts it never touches" claim.
const isFrontend = (d: DeployableIR): boolean => descriptorFor(d.platform).isFrontend;

// LikeC4 identifiers: word chars, not starting with a digit.
function cid(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

const quote = (s: string): string => `'${s.replace(/'/g, "\\'")}'`;

export function buildC4Model(sys: SystemIR): string {
  const sysId = cid(sys.name);
  const hasBackend = sys.deployables.some((d) => persists(d));
  const known = new Set(sys.deployables.map((d) => d.name));

  const containers = sys.deployables.flatMap((d) => container(d));

  const rels: string[] = [];
  for (const d of sys.deployables) {
    if (d.targetName && known.has(d.targetName)) {
      rels.push(`    ${cid(d.name)} -> ${cid(d.targetName)} 'calls'`);
    }
    if (persists(d) && hasBackend) {
      rels.push(`    ${cid(d.name)} -> db 'reads / writes'`);
    }
  }

  return lines(
    `// Loom architecture model (LikeC4) — generated from the IR, do not edit by hand.`,
    `// System: ${sys.name}`,
    ``,
    `specification {`,
    `  element system`,
    `  element container`,
    `  element component`,
    `  element database`,
    `}`,
    ``,
    `model {`,
    `  ${sysId} = system ${quote(sys.name)} {`,
    `    description 'Loom-generated system'`,
    containers,
    hasBackend ? `    db = database 'PostgreSQL'` : null,
    rels.length > 0 ? `` : null,
    rels,
    `  }`,
    `}`,
    ``,
    `views {`,
    `  view index {`,
    `    title ${quote(`${sys.name} — landscape`)}`,
    `    include *`,
    `  }`,
    `  view of ${sysId} {`,
    `    title ${quote(`${sys.name} — containers`)}`,
    `    include *`,
    `  }`,
    `}`,
  );
}

function container(d: DeployableIR): string[] {
  // Contexts appear as internal components only for the deployable that owns
  // the domain (a backend).  A frontend's inherited context set is wire-scope,
  // not ownership — it contributes no components (its `calls` edge carries the
  // whole relationship).
  const components = isFrontend(d)
    ? []
    : d.contextNames.map((m) => `      ${cid(m)} = component ${quote(m)}`);
  return [
    `    ${cid(d.name)} = container ${quote(d.name)} {`,
    `      technology ${quote(d.platform)}`,
    ...components,
    `    }`,
  ];
}

/** Serialise to a LikeC4 document with a trailing newline. */
export function renderC4Model(sys: SystemIR): string {
  return buildC4Model(sys) + "\n";
}

// ---------------------------------------------------------------------------
// Structured projection of the same model, for the playground's in-browser
// renderer.  The `.c4` text opens in the LikeC4 CLI / VS Code; the playground
// can't run the Langium parser, so it rebuilds the model from this JSON via
// LikeC4's programmatic Builder (see web/src/preview/likec4-model.ts).  Both
// projections derive from the IR so they stay in step.
// ---------------------------------------------------------------------------

export type C4Kind = "system" | "container" | "component" | "database";

export interface C4SpecNode {
  /** Id local to the parent; the full dotted FQN is rebuilt by nesting. */
  localId: string;
  kind: C4Kind;
  title: string;
  technology?: string;
  children: C4SpecNode[];
}

export interface C4Relationship {
  /** Full dotted FQNs, matching the nested element ids. */
  source: string;
  target: string;
  label: string;
}

export interface C4Spec {
  systemTitle: string;
  /** The system element, with containers / components / database nested under it. */
  root: C4SpecNode;
  relationships: C4Relationship[];
  /** Id of the view the playground renders, scoped to the system. */
  viewId: string;
  /** FQN the rendered view is `view of`. */
  viewOf: string;
  /** Human-readable title shown in the renderer's view panel. */
  viewTitle: string;
}

export function buildC4Spec(sys: SystemIR): C4Spec {
  const sysId = cid(sys.name);
  const hasBackend = sys.deployables.some((d) => persists(d));
  const known = new Set(sys.deployables.map((d) => d.name));

  const children: C4SpecNode[] = sys.deployables.map((d) => ({
    localId: cid(d.name),
    kind: "container",
    title: d.name,
    technology: d.platform,
    // Frontends contribute no context components (wire-scope, not ownership).
    children: isFrontend(d)
      ? []
      : d.contextNames.map((m) => ({
          localId: cid(m),
          kind: "component" as const,
          title: m,
          children: [],
        })),
  }));
  if (hasBackend) {
    children.push({ localId: "db", kind: "database", title: "PostgreSQL", children: [] });
  }

  const relationships: C4Relationship[] = [];
  for (const d of sys.deployables) {
    const from = `${sysId}.${cid(d.name)}`;
    if (d.targetName && known.has(d.targetName)) {
      relationships.push({ source: from, target: `${sysId}.${cid(d.targetName)}`, label: "calls" });
    }
    if (persists(d) && hasBackend) {
      relationships.push({ source: from, target: `${sysId}.db`, label: "reads / writes" });
    }
  }

  return {
    systemTitle: sys.name,
    root: { localId: sysId, kind: "system", title: sys.name, children },
    relationships,
    viewId: "containers",
    viewOf: sysId,
    viewTitle: `${sys.name} — containers`,
  };
}

/** Serialise the structured projection as pretty JSON with a trailing newline. */
export function renderC4SpecJson(sys: SystemIR): string {
  return JSON.stringify(buildC4Spec(sys), null, 2) + "\n";
}
