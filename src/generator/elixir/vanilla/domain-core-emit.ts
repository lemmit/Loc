import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  FunctionIR,
  OperationIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { isVanillaDocAgg } from "./document-emit.js";
import { isEventSourced } from "./eventsourced-emit.js";
import { bodyUsesParam, renderFunctionBodyLines } from "./function-emit.js";
import { isReturningOperation, renderReturningStmt } from "./operation-returns-emit.js";

// ---------------------------------------------------------------------------
// Pure domain core for the vanilla (Ecto/Phoenix) aggregate module — the seam
// that makes generated domain `test "..."` blocks run as plain ExUnit WITHOUT a
// database (the elixir parity story; docs/audits/test-parity-generated-backends.md).
//
// The other four backends generate a rich-domain object whose factory + methods
// validate in memory, separable from persistence; the Loom `test` idiom
// (construct → call method → assert / catch throw) maps onto it 1:1.  Vanilla's
// context facade folds persistence in (`create_<agg>` → `Repo.insert`,
// `<op>_<agg>` → `persist_change`), so a literal port would need a DB.  But the
// rule layer underneath is already pure:
//
//   * invariants live in `<Agg>Changeset.base_changeset/2` — pure Ecto;
//   * a named-op precondition `raise`s BEFORE the persist tail;
//   * a `field := value` body re-binds `record = %{record | field: value}` in
//     memory (the persist tail only `put_change`s afterwards).
//
// So we expose that pure core as functions on the aggregate module:
//
//   def create(attrs)        :: {:ok, t} | {:error, Ecto.Changeset.t()}
//        = base_changeset(%__MODULE__{}, attrs) |> Ecto.Changeset.apply_action(:insert)
//   def <op>(record, params) :: t   (raises on a failed precondition)
//        = the op body's preconditions + in-memory mutations, returning the
//          updated struct — EMIT and persistence stripped (effects, not domain
//          state), so the core stays Repo-free.
//
// Verified DB-free in an Elixir/Ecto container (apply_action runs validations +
// applies changes with no Repo; the precondition raise fires before any persist).
// Additive: the context's persisting `create_<agg>` / `<op>_<agg>` are untouched,
// so no existing vanilla runtime / build / conformance behaviour changes.
// ---------------------------------------------------------------------------

/** True when the aggregate has the standard relational `base_changeset/2`
 *  (and thus a pure core is emittable).  Event-sourced and document-shaped
 *  aggregates persist differently and are out of scope for the pure core. */
export function hasPureDomainCore(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  sys?: SystemIR,
): boolean {
  return !isEventSourced(agg) && !isVanillaDocAgg(agg, ctx, sys);
}

/** The pure-core function bodies for one aggregate, injected into its schema
 *  module by `schema-emit.ts` (2-space indented, schema-module body level).
 *  Returns `[]` when the aggregate is non-relational. */
export function renderAggregatePureCore(
  appModule: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  sys?: SystemIR,
): string[] {
  if (!hasPureDomainCore(agg, ctx, sys)) return [];
  const ctxModule = upperFirst(ctx.name);
  const changesetMod = `${appModule}.${ctxModule}.${upperFirst(agg.name)}Changeset`;

  // Relational containments (`has_many`) default to `Ecto.Association.NotLoaded`
  // on a freshly-built struct — but the pure-domain path never loads them, and
  // the in-memory op bodies treat a collection as a list (`record.lines ++ [x]`,
  // `Enum.count(record.lines)`).  `NotLoaded` is truthy, so the `|| []` guard in
  // those bodies doesn't catch it → `** (ArgumentError)`.  Initialise every
  // collection containment to `[]` on create so the pure-domain (no-DB) path
  // matches the loaded/persisted shape.  (Embedded `embeds_many` already default
  // to `[]`; the reset is harmless there.)
  const collectionContainments = agg.contains.filter((c) => c.collection).map((c) => snake(c.name));
  const createBody =
    collectionContainments.length === 0
      ? [
          `    ${changesetMod}.base_changeset(%__MODULE__{}, attrs)`,
          "    |> Ecto.Changeset.apply_action(:insert)",
        ]
      : [
          "    with {:ok, record} <-",
          `           ${changesetMod}.base_changeset(%__MODULE__{}, attrs)`,
          "           |> Ecto.Changeset.apply_action(:insert) do",
          `      {:ok, %{record | ${collectionContainments.map((n) => `${n}: []`).join(", ")}}}`,
          "    end",
        ];
  const out: string[] = [
    `  @doc "Pure create core — validates + applies the changeset in memory (no persistence)."`,
    "  def create(attrs) when is_map(attrs) do",
    ...createBody,
    "  end",
  ];
  for (const op of agg.operations) {
    out.push("", ...renderPureOp(appModule, ctxModule, ctx, op));
  }
  // Aggregate `function` members (§11b) — pure helpers the op bodies above may
  // call (`precondition passed()` / a bare `passed()` statement).  The pure core
  // lives ON the aggregate's schema module, so emit the functions here too (the
  // context-facade copy lives in `context-emit.ts`); a `<fn>(record, …)` call
  // then resolves in whichever module the body renders into.  The struct guard
  // is `%__MODULE__{}` — this IS the aggregate's own schema module.
  for (const fn of agg.functions ?? []) {
    out.push("", ...renderPureFunction(`${appModule}.${ctxModule}`, fn));
  }
  // Derived fields (§B18) — an Ecto struct carries no computed field, so a
  // `derived isDraft: bool = …` has no `record.is_draft` to read (the wire path
  // computes it inline).  Expose each PURE derived as an accessor function on the
  // schema module (`def is_draft(record), do: record.status == :Draft`) so a
  // domain `test` can read it exactly like node/java/dotnet/python's getter.
  for (const line of derivedAccessorLines(
    `${appModule}.${ctxModule}`,
    agg as EnrichedAggregateIR,
  )) {
    out.push(line);
  }
  return out;
}

/** The derived-field names that get a pure-core accessor on the aggregate schema
 *  module.  A derived whose expression can't render as a pure struct function
 *  (e.g. it references a repository find) is omitted — no accessor emitted, no
 *  codegen crash.  Shared with `tests-emit.ts` so a domain test reading a derived
 *  routes to `Agg.<derived>(record)` exactly when an accessor exists (and skips
 *  honestly otherwise, rather than emitting a `KeyError`-raising struct read). */
export function pureDerivedAccessorNames(
  contextModule: string,
  agg: EnrichedAggregateIR,
): Set<string> {
  const names = new Set<string>();
  const rc: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla", agg };
  for (const d of agg.derived) {
    if (d.name === "inspect") continue; // the synthesized redaction derived (inspect-emit.ts owns it)
    try {
      renderExpr(d.expr, rc);
      names.add(d.name);
    } catch {
      // Non-pure derived — leave it to the wire path; no domain accessor.
    }
  }
  return names;
}

/** `def <derived>(%__MODULE__{} = record), do: <expr>` lines for each pure derived
 *  (blank-line separated, schema-module body indent), mirroring `pureDerivedAccessorNames`. */
function derivedAccessorLines(contextModule: string, agg: EnrichedAggregateIR): string[] {
  const emit = pureDerivedAccessorNames(contextModule, agg);
  const rc: RenderCtx = { thisName: "record", contextModule, foundation: "vanilla", agg };
  const out: string[] = [];
  for (const d of agg.derived) {
    if (!emit.has(d.name)) continue;
    const body = renderExpr(d.expr, rc);
    out.push(
      "",
      `  @doc "Pure derived \`${d.name}\` — computed from struct state (no persistence)."`,
    );
    // A block-bodied derived — a `match` renders to `cond do … end`, a find /
    // option unwrap to `case … do … end`.  Bare in the one-liner `, do:` keyword
    // form the trailing `do … end` binds to `def` itself, so Elixir sees
    // `def/3` ("undefined function def/3") and won't compile.  Wrapping the block
    // in parens rebinds the `do … end` to the block expression and keeps the
    // keyword-form layout for the simple (single-line) deriveds unchanged.
    const rendered = body.includes("\n") ? `(${body})` : body;
    out.push(`  def ${snake(d.name)}(%__MODULE__{} = record), do: ${rendered}`);
  }
  return out;
}

/** One `function` member as a `def <fn>(%__MODULE__{} = record, …)` on the
 *  aggregate schema module — the pure-core sibling of `function-emit.ts`'s
 *  context-facade copy. */
function renderPureFunction(facadeMod: string, fn: FunctionIR): string[] {
  const fnSnake = snake(fn.name);
  const rc: RenderCtx = { thisName: "record", contextModule: facadeMod, foundation: "vanilla" };
  const params = fn.params.map((p) =>
    bodyUsesParam(fn.body, p.name) ? snake(p.name) : `_${snake(p.name)}`,
  );
  const sig =
    params.length > 0 ? `%__MODULE__{} = record, ${params.join(", ")}` : `%__MODULE__{} = record`;
  return [
    `  @doc "Pure domain function \`${fn.name}\`."`,
    `  def ${fnSnake}(${sig}) do`,
    ...renderFunctionBodyLines(fn.body, rc),
    "  end",
  ];
}

function renderPureOp(
  appModule: string,
  ctxModule: string,
  ctx: BoundedContextIR,
  op: OperationIR,
): string[] {
  const opSnake = snake(op.name);
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: `${appModule}.${ctxModule}`,
    foundation: "vanilla",
    // No lineage capture in the pure core — that's a persist-path effect; a
    // capture without the draining transaction would orphan the trace buffer.
    captureProvenance: false,
  };
  // EMIT is an effect (PubSub broadcast needs a running server), not domain
  // state — strip it so the core stays pure / Repo-free.  Lets it depends on
  // survive (only the broadcast statement is dropped).
  const stmts = op.statements.filter((s) => s.kind !== "emit");
  const usedParams = op.params.filter((p) => stmts.some((s) => stmtUsesParam(s, p.name)));
  const paramsArg = usedParams.length > 0 ? "params" : "_params";
  const guard = usedParams.length > 0 ? " when is_map(params)" : "";
  const paramBinds = usedParams.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );
  const bodyLines = stmts.map((s, i) => renderReturningStmt(s, ctx, rc, i));
  // A void op returns the mutated struct; a value-returning op's `return`
  // statement is already the body's tail value (renderReturningStmt emits it).
  const tail = isReturningOperation(op) ? [] : ["    record"];
  // A `requires currentUser.<…>` (or any `currentUser` reference) in the body
  // renders `current_user.<…>`, so the pure-core fn must accept the actor — same
  // `current_user \\ nil` arity the context wrapper carries (context-emit.ts).
  // Without this the var is unbound → `mix compile --warnings-as-errors` fails.
  const actorArg = opUsesCurrentUser(op) ? ", current_user \\\\ nil" : "";
  return [
    `  @doc "Pure domain core of \`${op.name}\` — preconditions + in-memory mutation (no persistence)."`,
    `  def ${opSnake}(%__MODULE__{} = record, ${paramsArg}${actorArg})${guard} do`,
    ...paramBinds,
    ...bodyLines,
    ...tail,
    "  end",
  ];
}
