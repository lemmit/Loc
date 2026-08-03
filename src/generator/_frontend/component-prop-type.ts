// Component-prop TypeScript typing, shared by the JS-embedding frontends.
//
// A `component Badge(label: string, level: int)` emits a typed props interface
// on every JS frontend (React `interface BadgeProps`, Vue `defineProps<{…}>`,
// Svelte `$props()`), and all three emit the SAME language — so the Loom-type →
// TS-type mapping belongs in one place, exactly like the intrinsic snippet
// table in `_expr/js-intrinsics.ts`.
//
// It was not in one place, and the copies had drifted badly:
//
//   vue     `componentPropTsType`   complete — recursive, primitives/entity/
//                                   id/enum/array/optional
//   svelte  `typeRefAsTsString`     partial  — top-level primitives only
//   react   `typeRefAsTsString`     A STUB   — `void p; return "string"`
//
// So on React every non-entity, non-slot param was typed `string`, whatever it
// was declared as.  `component Badge(level: int)` produced `level: string`,
// which makes `level > 2` a TS2365 and `<Badge level={count} />` a TS2322 —
// but no example in the repo passed a non-string param to a component, so the
// per-frontend build gates never compiled the combination.
//
// This is Vue's implementation, moved verbatim (its output is byte-identical)
// and adopted by the other two.

import type { AggregateIR, ParamIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lowerFirst } from "../../util/naming.js";

/**
 * Map a Loom type to its component-prop TS spelling — the wire DTO for an
 * aggregate param (recorded into `dtoImports` so the caller can emit the
 * `import type` line), primitives / ids / enums to their TS equivalents.
 * Mirrors `_frontend/extern-functions.ts`'s `wireTsType`.
 *
 * Throws on a type with no meaningful prop spelling rather than silently
 * emitting `string` — a prop the frontend cannot type is a generation-time
 * error, not something to paper over (the failure mode this module exists to
 * end).
 */
export function componentPropTsType(
  t: TypeIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  dtoImports: Map<string, string>,
): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        case "bool":
          return "boolean";
        case "string":
        case "datetime":
        case "guid":
          return "string";
        case "json":
          return "unknown";
        default:
          throw new Error(`component prop: unsupported primitive '${t.name}'.`);
      }
    case "entity":
      if (aggregatesByName.has(t.name)) {
        dtoImports.set(`${t.name}Response`, `../api/${lowerFirst(t.name)}`);
        return `${t.name}Response`;
      }
      return "unknown";
    case "id":
      return "string";
    case "enum":
      return "string";
    case "array":
      return `${componentPropTsType(t.element, aggregatesByName, dtoImports)}[]`;
    case "optional":
      return `${componentPropTsType(t.inner, aggregatesByName, dtoImports)} | undefined`;
    default:
      throw new Error(`component prop: unsupported type kind '${t.kind}'.`);
  }
}

/**
 * Param-level wrapper — the shape a component's props interface declares for
 * one declared param.  Handles the `action` / `action(T)` callback shape
 * (Tier 2 of the extern-component escape hatch) before delegating the data
 * types to {@link componentPropTsType}.
 *
 * Moved from Vue's `paramPropType`, which was the only complete copy; React
 * checks the action shape at its own call site and Svelte silently returned
 * `string` for it.
 */
export function paramPropTsType(
  p: ParamIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  dtoImports: Map<string, string>,
): string {
  const t = p.type;
  const action =
    t.kind === "action"
      ? t
      : t.kind === "optional" && t.inner.kind === "action"
        ? t.inner
        : undefined;
  if (action) {
    return action.arg
      ? `(arg: ${componentPropTsType(action.arg, aggregatesByName, dtoImports)}) => void`
      : "() => void";
  }
  return componentPropTsType(t, aggregatesByName, dtoImports);
}
