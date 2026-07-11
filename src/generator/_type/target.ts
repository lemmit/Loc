// ---------------------------------------------------------------------------
// TypeTarget — the shared `TypeIR.kind` dispatcher for the backends' type
// printers.  Expression-side analogue of `src/generator/_expr/target.ts`
// (`ExprTarget` / `renderExprWith`): this file OWNS the exhaustive
// `TypeIR.kind` switch + all recursion once, and each backend supplies only a
// leaf table (`TS_TYPE_TARGET` / `CS_TYPE_TARGET` / `JAVA_TYPE_TARGET` /
// `PY_TYPE_TARGET`).  Before the extraction the same ~12-arm switch was
// hand-rolled in five places (`renderTsType` / `renderCsType` /
// `renderJavaType` + `boxedJavaType` / `renderPyType`), each carrying the
// identical `enum`/`valueobject`/`entity` → `t.name` arms and the same
// primitive-name inner switch — a new domain-logic backend now writes one
// target, not a new dispatcher.
//
// The uniform arms are handled here, never on the interface (mirrors
// `paren`/`this` on `ExprTarget`):
//   - `enum` / `valueobject` / `entity` all render `t.name` on every backend.
//   - `slot` / `action` are UI-only param markers that never reach a backend;
//     the dispatcher throws, keeping the assumption explicit.
// ---------------------------------------------------------------------------

import type { PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";

/** Boxing/position mode threaded through recursion.  `reference` marks a
 *  position that cannot hold an unboxed primitive — an array element, a
 *  nullable optional, or a generic type argument.  Only Java distinguishes the
 *  two (it boxes `int`/`long`/`bool` in reference position, `int` → `Integer`);
 *  every other backend's `primitive` leaf ignores the mode, so threading it is
 *  a no-op for TS / .NET / Python. */
export type TypeMode = "value" | "reference";

type GenericInstanceType = Extract<TypeIR, { kind: "genericInstance" }>;
type UnionType = Extract<TypeIR, { kind: "union" }>;

/**
 * Per-backend leaf formatters for the divergent `TypeIR.kind` arms.  Recursive
 * sub-parts arrive already rendered (`array` / `optional`), except the two arms
 * where a leaf branches on the raw node (`genericInstance` / `union`) and so
 * receive a `recur` that renders a sub-type in `reference` mode.
 */
export interface TypeTarget {
  /** A primitive scalar (`int`, `money`, `datetime`, …).  `mode` is
   *  `reference` when the primitive sits in a boxed position; only Java acts
   *  on it. */
  primitive(name: PrimitiveName, mode: TypeMode): string;
  /** An aggregate/entity id reference (`OrderId`); TS namespaces it `Ids.`. */
  id(targetName: string): string;
  /** A homogeneous array; `element` arrives rendered in `reference` mode. */
  array(element: string): string;
  /** An optional / nullable; `inner` arrives rendered in `reference` mode. */
  optional(inner: string): string;
  /** A carrier-bounded generic (`order paged` → `Paged<Order>`, or a
   *  monomorphized record shape on the structural TS backend).  `recur`
   *  renders a sub-type in `reference` mode. */
  genericInstance(t: GenericInstanceType, recur: (t: TypeIR) => string): string;
  /** A discriminated union (`A or B`, `T option`).  `recur` renders a sub-type
   *  in `reference` mode — used only by the structural TS backend, which
   *  inlines the tagged variants; nominal backends return the union's instance
   *  name and ignore it. */
  union(t: UnionType, recur: (t: TypeIR) => string): string;
  /** The `none` unit type — appears standalone only defensively (it normally
   *  lives inside an option's union). */
  none(): string;
}

/**
 * Dispatch a resolved `TypeIR` through a backend's `TypeTarget`.  Owns the full
 * `TypeIR.kind` switch and all recursion; the exhaustive switch makes a new
 * `kind` a compile error until handled.  `mode` defaults to `value` (the top
 * level); the dispatcher re-enters in `reference` mode for the boxed positions
 * (array element, optional inner, generic argument).
 */
export function renderTypeWith(t: TypeIR, target: TypeTarget, mode: TypeMode = "value"): string {
  const recur = (x: TypeIR): string => renderTypeWith(x, target, "reference");
  switch (t.kind) {
    case "primitive":
      return target.primitive(t.name, mode);
    case "id":
      return target.id(t.targetName);
    case "enum":
    case "valueobject":
    case "entity":
      return t.name;
    case "array":
      return target.array(recur(t.element));
    case "optional":
      return target.optional(recur(t.inner));
    case "action":
    case "slot":
      throw new Error(
        "renderTypeWith: 'slot'/'action' type is UI-only and should not reach a backend.",
      );
    case "genericInstance":
      return target.genericInstance(t, recur);
    case "union":
      return target.union(t, recur);
    case "none":
      return target.none();
  }
}
