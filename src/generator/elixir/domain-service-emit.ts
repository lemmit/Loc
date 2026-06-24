// ---------------------------------------------------------------------------
// Domain-service emission (Phoenix / Elixir) — domain-services.md, v1 Shape A.
//
// A `domainService Pricing { operation quote(...) {...} }` lowers to a plain,
// stateless Elixir module under the app's `Domain.Services` namespace:
//
//   defmodule Shop.Domain.Services.Pricing do
//     @moduledoc false
//
//     @spec quote(Shop.Sales.Cart.t(), Shop.Sales.Customer.t()) :: Decimal.t()
//     def quote(cart, customer) do
//       cart.subtotal
//     end
//   end
//
// NO GenServer, no state — a domain service touches no persistence, so the
// module is purely computational.  It mirrors how a pure
// aggregate `function` already emits as a plain module `def` with an `@spec`
// (domain-emit.ts `renderHelperFunctions`), but with NO `record`/`this` first
// parameter — a domain service holds no aggregate identity.
//
// The module path MUST match what the ELIXIR_TARGET call leaf renders:
// `<App>.Domain.Services.<Name>` where `<App>` is the first segment of the
// rendering context's `contextModule` (`Shop.Sales` → `Shop`), i.e. the app
// module `toModulePrefix(toSnakeApp(deployable.name))`.  Both this emitter and
// the call site derive `<App>` from the same source, so the call resolves.
//
// Operation bodies render through the shared statement/expression path —
// parameters resolve as bare snake-cased locals (refKind `param`), there is no
// `this`.  `precondition`/`requires` raise an `ArgumentError` guard (the exact
// shape the aggregate-op body emits in render-stmt.ts).  An `or`-union return
// reuses the EXACT tagged-tuple convention the vanilla returning-op path emits
// (`{:ok, value} | {:error, "<tag>", data_map}`) — no new union machinery; a
// plain return is the bare value (Elixir's last-expression-is-the-result).
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  StmtIR,
} from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr, renderTypespec } from "./render-expr.js";

/** Emit `lib/<app>/domain/services/<name>.ex` for each `domainService` in the
 *  context.  Called with `(appName, appModule)` so the module path the
 *  ELIXIR_TARGET call leaf renders resolves.
 *
 *  `appName` is the snake app (`toSnakeApp(deployable.name)`) for the file
 *  path; `appModule` is the module prefix (`toModulePrefix(appName)`) the call
 *  site derives from `contextModule.split(".")[0]`. */
export function emitDomainServices(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
): void {
  // The context module (`<App>.<Ctx>`) is the type-resolution home for the
  // operation signatures' value-object / aggregate / enum references — a
  // domain service lives inside its declaring context, so its parameter and
  // return types name siblings of that context.
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  for (const svc of ctx.domainServices ?? []) {
    const path = `lib/${appName}/domain/services/${snake(svc.name)}.ex`;
    out.set(path, renderDomainServiceModule(svc, ctx, appModule, contextModule));
  }
}

function renderDomainServiceModule(
  svc: DomainServiceIR,
  ctx: BoundedContextIR,
  appModule: string,
  contextModule: string,
): string {
  const moduleName = `${appModule}.Domain.Services.${upperFirst(svc.name)}`;
  const typesModule = `${appModule}.Types`;
  const ops = svc.operations.map((op) => renderOperation(op, ctx, contextModule, typesModule));
  return `# Auto-generated — stateless pure-calculator domain service (domain-services.md).
defmodule ${moduleName} do
  @moduledoc false

${ops.join("\n\n")}
end
`;
}

function renderOperation(
  op: DomainServiceOperationIR,
  ctx: BoundedContextIR,
  contextModule: string,
  typesModule: string,
): string {
  // No `this` — every reference resolves against the bare parameters.
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
  };
  const fnName = snake(op.name);
  const paramNames = op.params.map((p) => snake(p.name));

  // @spec — each declared parameter's type, then the return type.  A union
  // (`Money or CouponExpired`) return is conveyed as a tagged tuple at
  // runtime; its typespec is `renderTypespec`'s `map()` carrier (the same
  // defensive carrier the resource-attribute path uses for transport-only
  // unions), so the spec stays sound without spelling out the tuple shape.
  const isUnion = op.returnType?.kind === "union";
  const specParams = op.params
    .map((p) => renderTypespec(p.type, contextModule, typesModule))
    .join(", ");
  const specRet = op.returnType
    ? renderTypespec(op.returnType, contextModule, typesModule)
    : "term()";
  const specLine = `  @spec ${fnName}(${specParams}) :: ${specRet}`;

  // Bind every unused parameter to its underscore form so `mix compile
  // --warnings-as-errors` doesn't trip — a param the body never references
  // (e.g. `customer` in `quote(cart, customer)` returning `cart.subtotal`)
  // would otherwise warn.  The head keeps the declared name; an unused one
  // gets a `_ = <name>` discard rather than renaming the head (so call-site
  // arity and readable param names are preserved).
  const bodyText = op.body.map((s) => JSON.stringify(s)).join("");
  const discards = paramNames
    .filter((n) => !new RegExp(`"${n}"`).test(bodyText))
    .map((n) => `    _ = ${n}`);

  const bodyLines = op.body.map((s) => renderStatement(s, ctx, renderCtx, isUnion));

  return `${specLine}
  def ${fnName}(${paramNames.join(", ")}) do
${[...discards, ...bodyLines].join("\n")}
  end`;
}

/** A return variant is an *error* iff it names a `kind: "error"` payload in
 *  this context.  (The other arm of `Value or CouponExpired` is the success
 *  value.)  Same predicate the vanilla returning-op path uses. */
function isErrorTag(tag: string, ctx: BoundedContextIR): boolean {
  return ctx.payloads.some((p) => p.name === tag && p.kind === "error");
}

/** Render one domain-service body statement.  The validator floor restricts
 *  the body to `let` / `precondition` / `requires` / `return` / `expression` /
 *  (bare) `call` — no mutation, no `emit`, no infra (domain-service-checks).
 *  Indented 4 spaces (inside `def … do`). */
function renderStatement(
  s: StmtIR,
  ctx: BoundedContextIR,
  rc: RenderCtx,
  isUnion: boolean,
): string {
  switch (s.kind) {
    case "let":
      return `    ${snake(s.name)} = ${renderExpr(s.expr, rc)}`;
    case "precondition":
      // Bug-shaped guard → raise (the same `ArgumentError` shape the aggregate
      // operation body emits in render-stmt.ts).
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`;
    case "requires":
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`;
    case "return": {
      const value = renderExpr(s.value, rc);
      if (!isUnion) {
        // Plain return — Elixir has no `return`; the value is the last
        // expression of the function body (its result).
        return `    ${value}`;
      }
      // `or`-union return → the tagged tuple the vanilla returning-op path
      // emits: an `error`-payload variant rides as `{:error, "<tag>", data}`,
      // the success value as `{:ok, value}`.  No new union machinery.
      if (s.variantTag && isErrorTag(s.variantTag, ctx)) {
        const data = s.value.kind === "object" ? value : `%{value: ${value}}`;
        return `    {:error, ${JSON.stringify(s.variantTag)}, ${data}}`;
      }
      return `    {:ok, ${value}}`;
    }
    case "expression":
      return `    ${renderExpr(s.expr, rc)}`;
    case "call": {
      // A bare call from a domain-service body — `f(args)` (no `this`).  The
      // value form rides `let`/`return` instead; a bare call discards its
      // result, so thread it as a discarded expression to stay compile-clean.
      const args = s.args.map((a) => renderExpr(a, rc)).join(", ");
      return `    _ = ${snake(s.name)}(${args})`;
    }
    // `assign` / `add` / `remove` / `emit` are rejected by the phase-⑦
    // validator floor (a domain service has no `this` to mutate / no identity
    // to emit from), so they never reach this renderer.  Render them as a
    // defensive no-op comment rather than throwing — keeps the switch total.
    case "assign":
    case "add":
    case "remove":
    case "emit":
      return `    # unreachable: ${s.kind} rejected by the domain-service validator floor`;
  }
}
