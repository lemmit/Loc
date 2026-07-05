import type {
  AggregateIR,
  ExprIR,
  FunctionBodyIR,
  FunctionIR,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { exprUsesParam, exprUsesReceiver } from "../domain/predicates.js";
import { type RenderCtx, renderExpr, renderTypespec } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Body-variant helpers (domain-services.md rev. 4 — `function` block body).
//
// The expression form (`= Expression`) renders byte-identically to before;
// the block form (`{ Statement* }`) is a PURE Elixir function — `let x = …`
// becomes a binding, `precondition`/`requires` become bug-/auth-regime raises,
// and the final `return`/expression supplies the bare value the function
// yields.  No `{:ok, …}` tuple wrapping: a `function` returns its value
// directly (unlike a returning `operation`).
// ---------------------------------------------------------------------------

/** Every expression a function body reaches into — the single body expr, or
 *  every statement's expressions in the block form.  Lets the
 *  param-/receiver-/money-usage predicates treat both variants uniformly. */
function bodyExprs(body: FunctionBodyIR): ExprIR[] {
  if ("expr" in body) return [body.expr];
  const out: ExprIR[] = [];
  for (const s of body.stmts) {
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        out.push(s.expr);
        break;
      case "return":
        out.push(s.value);
        break;
      case "call":
        out.push(...s.args);
        break;
    }
  }
  return out;
}

export function bodyUsesParam(body: FunctionBodyIR, name: string): boolean {
  return bodyExprs(body).some((e) => exprUsesParam(e, name));
}

export function bodyUsesReceiver(body: FunctionBodyIR): boolean {
  return bodyExprs(body).some((e) => exprUsesReceiver(e));
}

/** The body lines for a function — the single trailing-value line for the
 *  expression form, or the rendered pure block for the block form. */
export function renderFunctionBodyLines(body: FunctionBodyIR, rc: RenderCtx): string[] {
  return "expr" in body ? [`    ${renderExpr(body.expr, rc)}`] : renderPureBlock(body.stmts, rc);
}

/** Render a pure block-body function as Elixir: binding/guard lines followed
 *  by a trailing bare value (the last `return`'s value, or the final
 *  expression).  Each line is two-space indented under the `def … do`. */
function renderPureBlock(stmts: StmtIR[], rc: RenderCtx): string[] {
  const lines: string[] = [];
  for (const s of stmts) {
    switch (s.kind) {
      case "let":
        lines.push(`    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, rc)}`);
        break;
      case "precondition":
        lines.push(
          `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`,
        );
        break;
      case "requires":
        lines.push(
          `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`,
        );
        break;
      case "return":
        // A `function` yields its value directly (no `{:ok, …}` wrap).  The
        // last statement's value is the function's result; an earlier `return`
        // simply binds the value as the trailing expression of that point —
        // pure bodies don't branch, so the final return wins.
        lines.push(`    ${renderExpr(s.value, rc)}`);
        break;
      case "expression":
        lines.push(`    ${renderExpr(s.expr, rc)}`);
        break;
    }
  }
  return lines;
}

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
 *  such an aggregate emits byte-identical output.
 *
 *  `doc` (Route A slice 2): a `shape(document)` aggregate rehydrates its blob into
 *  a `%<Agg>.Data{}` embedded struct, so its functions take THAT struct (guarded
 *  `%<Agg>.Data{} = record`) and read fields off it (`record.<field>`) in struct
 *  mode — same relational renderer, no `docMap` fork.  The op bodies call them as
 *  `<fn>(record, …)` where `record` is the embed. */
export function renderAggregateFunctions(
  facadeMod: string,
  agg: AggregateIR,
  doc = false,
): string[] {
  if (!aggHasFunctions(agg)) return [];
  const aggModule = `${facadeMod}.${upperFirst(agg.name)}`;
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
    ...(doc ? { docStruct: true } : {}),
  };
  const out: string[] = [];
  for (const fn of agg.functions) {
    out.push("", ...renderFunction(facadeMod, aggModule, fn, rc, doc));
  }
  return out;
}

function renderFunction(
  facadeMod: string,
  aggModule: string,
  fn: FunctionIR,
  rc: RenderCtx,
  doc = false,
): string[] {
  const fnSnake = snake(fn.name);
  // The call site renders `passed(record, arg1, …)` — positional args after the
  // struct.  Underscore-prefix a param the body never reads so an unused binding
  // never trips `mix compile --warnings-as-errors`.
  const params = fn.params.map((p) =>
    bodyUsesParam(fn.body, p.name) ? snake(p.name) : `_${snake(p.name)}`,
  );
  // Underscore-prefix the receiver when the body never reads it (e.g.
  // `function noop()`), else the struct-guarded clause head trips
  // `mix compile --warnings-as-errors` on an unused receiver binding.  On the
  // document path the receiver is the `%<Agg>.Data{}` embed; the relational path
  // guards the aggregate struct.  Either way it's a struct-guarded `record`.
  const used = bodyUsesReceiver(fn.body);
  const recv = used ? "record" : "_record";
  const structMod = doc ? `${aggModule}.Data` : aggModule;
  const recvHead = `%${structMod}{} = ${recv}`;
  const sig = params.length > 0 ? `${recvHead}, ${params.join(", ")}` : recvHead;
  const ret = renderTypespec(fn.returnType, facadeMod);
  const specArgs = [
    `${structMod}.t()`,
    ...fn.params.map((p) => renderTypespec(p.type, facadeMod)),
  ].join(", ");
  const aggLeaf = aggModule.split(".").pop() ?? aggModule;
  // Expression form keeps its single trailing-value line (byte-identical);
  // block form (rev. 4) renders its pure statements.
  const bodyLines = renderFunctionBodyLines(fn.body, rc);
  return [
    `  @doc "Pure domain function \`${fn.name}\` on \`${aggLeaf}\`."`,
    `  @spec ${fnSnake}(${specArgs}) :: ${ret}`,
    `  def ${fnSnake}(${sig}) do`,
    ...bodyLines,
    "  end",
  ];
}
