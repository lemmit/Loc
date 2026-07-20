// Context-scoped INTEGRATION test emission (test-placement.md, Phase 3b) — the
// Elixir/vanilla-Phoenix (Ecto) backend.  The Elixir twin of the node renderer,
// but persistence goes through the plain CONTEXT MODULE (not a hand-built repo):
// a `context`-nested `test` (or `test … for <Context>`) runs cross-aggregate
// behaviour against the live Ecto repo — a create persists via
// `<Ctx>.create_<agg>(attrs)`, a named operation via `<Ctx>.<op>_<agg>(rec, %{})`,
// and a repository find reads back via `<Ctx>.get_<agg>(id)` / `list_<plural>()`.
//
// DB isolation uses `Ecto.Adapters.SQL.Sandbox` (config/test.exs already wires
// the sandbox pool): a per-test `checkout` + `{:shared, self()}` mode gives each
// test a transactional connection rolled back at the end.  The harness applies
// the schema once with `MIX_ENV=test mix ecto.create && mix ecto.migrate` before
// `mix test` (the standard Phoenix flow); the sandbox rolls back data per test.
//
// v1 constraint: a repository find must be LET-BOUND
// (`loom.integration-find-must-bind`, shared with node).

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TestIR,
  TestStmtIR,
} from "../../../ir/types/loom-ir.js";
import { elixirString, plural, snake, upperFirst } from "../../../util/naming.js";
import { type Env, renderExpect, vtExpr } from "./tests-emit.js";

const BUILTIN_READS = new Set(["findById", "getById", "findAll"]);

/** A `<Agg>.create(...)` / named create-action call → the owning aggregate;
 *  undefined when the call is not a create. */
function createAggOf(e: ExprIR, ctx: BoundedContextIR): AggregateIR | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const agg = ctx.aggregates.find((a) => a.name === (e.receiver as { name: string }).name);
  if (!agg) return undefined;
  if (e.member === "create" || (agg.creates ?? []).some((c) => c.name === e.member)) return agg;
  return undefined;
}

/** A `<Agg>.<op>(...)` call on a declared aggregate operation. */
function opAggOf(e: ExprIR, ctx: BoundedContextIR): AggregateIR | undefined {
  if (e.kind !== "method-call" || e.isCollectionOp || e.isIntrinsicMatcher) return undefined;
  const rt = e.receiverType;
  const aggName = rt.kind === "entity" ? rt.name : undefined;
  if (!aggName) return undefined;
  const agg = ctx.aggregates.find((a) => a.name === aggName);
  return agg?.operations.some((o) => o.name === e.member) ? agg : undefined;
}

/** A `<Agg>.<find>(...)` repository read → the context-module call binding the
 *  read result to `name`, or undefined.  Built-in `findById`/`getById` →
 *  `get_<agg>` (`{:ok, rec}`); `findAll` → `list_<plural>` (`{:ok, %{items: rec}}`).
 *  A custom find is delegated on the context module by its own name. */
function findBinding(
  e: ExprIR,
  ctx: BoundedContextIR,
  ctxMod: string,
  name: string,
  env: Env,
): string | undefined {
  if (e.kind !== "method-call" || e.receiver.kind !== "ref") return undefined;
  const aggName = (e.receiver as { name: string }).name;
  const agg = ctx.aggregates.find((a) => a.name === aggName);
  if (!agg || !ctx.repositories.some((r) => r.aggregateName === aggName)) return undefined;
  const custom = ctx.repositories
    .filter((r) => r.aggregateName === aggName)
    .flatMap((r) => r.finds)
    .find((f) => f.name === e.member);
  if (!BUILTIN_READS.has(e.member) && !custom) return undefined;
  const args = e.args.map((a) => vtExpr(a, env)).join(", ");
  if (e.member === "findAll") {
    return `{:ok, %{items: ${name}}} = ${ctxMod}.list_${snake(plural(agg.name))}()`;
  }
  if (e.member === "findById" || e.member === "getById") {
    return `{:ok, ${name}} = ${ctxMod}.get_${snake(agg.name)}(${args})`;
  }
  // A custom find is re-exported on the context module under its own name.
  return `{:ok, ${name}} = ${ctxMod}.${snake(e.member)}(${args})`;
}

/** Render an object-literal create/op argument to an Ecto attrs map. */
function attrsMap(e: ExprIR | undefined, env: Env): string {
  if (e?.kind !== "object") return "%{}";
  return `%{${e.fields.map((f) => `${snake(f.name)}: ${vtExpr(f.value, env)}`).join(", ")}}`;
}

/** Render one integration-test statement. */
function renderStmt(s: TestStmtIR, ctx: BoundedContextIR, ctxMod: string, env: Env): string[] {
  switch (s.kind) {
    case "let": {
      const createAgg = createAggOf(s.expr, ctx);
      if (createAgg && s.expr.kind === "method-call") {
        return [
          `{:ok, ${snake(s.name)}} = ${ctxMod}.create_${snake(createAgg.name)}(${attrsMap(s.expr.args[0], env)})`,
        ];
      }
      const find = findBinding(s.expr, ctx, ctxMod, snake(s.name), env);
      if (find) return [find];
      return [`${snake(s.name)} = ${vtExpr(s.expr, env)}`];
    }
    case "expression": {
      const opAgg = opAggOf(s.expr, ctx);
      if (opAgg && s.expr.kind === "method-call") {
        // A mutating op → the context handler persists and returns {:ok, rec};
        // rebind the receiver to the persisted result.
        const recv = vtExpr(s.expr.receiver, env);
        return [
          `{:ok, ${recv}} = ${ctxMod}.${snake(s.expr.member)}_${snake(opAgg.name)}(${recv}, ${attrsMap(s.expr.args[0], env)})`,
        ];
      }
      return [vtExpr(s.expr, env)];
    }
    case "expect":
      return [renderExpect(s.expr, env)];
    case "expect-throws": {
      // A failed create/op returns {:error, _} on the context module.
      const inner = s.expr.kind === "paren" ? s.expr.inner : s.expr;
      const createAgg = createAggOf(inner, ctx);
      if (createAgg && inner.kind === "method-call") {
        return [
          `assert {:error, _} = ${ctxMod}.create_${snake(createAgg.name)}(${attrsMap(inner.args[0], env)})`,
        ];
      }
      const opAgg = opAggOf(inner, ctx);
      if (opAgg && inner.kind === "method-call") {
        const recv = vtExpr(inner.receiver, env);
        return [
          `assert {:error, _} = ${ctxMod}.${snake(inner.member)}_${snake(opAgg.name)}(${recv}, ${attrsMap(inner.args[0], env)})`,
        ];
      }
      return [`assert {:error, _} = ${vtExpr(inner, env)}`];
    }
    default:
      throw new Error(`unsupported integration-test statement '${s.kind}'`);
  }
}

function renderTest(t: TestIR, ctx: BoundedContextIR, ctxMod: string, env: Env): string[] {
  const body = t.statements.flatMap((s) => renderStmt(s, ctx, ctxMod, env));
  return [`test ${elixirString(t.name)} do`, ...body.map((l) => `  ${l}`), "end"];
}

/** Emit `test/<ctx>_integration_test.exs` for a context that declares
 *  integration tests, or null when it declares none.  `appModule` is the app
 *  root (e.g. `Api`) — `${appModule}.Repo` / `${appModule}.<Ctx>`. */
export function renderVanillaContextIntegrationTest(
  ctx: BoundedContextIR,
  appModule: string,
): string | null {
  if (ctx.tests.length === 0) return null;

  const ctxMod = `${appModule}.${upperFirst(ctx.name)}`;
  const repo = `${appModule}.Repo`;
  // A value-render Env — the integration renderer owns create/op/find itself, so
  // vtExpr only ever sees leaf values (literals / refs / member reads).
  const env: Env = {
    agg: null,
    aggMod: null,
    ctxModule: ctxMod,
    appModule,
    validatableVos: new Set(),
    derivedAccessors: new Set(),
  };

  const blocks = ctx.tests.map((t) => renderTest(t, ctx, ctxMod, env));
  const body = blocks.flatMap((block) => ["", ...block.map((l) => (l === "" ? "" : `  ${l}`))]);

  return `# Auto-generated.  Do not edit by hand.
defmodule ${ctxMod}IntegrationTest do
  use ExUnit.Case, async: false

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(${repo})
    Ecto.Adapters.SQL.Sandbox.mode(${repo}, {:shared, self()})
    :ok
  end
${body.join("\n")}
end
`;
}
