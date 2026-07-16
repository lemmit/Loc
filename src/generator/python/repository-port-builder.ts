// ---------------------------------------------------------------------------
// Domain-owned repository PORTS (Python / FastAPI — audit S7).
//
// The generated domain layer must not import the concrete infra repository.
// Each aggregate gets a domain-side PORT — a `typing.Protocol` — pooled into
// one `app/domain/repository_ports.py` file (the pooling convention
// `app/domain/ids.py` / `app/domain/value_objects.py` already use).  The
// domain SERVICE (`app/domain/services/<svc>.py`) type-annotates its
// read-port parameters against the Protocol — never the concrete
// `app.db.repositories.*` class — so the one backward edge into
// infrastructure is gone.  Java models this exactly (a domain-package
// `interface <Agg>Repository`); this brings the Python backend to parity.
//
// Because Protocols are STRUCTURAL, the concrete repository needs no explicit
// inheritance — the orchestrating workflow passes the concrete
// `<Agg>Repository`, and `mypy --strict` proves it satisfies the Protocol at
// the call site (the Python analogue of a compile-checked `implements`).  So
// the concrete repo files are UNCHANGED (byte-identical → runtime unchanged).
//
// The port is ORM-neutral BY CONSTRUCTION: it is derived from the concrete
// repo's PUBLIC async method headers, which name only domain types
// (`<Agg>`, `<Agg>Id`, value objects, `User`) — no SQLAlchemy vocabulary ever
// appears in a public signature.  Presentation (`to_wire`, a non-`async`
// method) and internal helpers (`_hydrate*`, `record_audit`) are excluded.
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";

/** Pooled port module path + import spec. */
export const PORT_POOL_PATH = "app/domain/repository_ports.py";
export const PORT_POOL_MODULE = "app.domain.repository_ports";

/** The Protocol name for an aggregate — distinct from the concrete
 *  `<Agg>Repository` class so both can be referenced without collision. */
export function repoPortName(aggName: string): string {
  return `${aggName}RepositoryPort`;
}

/** One aggregate's contribution to the pooled port file. */
export interface RepoPortSpec {
  aggName: string;
  /** Protocol member lines (4-space indented, `async def … : ...`). */
  members: string[];
}

// A public async class method at exactly 4-space indent:
//   `    async def find_by_id(self, id: AccountId) -> Account | None:`
// Excludes: `def to_wire` (not async), `async def _hydrate*` (underscore),
// and `record_audit` (an internal audit helper, denylisted below).
const PORT_HEADER_RE = /^ {4}async def ([A-Za-z0-9_]+)\((.*)\)\s*->\s*(.+):$/;
const EXCLUDED_METHODS = new Set(["record_audit"]);

/** Derive Protocol member signatures by scanning a concrete repository file's
 *  source for its public `async def` method headers — appends `: ...` (an
 *  ellipsis body).  ORM-neutral by construction; presentation / internal
 *  helpers are excluded. */
export function portMembersFromSource(src: string): string[] {
  const members: string[] = [];
  for (const line of src.split("\n")) {
    const match = line.match(PORT_HEADER_RE);
    if (!match) continue;
    const [, name, params, ret] = match;
    if (name.startsWith("_") || EXCLUDED_METHODS.has(name)) continue;
    members.push(`    async def ${name}(${params}) -> ${ret}: ...`);
  }
  return members;
}

/** Render the pooled `app/domain/repository_ports.py`, or `undefined` when
 *  there are no ports.  Imports are narrowed to the domain types the member
 *  signatures reference (no unused import → clean `ruff`/`mypy --strict`). */
export function renderRepositoryPortsFile(
  specs: readonly RepoPortSpec[],
  ctx: EnrichedBoundedContextIR,
): string | undefined {
  const nonEmpty = specs.filter((s) => s.members.length > 0);
  if (nonEmpty.length === 0) return undefined;

  const allMembers = nonEmpty.flatMap((s) => s.members).join("\n");
  const scan = allMembers.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);

  // Strongly-typed id names referenced (`AccountId`, `OrderId`, …) — all live
  // in `app.domain.ids`.  Cross-check the regex hits against the ids ACTUALLY
  // declared there (`app/domain/ids.py` is `<Aggregate>Id` / `<Part>Id`, one
  // per aggregate + part — see `renderPyIds`): a value object or enum named
  // `…Id` lives in `app.domain.value_objects`, not `app.domain.ids`, so
  // harvesting every `*Id` token would import it from the wrong module →
  // `ImportError` at load.  The filter keeps only real id types.
  const declaredIdNames = new Set<string>();
  for (const a of ctx.aggregates) {
    declaredIdNames.add(`${a.name}Id`);
    for (const p of a.parts) declaredIdNames.add(`${p.name}Id`);
  }
  const idNames = [...new Set(scan.match(/\b[A-Z][A-Za-z0-9]*Id\b/g) ?? [])]
    .filter((n) => declaredIdNames.has(n))
    .sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const aggNames = nonEmpty
    .map((s) => s.aggName)
    .filter(refersTo)
    .sort();

  return (
    lines(
      `"""Domain-owned repository ports (hexagonal architecture — audit S7).`,
      "",
      "Auto-generated by Loom.",
      `"""`,
      "",
      refersTo("Sequence") ? "from collections.abc import Sequence" : null,
      refersTo("datetime") ? "from datetime import datetime" : null,
      refersTo("Decimal") ? "from decimal import Decimal" : null,
      "from typing import Protocol",
      refersTo("Sequence") || refersTo("datetime") || refersTo("Decimal") ? "" : null,
      refersTo("User") ? "from app.auth.user import User" : null,
      refersTo("PagedResult") ? "from app.domain.paging import PagedResult" : null,
      idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
      voEnumNames.length > 0
        ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
        : null,
      ...aggNames.map((n) => `from app.domain.${snake(n)} import ${n}`),
      "",
      "",
      ...nonEmpty.flatMap((s, i) => [
        ...(i > 0 ? [""] : []),
        `class ${repoPortName(s.aggName)}(Protocol):`,
        ...s.members,
      ]),
      "",
    ).trimEnd() + "\n"
  );
}
