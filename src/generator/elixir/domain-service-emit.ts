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
import { readPortsForOperation } from "../../ir/util/domain-service-read-ports.js";
import { classifyDomainServiceTier } from "../../ir/util/domain-service-tier.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr, renderTypespec } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Tier-driven placement (domain-services.md rev. 4, Slice 1; Elixir decision B)
//
// Elixir is the structural OUTLIER among the five backends.  Where the others
// thread a read-port HANDLE (param / injected repo) into a service that stays a
// standalone unit, Elixir has the ambient `Repo` for free — so the divergence is
// PLACEMENT, not a handle:
//
//   - a `pure` op stays a standalone `<App>.Domain.Services.<Name>` module fn
//     (byte-identical to the pre-rev.4 shell), AND
//   - a single-context `reading` op lowers to a CONTEXT FUNCTION on its
//     aggregate's context module (`Api.Accounts.is_email_available/1`), so the
//     body's repo reads resolve against the ambient `Repo` via the existing
//     context-facade find fns.
//
// `placeReadingAsContextFn` is the single predicate both sides share: this
// emitter SKIPS a reading op from the `Domain.Services` module (and skips the
// whole module when every op is reading), and `context-emit.ts` ADDS the reading
// op as a context fn via `renderReadingServiceContextFn`.  A reading op whose
// read-ports span MORE THAN ONE context is OUT OF SCOPE for Slice 1 — it would
// need a standalone module taking explicit `Repo`/context args; we keep it in
// the `Domain.Services` module (so it still emits *something*) and flag it with a
// `# loom.domain-service-multi-context-reading` note rather than crashing.
// ---------------------------------------------------------------------------

/** True when a reading op's read-ports all resolve to ONE context (this
 *  service's own) — the single-context case Slice 1 emits as a context fn.  A
 *  port whose repository is not declared in `ctx` means the read spans another
 *  context (out of scope) — then we keep the standalone module form. */
export function readingIsSingleContext(
  op: DomainServiceOperationIR,
  ctx: BoundedContextIR,
): boolean {
  const localRepos = new Set(ctx.repositories.map((r) => r.name));
  return readPortsForOperation(op).every((p) => localRepos.has(p.repo));
}

/** Does this op lower to a context FUNCTION (single-context `reading`) rather
 *  than a `Domain.Services` module fn?  Pure ops → false (module).  Reading ops
 *  spanning >1 context → false (kept in the module, flagged — out of scope). */
export function placeReadingAsContextFn(
  op: DomainServiceOperationIR,
  ctx: BoundedContextIR,
): boolean {
  return classifyDomainServiceTier(op) === "reading" && readingIsSingleContext(op, ctx);
}

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
    // Ops emitted as context fns (single-context `reading`) are NOT in this
    // module — `context-emit.ts` hosts them.  A module whose every op is a
    // context fn (a service with only reading ops) emits NO file at all.
    const moduleOps = svc.operations.filter((op) => !placeReadingAsContextFn(op, ctx));
    if (moduleOps.length === 0) continue;
    const path = `lib/${appName}/domain/services/${snake(svc.name)}.ex`;
    out.set(path, renderDomainServiceModule(svc, moduleOps, ctx, appModule, contextModule));
  }
}

/** Render the single-context `reading`-tier operations of the context's domain
 *  services as CONTEXT FUNCTIONS (Elixir decision B — ambient `Repo`).  Called
 *  by `context-emit.ts`, which splices the returned blocks into the context
 *  module so the body's repo reads resolve against the ambient `Repo` via the
 *  sibling context-facade find fns.  Returns `[]` when no reading op qualifies
 *  (so a pure-only / workflow-only context module is byte-identical). */
export function renderReadingServiceContextFns(
  ctx: BoundedContextIR,
  contextModule: string,
  typesModule: string,
): string[] {
  const blocks: string[] = [];
  for (const svc of ctx.domainServices ?? []) {
    for (const op of svc.operations) {
      if (!placeReadingAsContextFn(op, ctx)) continue;
      blocks.push(renderReadingServiceContextFn(svc, op, ctx, contextModule, typesModule));
    }
  }
  return blocks;
}

function renderDomainServiceModule(
  svc: DomainServiceIR,
  moduleOps: DomainServiceOperationIR[],
  ctx: BoundedContextIR,
  appModule: string,
  contextModule: string,
): string {
  const moduleName = `${appModule}.Domain.Services.${upperFirst(svc.name)}`;
  const typesModule = `${appModule}.Types`;
  const ops = moduleOps.map((op) => renderOperation(op, ctx, contextModule, typesModule));
  return `# Auto-generated — stateless pure-calculator domain service (domain-services.md).
defmodule ${moduleName} do
  @moduledoc false

${ops.join("\n\n")}
end
`;
}

/** A single-context `reading`-tier op rendered as a CONTEXT FUNCTION: identical
 *  to the pure module-fn shape (`@spec` + `def <op>(params) do … end`), but its
 *  body's `repo-read` arms render against the ambient `Repo` via the sibling
 *  context-facade find fns (`get_<agg>` / `<find>_<agg>`).  4-space indented to
 *  sit inside the context module's `defmodule`. */
function renderReadingServiceContextFn(
  svc: DomainServiceIR,
  op: DomainServiceOperationIR,
  ctx: BoundedContextIR,
  contextModule: string,
  typesModule: string,
): string {
  // The render context carries `readingServiceModule` so any NESTED
  // domain-service call inside this reading body resolves to a sibling context
  // fn (same module), and `domainServiceTier` so the `repo-read`/`domain-service`
  // arms pick the context-fn shape.  `repo-read` arms render bare sibling
  // calls (`get_account(id)`) since this fn lives ON the context module.
  const inner = renderOperation(op, ctx, contextModule, typesModule, {
    readingServiceModule: contextModule,
    domainServiceTier: (service, opName) =>
      service === svc.name && opName === op.name ? "reading" : undefined,
  });
  return `  @doc "Reading-tier domain service \`${svc.name}.${op.name}\` (ambient Repo — domain-services.md rev. 4)."
${inner}`;
}

function renderOperation(
  op: DomainServiceOperationIR,
  ctx: BoundedContextIR,
  contextModule: string,
  typesModule: string,
  /** Extra render-context flags — set when this op is rendered as a
   *  single-context `reading` CONTEXT FUNCTION (ambient `Repo`), so its
   *  `repo-read` / nested `domain-service` arms pick the context-fn shape. */
  ctxOverride?: Pick<RenderCtx, "readingServiceModule" | "domainServiceTier">,
): string {
  // No `this` — every reference resolves against the bare parameters.
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    ...ctxOverride,
  };
  // Out-of-scope guard: a `reading` op whose read-ports span MORE THAN ONE
  // context can't be a single-context fn, so it stays in the `Domain.Services`
  // module — but the module has no ambient `Repo`/context to resolve its repo
  // reads.  Slice 1 does not emit that shape; flag it (a reviewed limitation,
  // not a crash) and emit a guard `raise` rather than a body that references a
  // non-existent context fn.
  const multiContextReading =
    classifyDomainServiceTier(op) === "reading" && !readingIsSingleContext(op, ctx);
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

  if (multiContextReading) {
    // OUT OF SCOPE (Slice 1): a cross-context reading service.  Emit a guard
    // raise + a visible flag note rather than a body whose repo reads name
    // context fns that don't exist in this module.
    const allDiscards = paramNames.map((n) => `    _ = ${n}`);
    return `${specLine}
  # loom.domain-service-multi-context-reading: '${op.name}' reads repositories
  # across more than one context — out of scope for domain-services rev. 4 Slice 1
  # (single-context reading only).  A cross-context reading service needs a
  # standalone module taking explicit Repo/context args; not emitted here.
  def ${fnName}(${paramNames.join(", ")}) do
${allDiscards.join("\n")}
    raise "domain service '${op.name}': cross-context reading not yet supported (domain-services.md rev. 4 Slice 1)"
  end`;
  }

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
