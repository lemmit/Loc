// Which field defaults .NET cannot carry as a request-record parameter default.
//
// C# requires a record/method parameter default to be a COMPILE-TIME CONSTANT
// (CS1736).  Two lowered default shapes are not:
//
//   * SERVER-SOURCED (`now()` / `currentUser.*`) — `renderCsExpr` yields
//     `DateTime.UtcNow` / an ambient claim read;
//   * a VALUE-OBJECT construction (`total: Money = Money { … }`) — a `new
//     Money(0m, "USD")` constructor call.  It could not name the type there
//     anyway: the request file carries no `Domain.ValueObjects` using.
//
// Both take the same escape hatch — the request param becomes NULLABLE with a
// `= null` default, and the controller coalesces the per-request value on the
// way into the command, where the domain namespace IS in scope.
//
// This lives in one place because THREE emitters must agree on it, and a
// disagreement is not a compile error at generation time — it is a compile
// error in the generated project, one tier away:
//
//   1. `cqrs/dtos.ts`      — decides the param is `T? Name = null`
//   2. `cqrs/controller.ts` — emits the `is null ? <default> : <parse>` coalesce
//   3. `validator-emit.ts`  — must then guard its FluentValidation
//      `SetValidator`, because `IValidator<T>` is not `IValidator<T?>` (CS8620)
//
// (3) is the one that bites: it only fails once (1) has already made a
// VO-typed field nullable, so the two features are individually fine and
// jointly broken.  A server-sourced default is never a value object, so this
// combination had no reachable source until VO defaults reached the wire.

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { isServerSourcedDefault, isValueObjectDefault } from "../_frontend/server-default.js";

/** True when this default cannot be a C# parameter default, so the request
 *  field is emitted nullable and coalesced in the controller.  A type
 *  predicate, so the coalesce site can render the expression without an
 *  assertion. */
export function isNullableWireDefault(e: ExprIR | undefined): e is ExprIR {
  return e !== undefined && (isServerSourcedDefault(e) || isValueObjectDefault(e));
}
