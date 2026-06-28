import type { AggregateIR, FunctionIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { exprUsesParam, exprUsesReceiver } from "../domain/predicates.js";
import { type RenderCtx, renderExpr, renderTypespec } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Aggregate `function` members (vanilla Ecto/Phoenix backend) — gap §11b.
//
// An aggregate `function passed(): bool = total > 100` is a PURE domain helper
// usable from op / precondition / derived bodies (`precondition passed()`).  The
// other backends carry it as a method on the rich-domain object, so the call
// site renders `this.passed()` (TS) / `record.Passed()` (.NET).  Vanilla has no
// class, so the call lowers (render-expr `callKind: "function"`) to
// `passed(record, <args>)` — a module-level function taking the aggregate
// struct as its first argument.  This module emits that function so the call
// resolves; before this it was emitted nowhere, so `mix compile` failed on the
// undefined reference (gap §11b).
//
// It is emitted into the SAME module the referencing op bodies render into — the
// context-facade module (`<App>.<Ctx>`), where `<op>_<agg>(record, params)`
// lives.  A struct-guarded clause head (`def passed(%Agg{} = record, …)`) lets
// two aggregates in one context that both declare a same-named function coexist
// (Elixir dispatches by the struct guard) without redefining each other.  The
// body renders through `ELIXIR_TARGET` with `thisName: "record"` — exactly the
// receiver the call site binds.
// ---------------------------------------------------------------------------

/** True when the aggregate declares at least one `function` member. */
export function aggHasFunctions(agg: AggregateIR): boolean {
  return (agg.functions?.length ?? 0) > 0;
}

/** Render every `function` member of an aggregate as a module-level Elixir
 *  function (struct-guarded on the aggregate type), two-space indented for the
 *  context-facade module body.  Returns `[]` for a function-less aggregate, so
 *  such an aggregate emits byte-identical output. */
export function renderAggregateFunctions(facadeMod: string, agg: AggregateIR): string[] {
  if (!aggHasFunctions(agg)) return [];
  const aggModule = `${facadeMod}.${upperFirst(agg.name)}`;
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
  };
  const out: string[] = [];
  for (const fn of agg.functions) {
    out.push("", ...renderFunction(facadeMod, aggModule, fn, rc));
  }
  return out;
}

function renderFunction(
  facadeMod: string,
  aggModule: string,
  fn: FunctionIR,
  rc: RenderCtx,
): string[] {
  const fnSnake = snake(fn.name);
  // The call site renders `passed(record, arg1, …)` — positional args after the
  // struct.  Underscore-prefix a param the body never reads so an unused binding
  // never trips `mix compile --warnings-as-errors`.
  const params = fn.params.map((p) =>
    exprUsesParam(fn.body, p.name) ? snake(p.name) : `_${snake(p.name)}`,
  );
  // Underscore-prefix the receiver when the body never reads it (e.g.
  // `function noop()`), else the struct-guarded clause head trips
  // `mix compile --warnings-as-errors` on an unused `record` binding.
  const recv = exprUsesReceiver(fn.body) ? "record" : "_record";
  const sig =
    params.length > 0
      ? `%${aggModule}{} = ${recv}, ${params.join(", ")}`
      : `%${aggModule}{} = ${recv}`;
  const ret = renderTypespec(fn.returnType, facadeMod);
  const specArgs = [
    `${aggModule}.t()`,
    ...fn.params.map((p) => renderTypespec(p.type, facadeMod)),
  ].join(", ");
  const aggLeaf = aggModule.split(".").pop() ?? aggModule;
  return [
    `  @doc "Pure domain function \`${fn.name}\` on \`${aggLeaf}\`."`,
    `  @spec ${fnSnake}(${specArgs}) :: ${ret}`,
    `  def ${fnSnake}(${sig}) do`,
    `    ${renderExpr(fn.body, rc)}`,
    "  end",
  ];
}
