import type { EnrichedAggregateIR, OperationIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake, upperFirst } from "../../util/naming.js";
import { emptyPyTypeImports, visitPyTypeImports } from "./py-type-imports.js";
import { renderPyType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Extern operation handlers — `app/domain/<snake(agg)>_handlers.py`
// (docs/extern.md), the Python port of Hono's `domain/<agg>-extern.ts`:
//
//   - One TypedDict request shape + handler type alias + module-global
//     slot + `register_<op>_<agg>_handler` per extern operation.
//   - `verify_<agg>_extern_handlers_registered()` — the lifespan calls
//     it at boot so a missing registration surfaces as a clear error.
//   - A no-op dev-stub registers at import so a fresh project boots;
//     the user's real registration overwrites it.
//
// Routes import the MODULE (not the slot) and read
// `<agg>_handlers.<op_snake>` at request time, so late registration is
// observed.  The framework owns the lifecycle around the dispatch:
// load → `check_<op>` (preconditions) → handler → `assert_invariants`
// → save; non-domain handler errors wrap into ExternHandlerError (500).
// ---------------------------------------------------------------------------

export function externOpsOf(agg: EnrichedAggregateIR): OperationIR[] {
  return agg.operations.filter((op) => op.extern && op.visibility === "public");
}

export function buildPyExternHandlersFile(agg: EnrichedAggregateIR): string | null {
  const ops = externOpsOf(agg);
  if (ops.length === 0) return null;

  const types = emptyPyTypeImports();
  for (const op of ops) {
    for (const p of op.params) visitPyTypeImports(p.type, types);
  }
  const idNames = [...types.idNames].sort();
  const voEnumNames = [...types.voNames, ...types.enumNames].sort();

  const blocks = ops.map((op) => renderOpBlock(agg.name, op));
  const stubs = ops.flatMap((op) => [
    `async def _${snake(op.name)}_dev_stub(aggregate: ${agg.name}, request: ${requestName(agg.name, op)}) -> None:`,
    "    return None",
    "",
    "",
  ]);
  const stubRegs = ops.map(
    (op) => `register_${snake(op.name)}_${snake(agg.name)}_handler(_${snake(op.name)}_dev_stub)`,
  );

  return lines(
    `"""Extern operation handlers for ${agg.name} (docs/extern.md).  Auto-generated.`,
    "",
    "The framework owns the lifecycle (load, preconditions, invariants,",
    "save); your handler owns the mutation.  Register implementations at",
    "app startup, BEFORE serving — until then a no-op dev-stub keeps the",
    "project bootable.",
    '"""',
    "",
    "from collections.abc import Awaitable, Callable",
    types.usesDatetime ? "from datetime import datetime" : null,
    types.usesDecimal ? "from decimal import Decimal" : null,
    "from typing import TypedDict",
    "",
    idNames.length > 0
      ? `from app.domain.ids import ${idNames.map((n) => `${n}Id`).join(", ")}`
      : null,
    `from app.domain.${snake(agg.name)} import ${agg.name}`,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    "",
    ...blocks,
    `def verify_${snake(agg.name)}_extern_handlers_registered() -> None:`,
    ...ops.flatMap((op) => [
      `    if ${snake(op.name)} is None:`,
      "        raise RuntimeError(",
      `            "Missing extern handler for '${op.name}' on aggregate '${agg.name}'. "`,
      `            "Register one via register_${snake(op.name)}_${snake(agg.name)}_handler(...) before serving."`,
      "        )",
    ]),
    "",
    "",
    ...stubs,
    "# Dev-stub registrations — the user's real handlers overwrite these.",
    ...stubRegs,
    "",
  );
}

function requestName(aggName: string, op: OperationIR): string {
  return `${upperFirst(op.name)}${aggName}Request`;
}

function renderOpBlock(aggName: string, op: OperationIR): string {
  const req = requestName(aggName, op);
  const opSnake = snake(op.name);
  return lines(
    `class ${req}(TypedDict):`,
    op.params.length > 0
      ? op.params.map((p) => `    ${snake(p.name)}: ${renderPyType(p.type)}`)
      : ["    pass"],
    "",
    "",
    `${upperFirst(op.name)}${aggName}Handler = Callable[[${aggName}, ${req}], Awaitable[None]]`,
    "",
    `${opSnake}: ${upperFirst(op.name)}${aggName}Handler | None = None`,
    "",
    "",
    `def register_${opSnake}_${snake(aggName)}_handler(fn: ${upperFirst(op.name)}${aggName}Handler) -> None:`,
    `    """Register the ${op.name} handler.  Calling more than once overwrites."""`,
    `    global ${opSnake}`,
    `    ${opSnake} = fn`,
    "",
    "",
  );
}
