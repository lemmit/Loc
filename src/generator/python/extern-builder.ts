import type { AggregateIR, OperationIR } from "../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../util/scaffold-once.js";
import { emptyPyTypeImports, visitPyTypeImports } from "./py-type-imports.js";
import { renderPyType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Extern operation seam — the Python domain extension point (extern (b)
// Phase 2, docs/extern.md), the Python sibling of the Elixir analog
// (src/generator/elixir/vanilla/extern-emit.ts, #1841).
//
// An `operation X() extern { precondition … }` declares case-1 business logic
// the DSL can't express: the body carries only preconditions, and the mutation
// is HAND-WRITTEN by the user.  Before this slice the mutation lived in an
// INJECTED, application-layer per-op handler registry — a typed request shape,
// a module-global handler slot, `register_<op>_<agg>_handler`, a boot-time
// `verify_..._registered` check, and per-field setters minted on the aggregate
// so the external holder could mutate it.  That whole apparatus is deleted.
//
// The re-home: the aggregate's `X()` op becomes a REAL method (preconditions →
// hook → invariants) that delegates the mutation to a user-owned, scaffold-once
// hook FUNCTION receiving the aggregate.  Because the function receives the
// aggregate directly, it reaches the aggregate's own private/name-mangled state
// natively (`order._status = …`, `order.raise_event(…)`) — no per-field setters,
// no external write surface.  A missing implementation `raise`s loudly
// (`NotImplementedError`), never the old silent success.
//
//   * one MODULE per aggregate with an extern op:
//       `app/domain/extern/<agg>_extern.py` — one `def <op>(<agg>, …)` per
//       extern op, each raising `NotImplementedError` until filled in.  It
//       carries the `loom:scaffold-once` marker so `ddd generate system`
//       re-runs PRESERVE the user's filled-in implementation (see
//       `src/util/scaffold-once.ts`); the path is DETERMINISTIC and stable.
//
// The aggregate imports the module and its op body calls
// `<agg>_extern.<op>(self, …)`; the framework flow the proposal keeps (load →
// preconditions → hook → invariants → save → drain) is driven by the ordinary
// operation route + repository, exactly like a non-extern void op.
// ---------------------------------------------------------------------------

/** The extern operations of an aggregate (public only — the ops this seam
 *  handles; CRUD-reserved names never carry `extern`). */
export function externOpsOf(agg: AggregateIR): OperationIR[] {
  return agg.operations.filter((op) => op.extern && op.visibility === "public");
}

/** Does the aggregate declare at least one extern operation? */
export function aggHasExternOp(agg: AggregateIR): boolean {
  return externOpsOf(agg).length > 0;
}

/** The user-owned hook module path (`out.set` key, minus the project prefix).
 *  DETERMINISTIC and stable forever — a rename orphans the user's code. */
export function externHookModulePath(aggName: string): string {
  return `app/domain/extern/${snake(aggName)}_extern.py`;
}

/** The name the aggregate imports the hook module under
 *  (`from app.domain.extern import <agg>_extern`). */
export function externHookModuleName(aggName: string): string {
  return `${snake(aggName)}_extern`;
}

/** The call the aggregate's op method makes into the hook, e.g.
 *  `order_extern.confirm(self, score)`. */
export function externHookCall(aggName: string, op: OperationIR): string {
  const args = [
    "self",
    ...op.params.map((p) => snake(p.name)),
    ...(operationUsesCurrentUser(op) ? ["current_user"] : []),
  ];
  return `${externHookModuleName(aggName)}.${snake(op.name)}(${args.join(", ")})`;
}

/** Build the scaffold-once user-owned hook module for an aggregate that
 *  declares at least one extern op, or `null` when it has none (byte-identical
 *  output for the common case). */
export function buildPyExternHookModule(agg: AggregateIR): string | null {
  const ops = externOpsOf(agg);
  if (ops.length === 0) return null;

  const aggParam = snake(agg.name);
  const usesUser = ops.some(operationUsesCurrentUser);

  // TYPE_CHECKING imports the signature's names (the aggregate itself, plus any
  // id / value-object / enum param types).  `from __future__ import
  // annotations` makes every annotation a string, so nothing is imported at
  // runtime — the hook only touches attributes on the passed-in aggregate, and
  // the module deliberately does NOT import the aggregate at runtime (the
  // aggregate imports IT), so there is no import cycle.
  const types = emptyPyTypeImports();
  for (const op of ops) for (const p of op.params) visitPyTypeImports(p.type, types);
  const idNames = [...types.idNames].sort();
  const voEnumNames = [...types.voNames, ...types.enumNames].sort();

  const fns = ops.map((op) => {
    const params = [
      `${aggParam}: ${agg.name}`,
      ...op.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`),
      ...(operationUsesCurrentUser(op) ? ["current_user: User"] : []),
    ].join(", ");
    const ret = op.returnType ? renderPyType(op.returnType) : "None";
    return lines(
      `def ${snake(op.name)}(${params}) -> ${ret}:`,
      "    raise NotImplementedError(",
      `        "extern operation \`${op.name}\` on ${agg.name} is not implemented — "`,
      `        "fill in ${externHookModulePath(agg.name)}"`,
      "    )",
    );
  });

  return lines(
    `# ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first`,
    "# `generate` and NEVER overwrites it again, so your implementation survives every",
    "# regenerate.  Replace each `raise` with the operation's real logic.",
    `"""Hand-written extern hooks for ${agg.name} (docs/extern.md).`,
    "",
    "Each function is the pure-domain extension point for an `operation … extern`",
    `on ${agg.name}: it receives the loaded aggregate (its preconditions already`,
    "checked) and mutates it DIRECTLY — reaching the aggregate's own private state",
    "(`_field`, `raise_event`), no setters.  Raise a DomainError to abort; the",
    "framework re-asserts invariants and persists after you return.",
    '"""',
    "from __future__ import annotations",
    "",
    "from typing import TYPE_CHECKING",
    "",
    "if TYPE_CHECKING:",
    usesUser ? "    from app.auth.user import User" : null,
    `    from app.domain.${snake(agg.name)} import ${agg.name}`,
    idNames.length > 0
      ? `    from app.domain.ids import ${idNames.map((n) => `${n}Id`).join(", ")}`
      : null,
    voEnumNames.length > 0
      ? `    from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    "",
    fns.join("\n\n\n"),
    "",
  );
}
