import { lines } from "../util/code-builder.js";
import type {
  BoundedContextIR,
  DeployableIR,
  ModuleIR,
  SystemIR,
} from "../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// `<system>/.loom/system.mmd` artifact.
//
// A Mermaid `flowchart` projection of the system's structure, derived
// purely from the Loom IR — the same source of truth wire-spec.json
// reads.  It is a *view*, not a contract: modules group bounded
// contexts; each context shows its aggregates, value objects, events,
// and repositories; a Deployables cluster shows which modules each
// deployable includes and which backend a frontend calls.
//
// Emitted as plain Mermaid so it renders anywhere Mermaid is supported
// (the playground previews it inline; GitHub renders ```mermaid fences;
// `mmdc` produces SVG/PNG).  No DSL keyword drives this today — it is a
// derived artifact like wire-spec.json.  If curated/multiple diagrams
// are ever wanted, a `diagram { ... }` language feature would lower
// into this same emitter.
// ---------------------------------------------------------------------------

// Mermaid node ids must be identifier-safe; names carry the human text
// in the (quoted) label instead.
const idOf = (...parts: string[]): string =>
  parts.map((p) => p.replace(/[^A-Za-z0-9_]/g, "_")).join("_");

const label = (s: string): string => `"${s.replace(/"/g, "&quot;")}"`;

export function buildSystemDiagram(sys: SystemIR): string {
  return lines(
    `%% Loom system diagram — generated from the IR, do not edit by hand.`,
    `%% System: ${sys.name}`,
    `flowchart TD`,
    sys.modules.map((m) => moduleSubgraph(m)),
    deployablesCluster(sys),
    repositoryEdges(sys),
    deployableEdges(sys),
  );
}

function moduleSubgraph(m: ModuleIR): string[] {
  return [
    `  subgraph ${idOf("mod", m.name)}[${label(`📦 ${m.name}`)}]`,
    `    direction TB`,
    ...m.contexts.flatMap((c) => contextSubgraph(m, c)),
    `  end`,
  ];
}

function contextSubgraph(m: ModuleIR, c: BoundedContextIR): string[] {
  const body: string[] = [];
  for (const a of c.aggregates) body.push(`      ${aggregateId(m, c, a.name)}[${label(a.name)}]`);
  for (const v of c.valueObjects) body.push(`      ${idOf("vo", m.name, c.name, v.name)}[/${label(v.name)}/]`);
  for (const e of c.events) body.push(`      ${idOf("evt", m.name, c.name, e.name)}([${label(e.name)}])`);
  for (const r of c.repositories) body.push(`      ${idOf("repo", m.name, c.name, r.name)}[(${label(r.name)})]`);
  // An empty context still renders as a labelled box so the structure
  // is visible even before any domain types are declared.
  if (body.length === 0) body.push(`      ${idOf("ctx", m.name, c.name)}_empty[${label("(empty)")}]`);
  return [
    `    subgraph ${idOf("ctx", m.name, c.name)}[${label(c.name)}]`,
    ...body,
    `    end`,
  ];
}

function aggregateId(m: ModuleIR, c: BoundedContextIR, agg: string): string {
  return idOf("agg", m.name, c.name, agg);
}

// aggregate --> repository, for the repository's backing aggregate in
// the same context.
function repositoryEdges(sys: SystemIR): string[] {
  const out: string[] = [];
  for (const m of sys.modules) {
    for (const c of m.contexts) {
      const aggNames = new Set(c.aggregates.map((a) => a.name));
      for (const r of c.repositories) {
        if (!aggNames.has(r.aggregateName)) continue;
        out.push(
          `  ${aggregateId(m, c, r.aggregateName)} -->|repo| ${idOf("repo", m.name, c.name, r.name)}`,
        );
      }
    }
  }
  return out;
}

function deployablesCluster(sys: SystemIR): string[] {
  if (sys.deployables.length === 0) return [];
  return [
    `  subgraph deployables[${label("🚀 Deployables")}]`,
    `    direction TB`,
    ...sys.deployables.map(
      (d) => `    ${idOf("deploy", d.name)}{{${label(`${d.name} · ${d.platform}`)}}}`,
    ),
    `  end`,
  ];
}

// deployable --> each module it includes; react/frontend -.-> the
// backend deployable it calls.
function deployableEdges(sys: SystemIR): string[] {
  const out: string[] = [];
  const known = new Set(sys.deployables.map((d) => d.name));
  for (const d of sys.deployables) {
    for (const mod of d.moduleNames) {
      out.push(`  ${idOf("deploy", d.name)} --> ${idOf("mod", mod)}`);
    }
    if (d.targetName && known.has(d.targetName)) {
      out.push(`  ${idOf("deploy", d.name)} -.->|calls| ${idOf("deploy", d.targetName)}`);
    }
  }
  return out;
}

/** Serialise to a Mermaid document with a trailing newline.  Stable
 *  ordering follows the IR (source order). */
export function renderSystemDiagram(sys: SystemIR): string {
  return buildSystemDiagram(sys) + "\n";
}

// Re-export to keep system/index.ts imports decoupled from internals.
export type { DeployableIR };
