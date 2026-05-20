import { lines } from "../util/code-builder.js";
import type { DeployableIR, SystemIR } from "../ir/loom-ir.js";

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
// no DSL drives it.  The playground shows it as source today; rendering
// LikeC4 in-browser (its layout engine + Graphviz WASM) is a separate
// step.  Meanwhile the file opens directly in the LikeC4 CLI / VS Code
// extension.
// ---------------------------------------------------------------------------

// Backends that own persistence — used to wire database relationships.
const PERSISTENT: ReadonlySet<DeployableIR["platform"]> = new Set([
  "hono",
  "dotnet",
  "phoenixLiveView",
]);

// LikeC4 identifiers: word chars, not starting with a digit.
function cid(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

const quote = (s: string): string => `'${s.replace(/'/g, "\\'")}'`;

export function buildC4Model(sys: SystemIR): string {
  const sysId = cid(sys.name);
  const hasBackend = sys.deployables.some((d) => PERSISTENT.has(d.platform));
  const known = new Set(sys.deployables.map((d) => d.name));

  const containers = sys.deployables.flatMap((d) => container(d));

  const rels: string[] = [];
  for (const d of sys.deployables) {
    if (d.targetName && known.has(d.targetName)) {
      rels.push(`    ${cid(d.name)} -> ${cid(d.targetName)} 'calls'`);
    }
    if (PERSISTENT.has(d.platform) && hasBackend) {
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
  return [
    `    ${cid(d.name)} = container ${quote(d.name)} {`,
    `      technology ${quote(d.platform)}`,
    // Modules the deployable ships, as components within it.
    ...d.moduleNames.map((m) => `      ${cid(m)} = component ${quote(m)}`),
    `    }`,
  ];
}

/** Serialise to a LikeC4 document with a trailing newline. */
export function renderC4Model(sys: SystemIR): string {
  return buildC4Model(sys) + "\n";
}
