// ---------------------------------------------------------------------------
// Extern operation seam — the Elixir domain extension point.
//
// An `operation X() extern { precondition … }` declares business logic the DSL
// can't express: the body carries only preconditions, and the mutation is
// hand-written by the user.  Before this slice the Elixir backend had NO seam —
// the context ran the preconditions and then persisted an EMPTY changeset
// (`Ecto.Changeset.change(%{})`), silently reporting HTTP 204 success for a
// no-op (proposal `extern-domain-extension-point.md` §1b, task #18).
//
// This module gives it a real seam (proposal §3a, decisions D2/D3):
//
//   * a GENERATED behaviour module `<Ctx>.<Agg>Extern` — one `@callback` per
//     extern op, regenerated every run so it tracks the op signatures; and
//   * a SCAFFOLD-ONCE impl module `<Ctx>.<Agg>ExternImpl` — `@behaviour` +
//     `@impl` stubs whose default body `raise`s ("loud failure when
//     unimplemented", never the silent 204).  It carries the
//     `loom:scaffold-once` marker so `ddd generate system` re-runs PRESERVE the
//     user's filled-in implementation (see `src/util/scaffold-once.ts`).
//
// The context (`context-emit.ts` → `renderExternOpFunction`) runs the
// preconditions, delegates to `<Agg>ExternImpl.<op>(record, params)`, then
// persists the returned (mutated) struct's columns via `force_change` and
// re-asserts invariants — the framework flow the proposal keeps (load →
// preconditions → hook → invariants → save).
//
// Scope: scalar columns.  Mutating a containment / reference collection from an
// extern impl is a documented follow-up (it needs the put_embed/put_assoc
// persist tail + its context helper, which the assign-driven path gates on).
// ---------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import { isRefCollField } from "./ref-collection-emit.js";

/** A non-CRUD `extern` operation — the ops this seam handles.  (CRUD-reserved
 *  names never carry `extern`; they route through the generic create/update
 *  seams.) */
export function isExternOp(op: OperationIR): boolean {
  return op.extern === true;
}

/** Does the aggregate declare at least one extern operation? */
export function aggHasExternOp(agg: AggregateIR): boolean {
  return (agg.operations ?? []).some(isExternOp);
}

/** The extern ops of an aggregate (declaration order). */
function externOpsOf(agg: AggregateIR): OperationIR[] {
  return (agg.operations ?? []).filter(isExternOp);
}

/** Fully-qualified generated behaviour module — `<Ctx>.<Agg>Extern`. */
export function externBehaviourModule(facadeMod: string, aggPascal: string): string {
  return `${facadeMod}.${aggPascal}Extern`;
}

/** Fully-qualified user-owned impl module — `<Ctx>.<Agg>ExternImpl`. */
export function externImplModule(facadeMod: string, aggPascal: string): string {
  return `${facadeMod}.${aggPascal}ExternImpl`;
}

/** The `force_change(:col, record.col)` persist lines for an extern op — every
 *  scalar column of the aggregate, read off the (mutated) struct the impl
 *  returned.  `force_change` (not `put_change`) because the changeset's DATA
 *  already carries the new value, and `put_change` drops a change equal to the
 *  data.  Reference-collection fields (join-table backed) are skipped — they
 *  aren't columns.  Containment mutation from an extern impl is a follow-up. */
export function externPersistForceChanges(agg: AggregateIR): string[] {
  return agg.fields
    .filter((f) => !isRefCollField(f))
    .map((f) => {
      const col = snake(f.name);
      return `Ecto.Changeset.force_change(:${col}, record.${col})`;
    });
}

/** Emit the extern behaviour + scaffold-once impl module for every aggregate in
 *  the context that declares an extern operation.  No-op when none do (the vast
 *  majority of contexts) — byte-identical output. */
export function emitVanillaExternModules(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  const ctxModule = upperFirst(ctx.name);
  const facadeMod = `${appModule}.${ctxModule}`;
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const ctxSnake = snake(ctx.name);

  for (const agg of ctx.aggregates) {
    if (!aggHasExternOp(agg)) continue;
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const aggModule = `${facadeMod}.${aggPascal}`;
    const behaviourMod = externBehaviourModule(facadeMod, aggPascal);
    const implMod = externImplModule(facadeMod, aggPascal);
    const ops = externOpsOf(agg);

    // Generated behaviour — one `@callback` per extern op, regenerated each run.
    const callbacks = ops
      .map(
        (op) =>
          `  @callback ${snake(op.name)}(${aggModule}.t(), map()) ::\n` +
          `              {:ok, ${aggModule}.t()} | {:error, term()}`,
      )
      .join("\n");
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_extern.ex`,
      `defmodule ${behaviourMod} do
  @moduledoc """
  Extern-hook contract for \`${aggPascal}\` — one \`@callback\` per \`extern\`
  operation.  These operations declare business logic Loom can't express; the
  hand-written implementation lives in \`${implMod}\` (co-located, yours to own —
  regeneration never overwrites it).

  Each callback runs AFTER the operation's preconditions and BEFORE the
  framework re-asserts invariants and persists: mutate the record and return
  \`{:ok, record}\`, or \`{:error, term}\` to abort the write.
  """

${callbacks}
end
`,
    );

    // Scaffold-once impl — `@behaviour` + `@impl` stubs that raise loudly.  The
    // marker on line 1 tells the CLI writer to PRESERVE this file on regen.
    const impls = ops
      .map((op) => {
        const opSnake = snake(op.name);
        return `  @impl true
  def ${opSnake}(%${aggModule}{} = _record, _params) do
    raise "extern operation \`${op.name}\` on ${aggPascal} is not implemented — " <>
            "fill in lib/${appSnake}/${ctxSnake}/${aggSnake}_extern_impl.ex"
  end`;
      })
      .join("\n\n");
    out.set(
      `lib/${appSnake}/${ctxSnake}/${aggSnake}_extern_impl.ex`,
      `# ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first
# \`generate\` and NEVER overwrites it again, so your implementation survives every
# regenerate.  Replace each \`raise\` with the operation's real logic.
defmodule ${implMod} do
  @moduledoc """
  Hand-written extern hooks for \`${aggPascal}\` — implements \`${behaviourMod}\`.

  Each function receives the loaded record (its preconditions already passed) and
  the request params.  Mutate the struct and return \`{:ok, record}\` (the framework
  then re-asserts invariants and persists), or \`{:error, term}\` to abort.
  """
  @behaviour ${behaviourMod}

${impls}
end
`,
    );
  }
}
