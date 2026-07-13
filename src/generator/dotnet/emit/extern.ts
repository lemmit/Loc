// ---------------------------------------------------------------------------
// Extern operation seam — the .NET domain extension point (extern (b) Phase 2).
//
// An `operation X(...) extern { precondition … }` declares business logic the
// DSL can't express: the body carries only preconditions, and the mutation is
// hand-written by the user.  The aggregate emitter (`emit/entity.ts`) emits a
// real `X(...)` method that runs the preconditions, calls a `private partial
// XCore(...)` HOOK, then re-asserts invariants — the framework flow (load →
// preconditions → hook → invariants → save) is unchanged; only *what the hook
// is* changed, from an injected external `I<Op><Agg>Handler` to a MEMBER of the
// aggregate (so it reaches the aggregate's own `private` state natively — no
// setter widening; finding S10 fixed by construction).
//
// This module emits the *implementing* half: a SCAFFOLD-ONCE, user-owned
// partial file `Domain/<Plural>/<Agg>.Extern.cs` (`public sealed partial class
// <Agg>`) with one `XCore` implementing partial per extern op whose body
// `throw`s until filled.  The `loom:scaffold-once` marker on line 1 tells the
// CLI writer to PRESERVE the on-disk copy on regen (see
// `src/util/scaffold-once.ts`), so a filled-in hook survives every regenerate.
//
// Loud both ways: a MISSING implementation is a COMPILE error (`private partial`
// is an extended partial method — CS8795 with no implementing declaration), and
// an UNFILLED implementation is a runtime `NotImplementedException` (never a
// silent no-op — the pathology the injected dev-stub had).
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import { renderCsType } from "../render-expr.js";

/** The C# param list for an extern op's hook — mirrors the aggregate method's
 *  signature EXACTLY (the implementing partial must match the defining one):
 *  the op's domain-typed params, plus a trailing `User currentUser` when the
 *  op references `currentUser`. */
function hookParams(op: AggregateIR["operations"][number]): string {
  const base = op.params.map((p) => `${renderCsType(p.type)} ${p.name}`);
  return [...base, ...(operationUsesCurrentUser(op) ? ["User currentUser"] : [])].join(", ");
}

/** Render the scaffold-once user-owned extern-hook partial for an aggregate
 *  that declares ≥1 extern op — `Domain/<Plural>/<Agg>.Extern.cs`.  Returns
 *  `undefined` when the aggregate has no extern op (nothing to scaffold). */
export function renderExternHookImpl(agg: AggregateIR, ns: string): string | undefined {
  const externOps = agg.operations.filter((o) => o.extern);
  if (externOps.length === 0) return undefined;
  const anyUsesUser = externOps.some(operationUsesCurrentUser);

  const hooks = externOps
    .map((op) => {
      const retType = op.returnType ? renderCsType(op.returnType) : "void";
      const msg = `extern operation '${op.name}' on ${agg.name} is not implemented — fill in this partial (Domain/${plural(agg.name)}/${agg.name}.Extern.cs)`;
      return (
        `    /// <summary>Hand-written domain hook for \`${op.name}\` — runs after the\n` +
        `    /// framework asserts the operation's preconditions and BEFORE it re-asserts\n` +
        `    /// invariants and saves.  A MEMBER of ${agg.name}, so it may mutate private\n` +
        `    /// state and add domain events (\`_domainEvents.Add(...)\`) directly.</summary>\n` +
        `    private partial ${retType} ${upperFirst(op.name)}Core(${hookParams(op)})\n` +
        `        => throw new NotImplementedException(${JSON.stringify(msg)});`
      );
    })
    .join("\n\n");

  return `// ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first
// \`generate\` and NEVER overwrites it again, so your implementation survives every
// regenerate.  Replace each \`throw\` with the operation's real domain logic.
using System;
using System.Collections.Generic;
using System.Linq;
using ${ns}.Domain.Ids;
using ${ns}.Domain.Events;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Domain.Common;${anyUsesUser ? `\nusing ${ns}.Auth;` : ""}

namespace ${ns}.Domain.${plural(agg.name)};

public sealed partial class ${agg.name}
{
${hooks}
}
`;
}
