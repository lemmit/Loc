// ---------------------------------------------------------------------------
// `typeLabel` — a compact, human-readable rendering of a `TypeIR` (`Order id`,
// `Money`, `string?`, `LineItem[]`).  Pure and platform-neutral: it reads only
// the resolved IR type shape, so it lives in `src/ir/util/` where every IR
// consumer (the UI validator's parameter-mismatch messages, the agent-tool
// `read_model` projection) can share ONE renderer rather than each hand-rolling
// its own.  Deliberately the label used in diagnostics — not target syntax.
// ---------------------------------------------------------------------------

import type { TypeIR } from "../types/loom-ir.js";

/** Render a resolved `TypeIR` as a short `.ddd`-flavoured label. */
export function typeLabel(t: TypeIR): string {
  switch (t.kind) {
    case "optional":
      return `${typeLabel(t.inner)}?`;
    case "primitive":
      return t.name;
    case "id":
      return `${t.targetName} id`;
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return `${typeLabel(t.element)}[]`;
    default:
      return t.kind;
  }
}
