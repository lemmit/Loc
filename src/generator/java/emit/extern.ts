import type { EnrichedAggregateIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import { renderJavaType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Extern operations — the DOMAIN EXTENSION POINT
// (extern-domain-extension-point.md §3a, decisions D2/D5; the Java Phase 2
// re-home).  An `operation X() extern` on the aggregate declares business
// logic the DSL can't express: the generated `<Agg>.<op>(...)` method runs the
// preconditions, delegates HERE, then re-asserts invariants.
//
// This file IS the hook — a SCAFFOLD-ONCE, user-owned `<Agg>Extern` class,
// co-located with the aggregate (SAME package → it reaches the entity's
// package-private fields + `_raiseEvent` natively, no setter widening; Java
// never had the S10 leak).  Each `extern` op is one `static` method that takes
// the loaded aggregate and mutates it.  Loud both ways:
//
//   * an UNIMPLEMENTED hook throws `UnsupportedOperationException` at call time
//     (mirrors the Elixir analog's `raise`, `elixir/vanilla/extern-emit.ts`,
//     #1841), never a silent success; and
//   * a NEWLY-ADDED extern op is a COMPILE error — the regenerated aggregate
//     references a `<Agg>Extern.<newOp>(...)` method this frozen file lacks.
//
// The `loom:scaffold-once` marker on line 1 tells the CLI writer to PRESERVE
// the on-disk copy on every regenerate (see `src/util/scaffold-once.ts`), so a
// filled-in implementation survives.
// ---------------------------------------------------------------------------

/** The scaffold-once `<Agg>Extern` hook class for an aggregate that declares at
 *  least one `extern` operation — one loud-throwing static method per op. */
export function renderJavaExternHook(
  agg: EnrichedAggregateIR,
  externOps: readonly OperationIR[],
  pkg: string,
  basePkg: string,
): string {
  const recv = lowerFirst(agg.name);
  const anyUsesUser = externOps.some(operationUsesCurrentUser);
  const methods = externOps.flatMap((op) => {
    const usesUser = operationUsesCurrentUser(op);
    const params = [
      `${agg.name} ${recv}`,
      ...op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`),
      ...(usesUser ? ["User currentUser"] : []),
    ].join(", ");
    const msg =
      `extern operation \`${op.name}\` on ${agg.name} is not implemented — ` +
      `fill in ${agg.name}Extern.${op.name}(...)`;
    return [
      `    /** \`${op.name}()\` extern hook — runs AFTER the operation's preconditions`,
      `     *  and BEFORE ${agg.name} re-asserts its invariants.  Mutate \`${recv}\` (its`,
      `     *  fields are package-private) and raise events via`,
      `     *  \`${recv}._raiseEvent(...)\`; return normally and the framework saves. */`,
      `    static void ${op.name}(${params}) {`,
      `        throw new UnsupportedOperationException(${JSON.stringify(msg)});`,
      `    }`,
      ``,
    ];
  });
  while (methods.length > 0 && methods[methods.length - 1] === "") methods.pop();

  return lines(
    `// ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first`,
    `// \`generate\` and NEVER overwrites it again, so your implementation survives`,
    `// every regenerate.  Replace each \`throw\` with the operation's real logic.`,
    `package ${pkg};`,
    ``,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.events.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    anyUsesUser ? `import ${basePkg}.auth.User;` : null,
    ``,
    `/** Hand-written extern hooks for \`${agg.name}\` — one static method per`,
    ` *  \`extern\` operation.  Co-located with the aggregate (same package → native`,
    ` *  package-private field access); the generated \`${agg.name}.<op>(...)\` methods`,
    ` *  delegate here.  Yours to own; regeneration never overwrites it. */`,
    `final class ${agg.name}Extern {`,
    `    private ${agg.name}Extern() {}`,
    ``,
    ...methods,
    `}`,
    ``,
  );
}
