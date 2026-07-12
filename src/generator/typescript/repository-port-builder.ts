// ---------------------------------------------------------------------------
// Domain-owned repository PORTS (hexagonal architecture — audit S7).
//
// The generated domain layer must not depend on the concrete infra
// repository.  Each aggregate's concrete `<Agg>Repository` (in
// `db/repositories/`) now `implements` a domain-side PORT interface
// `<Agg>RepositoryPort`, pooled into one `domain/repository-ports.ts`
// file (the same pooling convention `domain/ids.ts` / `domain/value-objects.ts`
// already use).  The domain SERVICE (`domain/services.ts`) type-imports the
// PORT — never the concrete class — so the one backward edge into
// infrastructure is gone.  Java models this exactly (a domain-package
// `interface <Agg>Repository` + an infra `<Agg>RepositoryImpl`); this brings
// the node backend to parity.
//
// The port is ORM-neutral BY CONSTRUCTION: it is derived from the concrete
// repo's PUBLIC method headers, which already name only domain types
// (`<Agg>`, `Ids.<Agg>Id`, value objects, `User`) — no Drizzle/`Tx`
// vocabulary ever appears in a public signature.  Presentation (`toWire`) is
// excluded (it is not part of the repository contract — audit note).
//
// Because the members are EXTRACTED from the exact strings the concrete
// emits, `implements` is guaranteed to type-check: the class literally
// carries those signatures.
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst } from "../../util/naming.js";

/** Pooled port file — a raw `out.set` domain-layer sibling of
 *  `domain/ids.ts`, so it is NOT relocated by the layout adapter (importers
 *  of it, and its own aggregate imports, are fixed up by the layout
 *  post-pass `rewriteRelativeImports`). */
export const PORT_POOL_PATH = "domain/repository-ports.ts";
/** Module specifier (extensionless) other DOMAIN files import the pooled
 *  ports by — `domain/services.ts` → `./repository-ports`. */
export const PORT_POOL_DOMAIN_SPEC = "./repository-ports";
/** Module specifier a byLayer `db/repositories/<agg>-repository.ts` imports
 *  the pooled ports by (the layout post-pass rewrites it under byFeature). */
export const PORT_POOL_REPO_SPEC = "../../domain/repository-ports";

/** The port interface name for an aggregate — distinct from the concrete
 *  `<Agg>Repository` class so the concrete file can import + `implements` it
 *  without a name collision, and the concrete class NAME stays unchanged
 *  (composition-root wiring byte-identical → runtime unchanged). */
export function repoPortName(aggName: string): string {
  return `${aggName}RepositoryPort`;
}

/** The `import type { <Agg>RepositoryPort } from "../../domain/repository-ports";`
 *  line a concrete repository file adds so it can `implements` its port. */
export function repoPortImportLine(aggName: string): string {
  return `import type { ${repoPortName(aggName)} } from "${PORT_POOL_REPO_SPEC}";`;
}

/** One aggregate's contribution to the pooled port file. */
export interface RepoPortSpec {
  aggName: string;
  /** Interface member signature lines (2-space indented, no `async`,
   *  trailing `;`). */
  members: string[];
}

// A class-method header at exactly 2-space indent: `  async foo(a): Promise<X> {`.
// This matches ONLY the public async methods of the repository class:
//   - the constructor is not `async`;
//   - `private async _loadAll()` starts with `private `, so it fails `^  async`;
//   - `toWire(...)` is not `async`;
//   - module-level serialiser functions are at 0-indent (`export function …`),
//     never `  async name(`.
// So a whole-file line scan yields exactly the port-eligible surface.
const PORT_HEADER_RE = /^ {2}async ([A-Za-z0-9_]+)\((.*)\):\s*(.+?)\s*\{$/;

/** Derive interface member signatures by scanning a concrete repository file's
 *  source for its public `async` method headers — `  async foo(a): Promise<X> {`
 *  becomes `  foo(a): Promise<X>;`.  ORM-neutral by construction (public
 *  signatures name only domain types); presentation (`toWire`) is excluded
 *  because it is not `async`. */
export function portMembersFromSource(src: string): string[] {
  const members: string[] = [];
  for (const line of src.split("\n")) {
    const match = line.match(PORT_HEADER_RE);
    if (!match) continue;
    const [, name, params, ret] = match;
    members.push(`  ${name}(${params}): ${ret};`);
  }
  return members;
}

/** Render the pooled `domain/repository-ports.ts` file from every aggregate's
 *  port spec, or `undefined` when there are none.  Imports are narrowed to the
 *  domain types the member signatures actually reference (no unused-import
 *  under the generated-code Biome/tsc gate). */
export function renderRepositoryPortsFile(
  specs: readonly RepoPortSpec[],
  ctx: EnrichedBoundedContextIR,
): string | undefined {
  const nonEmpty = specs.filter((s) => s.members.length > 0);
  if (nonEmpty.length === 0) return undefined;

  const allMembers = nonEmpty.flatMap((s) => s.members).join("\n");
  // Strip string-literal contents so a symbol mentioned only in a quoted
  // message doesn't register as a reference.
  const scan = allMembers.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''");
  const referenced = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  const usesIds = /\bIds\.\w/.test(scan);
  const usesUser = referenced("User");
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(referenced)
    .sort();
  const aggNames = nonEmpty
    .map((s) => s.aggName)
    .filter(referenced)
    .sort();

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      "// Domain-owned repository ports (hexagonal architecture — audit S7).",
      usesIds ? 'import type * as Ids from "./ids";' : null,
      usesUser ? 'import type { User } from "../auth/user-types";' : null,
      voEnumNames.length > 0
        ? `import type { ${voEnumNames.join(", ")} } from "./value-objects";`
        : null,
      ...aggNames.map((n) => `import type { ${n} } from "./${lowerFirst(n)}";`),
      "",
      ...nonEmpty.flatMap((s) => [
        `export interface ${repoPortName(s.aggName)} {`,
        ...s.members,
        "}",
        "",
      ]),
    ).trimEnd() + "\n"
  );
}
