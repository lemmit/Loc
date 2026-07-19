import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// `app/domain/ids.py` — NewType-branded str ids, one per aggregate and
// per part, plus a `new_<name>_id()` uuid4 factory each.  The Python
// analogue of the TS branded-string ids.
// ---------------------------------------------------------------------------

export function renderPyIds(
  ctx: BoundedContextIR,
  /** Foreign id brands (M-T4.4): id targets referenced by broker-consumed
   *  foreign events / correlating workflow state whose owning aggregate this
   *  deployable doesn't host.  Mirrors the Hono `renderIds` extra param. */
  extraIdNames: readonly string[] = [],
): string {
  const names: string[] = [];
  for (const a of ctx.aggregates) {
    names.push(a.name);
    for (const p of a.parts) names.push(p.name);
  }
  for (const n of extraIdNames) if (!names.includes(n)) names.push(n);
  return lines(
    `"""Branded id types — one NewType per aggregate / part.  Auto-generated."""`,
    "",
    "from typing import NewType",
    "from uuid6 import uuid7",
    "",
    names.map((name) => `${name}Id = NewType("${name}Id", str)`),
    "",
    names.flatMap((name) => [
      "",
      `def new_${snake(name)}_id() -> ${name}Id:`,
      `    return ${name}Id(str(uuid7()))`,
      "",
    ]),
  );
}
