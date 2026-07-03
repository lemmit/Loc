// ---------------------------------------------------------------------------
// Vanilla operation `or`-union returns — exception-less.md (A3), global plan
// T2.c.  An `operation foo(): Success or NotFound { return NotFound { … } }`
// produces a tagged result the controller translates to HTTP: a success → 200
// with the wire body, an error variant → an RFC-7807 ProblemDetails at the
// variant's mapped status (`errorStatusOverrides[tag] ?? defaultErrorStatus`).
//
// Vanilla's natural carrier is a tagged tuple — the context function returns
// `{:ok, value} | {:error, <tag>, data_map}`, and the controller `case`s on it.
// No per-variant struct module is needed (the data rides as a plain map, the
// same RFC-7807 §3.2 extension shape the other backends emit).  The elixir
// backend emits these un-gated (`validateOperationReturnsUnimplemented`).
// ---------------------------------------------------------------------------

import { variantTag } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  OperationIR,
  ProvSite,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { opUsesCurrentUser } from "../domain/predicates.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import { provColumn, provenancedFieldsOf } from "./provenance-emit.js";
import { isRefCollFieldName, refCollTargetModule } from "./ref-collection-emit.js";

/** The wire field list a returning op's success branch serialises `record`
 *  into — the same ordered `wireShape` the find/CRUD controllers expose, so the
 *  success body matches what `GET /<plural>/:id` returns for the same aggregate. */
function wireFieldsOf(agg: AggregateIR): string[] {
  return (agg.wireShape ?? []).map((f) => snake(f.name));
}

/** The `Ecto.Changeset` put bodies that persist the columns an operation body
 *  assigned (deduped, declaration order) onto the threaded `record` — shared by
 *  the named-op persist tail (`context-emit.ts`) and the returning-op persist
 *  tail here.  An EMBEDDED containment (`embeds_many`/`embeds_one`) round-trips
 *  via `put_embed`; a RELATIONAL containment (`has_many`/`has_one` child table,
 *  §11c) round-trips via `put_assoc` — the schema's `on_replace: :delete` rewrites
 *  the child rows, and the body already rebound `record.<field>` to the mutated
 *  list of part STRUCTS (`renderNew` emits `%Ctx.Part{…}`, mixed with the
 *  preloaded structs), which `put_assoc` accepts.  Scalar columns (incl. the
 *  co-located `<field>_provenance` backing columns the body assigned) via
 *  `put_change`.  Each is a real schema column on the mutated `record`, so
 *  `put_change`/`put_embed`/`put_assoc` is safe.
 *
 *  `relationalContainments` is the set of (snake-cased) containment field names
 *  this aggregate persists as child tables rather than inline jsonb — computed
 *  once by the caller via `usesRelationalContainments`, so the embedded-vs-
 *  relational shape decision is NOT duplicated here (it stays the single
 *  schema-emit predicate). */
export function persistPutBodies(
  op: OperationIR,
  agg: AggregateIR,
  appModule: string,
  ctxModule: string,
  relationalContainments: ReadonlySet<string> = new Set(),
): string[] {
  const containNames = new Set(agg.contains.map((c) => snake(c.name)));
  const assignedFields: string[] = [];
  for (const s of op.statements) {
    // `assign` (`field := v`), collection `add`/`remove` (`items += Item{…}`),
    // and scalar compound `add`/`remove` (`total += n`) all re-bind a real
    // schema column on `record`.
    if (s.kind !== "assign" && s.kind !== "add" && s.kind !== "remove") continue;
    const f = snake(s.target.segments[0] ?? "");
    if (f.length > 0 && !assignedFields.includes(f)) assignedFields.push(f);
  }
  const provNames = new Set(provenancedFieldsOf(agg).map((f) => snake(f.name)));
  const provColumns = assignedFields.filter((f) => provNames.has(f)).map((f) => provColumn(f));
  return [
    ...assignedFields.map((f) => {
      // An EMBEDDED containment (`embeds_many`/`embeds_one`) round-trips via
      // `put_embed`; a RELATIONAL containment (`has_many`/`has_one` child table,
      // §11c) via `put_assoc` (the schema's `on_replace: :delete` rewrites the
      // child rows — `record.<field>` already holds the mutated part structs); a
      // reference collection (`X id[]` → `many_to_many`) resolves its mutated id
      // list back to target structs and `put_assoc`s them (the schema's
      // `on_replace: :delete` rewrites the join rows); plain scalar columns (incl.
      // the provenance backing columns) via `put_change`.
      if (containNames.has(f)) {
        // RELATIONAL: `put_assoc` over the mutated child list, NORMALISED to
        // put_assoc-ready maps by `__put_assoc_parts/1` (the context helper).
        // A bare part STRUCT with a nil PK is NOT inserted by `put_assoc`
        // (Ecto treats a struct as an already-persisted row → empty changeset,
        // verified by boot — the child row silently never persists); a plain map
        // WITH `id` is kept/updated, WITHOUT `id` is inserted.  The helper drops
        // the struct's `__meta__` / timestamps / unloaded `belongs_to` / nil
        // fields so existing rows keep their PK and new ones insert cleanly.
        return relationalContainments.has(f)
          ? `Ecto.Changeset.put_assoc(:${f}, __put_assoc_parts(record.${f}))`
          : `Ecto.Changeset.put_embed(:${f}, record.${f})`;
      }
      const targetMod = refCollTargetModule(appModule, ctxModule, agg, f);
      if (targetMod) {
        // The body bound a local `<field>` holding the new id list (it left
        // `record.<field>` as the loaded assoc so put_assoc can replace it).
        return `Ecto.Changeset.put_assoc(:${f}, __resolve_refs(${f}, ${targetMod}))`;
      }
      return `Ecto.Changeset.put_change(:${f}, record.${f})`;
    }),
    ...provColumns.map((c) => `Ecto.Changeset.put_change(:${c}, record.${c})`),
  ];
}

/** An operation that declares an `or`-union return type (exception-less). */
export function isReturningOperation(op: OperationIR): boolean {
  return !!op.returnType;
}

/** Does this aggregate have any public returning operation (→ the controller
 *  needs the shared `problem_variant/5` responder)? */
export function aggregateHasReturningOp(agg: AggregateIR): boolean {
  return agg.operations.some((op) => op.visibility === "public" && isReturningOperation(op));
}

/** Does any PUBLIC returning op on this aggregate declare an ERROR variant?
 *  Only then does the controller emit a `problem_variant/5` *call* — a returning
 *  op with an error-free return (a scalar like `: string`, or a success-only
 *  union) takes the `{:ok, …}` path exclusively.  Gating the shared
 *  `problem_variant/5` responder on this (not merely "has a returning op")
 *  keeps it from being emitted-but-unused, which trips
 *  `mix compile --warnings-as-errors`. */
export function aggregateHasReturningOpError(agg: AggregateIR, ctx: BoundedContextIR): boolean {
  return agg.operations.some(
    (op) =>
      op.visibility === "public" && isReturningOperation(op) && errorVariantsOf(op, ctx).length > 0,
  );
}

/** A return variant is an *error* iff it names a `kind: "error"` payload in
 *  this context; the other (success) variant is the aggregate itself. */
function isErrorTag(tag: string, ctx: BoundedContextIR): boolean {
  return ctx.payloads.some((p) => p.name === tag && p.kind === "error");
}

/** The error variants of a returning op, with their resolved HTTP status. */
export function errorVariantsOf(
  op: OperationIR,
  ctx: BoundedContextIR,
): Array<{ tag: string; status: number; type: string; title: string }> {
  if (op.returnType?.kind !== "union") return [];
  return op.returnType.variants
    .map((v) => variantTag(v))
    .filter((tag) => isErrorTag(tag, ctx))
    .map((tag) => ({
      tag,
      status: ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag),
      type: errorTypeUri(tag),
      title: errorTitle(tag),
    }));
}

// ---------------------------------------------------------------------------
// Context function — runs the body, returns the tagged result.
// ---------------------------------------------------------------------------

/** `<op>_<agg>(record, params) :: {:ok, term()} | {:error, binary(), map()}`. */
export function renderReturningOpFunction(
  facadeMod: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  op: OperationIR,
  /** Containment fields this aggregate persists as child tables (relational
   *  §11c) — those `put_assoc` rather than `put_embed`.  Caller computes via
   *  `usesRelationalContainments`; empty (the default) keeps embedded output. */
  relationalContainments: ReadonlySet<string> = new Set(),
): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  const opSnake = snake(op.name);
  const aggSnake = snake(agg.name);
  const appModule = facadeMod.split(".")[0]!;
  // A provenanced write-site captures lineage inline and drains it into the
  // history table in a transaction; an audited op records a who/what/when +
  // before/after wire snapshot, INSIDE the same save transaction so the audit
  // row commits atomically with the state change.  Either forces the persist
  // tail to run inside a `Repo.transaction`; where both fire they SHARE one
  // transaction (parity with the non-returning `renderNamedOpFunction` path,
  // and with the node/.NET/Java/Python returning-op instrumentation).
  const hasProv = opHasProvSite(op);
  const hasAudit = op.audited === true;
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
    captureProvenance: hasProv,
    // The enriched aggregate, so the body renderer detects a reference-collection
    // (`X id[]` → `many_to_many`) add/remove and normalises it to an id-list local
    // (the persist tail then `put_assoc`s the resolved structs) — parity with the
    // non-returning `renderNamedOpFunction` path, which sets the same field.
    // Without it the add/remove falls through to the containment-jsonb branch,
    // silently miscompiling the join-table mutation.
    agg: agg as EnrichedAggregateIR,
  };

  // The `params` arg is always referenced by the `when is_map(params)` guard,
  // so it never trips the unused-variable check even when the op has no params
  // (an underscore-prefixed name used in a guard would itself warn).
  const paramReads = op.params.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );
  // The `before` wire snapshot — taken from the ORIGINAL `record` before the
  // body rebinds any field (parity with the non-returning path + the other
  // backends' returning-op `__before` capture).  Relational only: a document
  // aggregate can't carry a named operation on vanilla (validate-gated by
  // `loom.vanilla-document-unsupported`), so the struct-drop snapshot always
  // applies here.
  const beforeBind = hasAudit ? [`    audit_before = ${wireSnapshot("record")}`] : [];
  // Per-statement index disambiguates provenance temp vars across writes.
  const bodyLines = op.statements.map((s, i) => renderReturningStmt(s, ctx, renderCtx, i));

  // A body that doesn't end in an explicit `return` falls through to its
  // aggregate success variant (`Order` in `Order or NotFound`) — the mutated
  // `record`.  That fall-through success branch is the only place a state change
  // commits, so it's also the only place an audit / provenance row is recorded.
  const lastIsReturn = op.statements[op.statements.length - 1]?.kind === "return";
  const succeedsWithAggregate =
    op.returnType?.kind === "union" &&
    op.returnType.variants.some((v) => v.kind === "entity" && v.name === agg.name);
  const hasSuccessPath = !lastIsReturn && succeedsWithAggregate;
  // Did the body add/remove a reference collection (`X id[]` → `many_to_many`)?
  // That mutation edits a join table, so the success path MUST round-trip the DB
  // (a `put_assoc` changeset) rather than return the in-memory projection — and
  // it guarantees the context's `__ref_id_list`/`__resolve_refs` helpers are
  // emitted (`contextUsesRefCollOp`), so the wire projection below can call them.
  const mutatesRefColl = op.statements.some(
    (s) =>
      (s.kind === "add" || s.kind === "remove") &&
      s.collection &&
      isRefCollFieldName(agg, snake(s.target.segments[0] ?? "")),
  );
  // The wire map the success branch returns — the same ordered `wireShape` the
  // CRUD controllers expose, projected off the SAVED struct so it reflects the
  // persisted state (no struct leaks `__meta__`/`__struct__` onto the wire).  A
  // reference-collection field projects to its id list (`__ref_id_list/1`, the
  // CRUD controller's `__ref_ids` analogue) so the wire carries ids, not the
  // loaded `many_to_many` structs — but only when the op mutated a ref coll,
  // which is exactly when that context helper is emitted.
  const wireMap = (recordVar: string, projectRefColls: boolean): string =>
    `%{${wireFieldsOf(agg)
      .map((f) =>
        projectRefColls && isRefCollFieldName(agg, f)
          ? `${f}: __ref_id_list(${recordVar}.${f})`
          : `${f}: ${recordVar}.${f}`,
      )
      .join(", ")}}`;

  let tailLines: string[];
  if (hasSuccessPath && (hasProv || hasAudit)) {
    // Forced transaction: persist the assigned columns, flush provenance and/or
    // record the audit row, then return the wire-ready success tuple — all in
    // ONE transaction so the derived rows commit atomically with the state
    // change.  A persist failure rolls back to `{:error, changeset}` (the
    // controller's `_result/2` gains a matching validation clause).
    const putBodies = persistPutBodies(
      op,
      agg,
      appModule,
      facadeMod.split(".").slice(1).join("."),
      relationalContainments,
    );
    const putBlock6 = putBodies.map((b) => `\n      |> ${b}`).join("");
    const txTail: string[] = [];
    if (hasProv) txTail.push(`          ${appModule}.Provenance.flush(${appModule}.Repo)`);
    if (hasAudit) {
      txTail.push(
        auditRecordCall({
          appModule,
          operationId: `${op.name}${aggPascal}`,
          action: op.name,
          targetType: aggPascal,
          targetId: "saved.id",
          before: "audit_before",
          after: wireSnapshot("saved"),
          indent: "          ",
        }),
      );
    }
    tailLines = [
      `    changeset =`,
      `      record`,
      `      |> Ecto.Changeset.change(%{})${putBlock6}`,
      ``,
      `    ${appModule}.Repo.transaction(fn ->`,
      `      case ${repoMod}.persist_change(changeset) do`,
      `        {:ok, saved} ->`,
      ...txTail,
      `          ${wireMap("saved", mutatesRefColl)}`,
      ``,
      `        {:error, reason} ->`,
      `          ${appModule}.Repo.rollback(reason)`,
      `      end`,
      `    end)`,
    ];
  } else if (hasSuccessPath && mutatesRefColl) {
    // Reference-collection mutation (`X id[]` add/remove → a `many_to_many` join
    // table): the body bound an id-list local, so persist it via a `put_assoc`
    // changeset and return the saved wire.  No provenance/audit → no transaction
    // is needed (a single state write); a validation failure surfaces as
    // `{:error, changeset}` (the controller's `_result/2` validation clause).
    const putBodies = persistPutBodies(
      op,
      agg,
      appModule,
      facadeMod.split(".").slice(1).join("."),
      relationalContainments,
    );
    const putBlock = putBodies.map((b) => `\n      |> ${b}`).join("");
    tailLines = [
      `    changeset =`,
      `      record`,
      `      |> Ecto.Changeset.change(%{})${putBlock}`,
      ``,
      `    case ${repoMod}.persist_change(changeset) do`,
      `      {:ok, saved} -> {:ok, ${wireMap("saved", true)}}`,
      `      {:error, changeset} -> {:error, changeset}`,
      `    end`,
    ];
  } else if (hasSuccessPath) {
    // Unaudited / non-provenanced success with no ref-collection mutation: the
    // in-memory wire projection (no DB round-trip — byte-identical to the
    // pre-audit emission for `assign`-only / scalar-arithmetic bodies).
    tailLines = [`    {:ok, ${wireMap("record", false)}}`];
  } else {
    tailLines = [];
  }
  const body = [...beforeBind, ...paramReads, ...bodyLines, ...tailLines].join("\n");

  return `  @doc "Returning operation \`${op.name}\` on \`${aggPascal}\` (exception-less)."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, term()} | {:error, binary(), map()} | {:error, Ecto.Changeset.t()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${opUsesCurrentUser(op) ? ", current_user \\\\ nil" : ""}) when is_map(params) do
${body}
  end`;
}

/** A statement in a returning-op body.  `return` is the terminal tagged tuple;
 *  the guard/mutation/emit forms mirror what the other backends render for a
 *  returning op (exception-less.md "Two-regime split"):
 *
 *  - `precondition`/`requires` are bug-shaped guards — they **raise** (the
 *    aggregate-internal 500 / forbidden path), not return a typed error.
 *  - `assign field := value` mutates the threaded `record` struct so the
 *    fall-through success branch serialises the updated aggregate.
 *  - `emit` broadcasts a domain event over `Phoenix.PubSub` (the same form the
 *    vanilla workflow body emits).
 *
 *  `add`/`remove` collection mutations struct-rebind the threaded `record`'s
 *  containment list (jsonb `{:array, :map}`) or arithmetic on a scalar column.
 *  A bare `call` (`f(args)`) lowers to a discarding no-op — vanilla emits no
 *  aggregate-`function` helpers, so there is no callable target, and a bare
 *  call discards its result anyway.  The switch is now exhaustive over
 *  `StmtIR` — there is no `# TODO` fallthrough. */
export function renderReturningStmt(
  s: StmtIR,
  ctx: BoundedContextIR,
  rc: RenderCtx,
  /** Statement position in the body — disambiguates the per-capture temp
   *  vars (`__lin_<i>` / `__prov_inputs_<i>`) when an op has multiple
   *  provenanced writes.  Unused unless `rc.captureProvenance` is set. */
  index = 0,
): string {
  switch (s.kind) {
    case "return": {
      // A tail sibling-operation self-call (`return reserve()`) passes its
      // tagged tuple through UNCHANGED — the callee's context fn already returns
      // `{:ok,_} | {:error,_}`, the same shape this op returns, so wrapping it in
      // another `{:ok, …}` would double-tag.  (`render-expr.ts` renders the call
      // as `<op>_<agg>(record, params)`; non-tail op-calls are rejected up front
      // by `loom.vanilla-op-call-position`, so an op-call only ever reaches here
      // as the whole return value.)
      if (s.value.kind === "call" && s.value.callKind === "private-operation") {
        return `    ${renderExpr(s.value, rc)}`;
      }
      const value = renderExpr(s.value, rc);
      if (s.variantTag && isErrorTag(s.variantTag, ctx)) {
        // Error variant → `{:error, "<tag>", <fields-map>}`.  A record value
        // renders to an Elixir map already; wrap a non-map value defensively.
        const data = s.value.kind === "object" ? value : `%{value: ${value}}`;
        return `    {:error, ${JSON.stringify(s.variantTag)}, ${data}}`;
      }
      return `    {:ok, ${value}}`;
    }
    case "let":
      return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, rc)}`;
    case "precondition":
      // Bug-shaped guard → raises (aggregate-internal 500 ProblemDetails).
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`;
    case "requires":
      // Authorization guard → raises (translated to a forbidden response).
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`;
    case "assign": {
      // `field := value` → struct-update the threaded `record`, so the
      // fall-through success branch serialises the mutated aggregate.
      const field = snake(s.target.segments[0] ?? "");
      const write = `    record = %{record | ${field}: ${renderExpr(s.value, rc)}}`;
      // A provenanced write (named-op persist path only) wraps the struct
      // update with lineage capture: snapshot the leaf inputs BEFORE the
      // mutation (so a self-referential `x := x + n` records the pre-write
      // value), do the write, build the lineage, route it to the co-located
      // backing column AND the per-process trace buffer (drained in the save
      // transaction).
      if (rc.captureProvenance && s.prov) {
        return renderProvenancedAssign(field, s.prov, s.value, rc, index);
      }
      return write;
    }
    case "add": {
      // `items += Item{...}` (collection) appends to the threaded record's
      // containment list (stored `{:array, :map}` jsonb); a scalar `total += n`
      // (collection:false) is arithmetic on the column.  Both re-bind `record`
      // so the persist step (context-emit) `put_change`s the mutated field.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, rc);
      // A reference collection (`party += pokemon`, `X id[]`) is a `many_to_many`
      // relationship whose preloaded value is target STRUCTS — not ids.  Bind the
      // new id set to a local (`party = __ref_id_list(record.party) ++ [id]`)
      // WITHOUT overwriting `record.party` (it must stay the loaded assoc so the
      // persist's `put_assoc` can replace it cleanly).  The persist reads the
      // local, resolves to structs, and `put_assoc`s.
      if (s.collection && rc.agg && isRefCollFieldName(rc.agg, field)) {
        return `    ${field} = __ref_id_list(record.${field}) ++ [${value}]`;
      }
      return s.collection
        ? `    record = %{record | ${field}: (record.${field} || []) ++ [${value}]}`
        : `    record = %{record | ${field}: record.${field} + ${value}}`;
    }
    case "remove": {
      // `items -= x` drops the first matching element; scalar `n -= x` subtracts.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, rc);
      if (s.collection && rc.agg && isRefCollFieldName(rc.agg, field)) {
        return `    ${field} = List.delete(__ref_id_list(record.${field}), ${value})`;
      }
      return s.collection
        ? `    record = %{record | ${field}: List.delete(record.${field} || [], ${value})}`
        : `    record = %{record | ${field}: record.${field} - ${value}}`;
    }
    case "emit": {
      // Broadcast a domain event — same form the vanilla workflow body emits.
      const fields = s.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, rc)}`).join(", ");
      const appModule = rc.contextModule.split(".")[0]!;
      const struct = `%${rc.contextModule}.Events.${upperFirst(s.eventName)}{${fields}}`;
      // Narrative line at the dispatch seam (catalog `event_dispatched`) before
      // the broadcast.  The host module declares `require Logger`.
      const logCall = renderPhoenixLogCall("eventDispatched", [
        { name: "event_type", valueExpr: `"${upperFirst(s.eventName)}"` },
        ...(rc.agg ? [{ name: "aggregate", valueExpr: `"${upperFirst(rc.agg.name)}"` }] : []),
      ]);
      return `    ${logCall}\n    Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", ${struct})`;
    }
    case "expression":
      return `    _ = ${renderExpr(s.expr, rc)}`;
    case "call": {
      const args = s.args.map((a) => renderExpr(a, rc));
      if (s.target === "function") {
        // `f(args)` — a bare call to an aggregate `function` (§11b).  Those are
        // now emitted (`function-emit.ts` on the context-facade module, the pure
        // core on the schema module — whichever module this body renders into),
        // taking the aggregate struct as the first arg, so the call resolves.
        // The result is discarded (a bare call is a statement); bind to `_`.
        const call =
          args.length > 0
            ? `${snake(s.name)}(${rc.thisName}, ${args.join(", ")})`
            : `${snake(s.name)}(${rc.thisName})`;
        return `    _ = ${call}`;
      }
      // A `private-operation` target has no vanilla helper (private ops are not
      // emitted on vanilla), and a bare call discards its result anyway, so it
      // lowers to a no-op that still threads `record` — keeping the body
      // compilable under `--warnings-as-errors` without an undefined reference.
      const argTuple = args.length ? `{${args.join(", ")}}` : "nil";
      return `    _ = ${argTuple}  # vanilla: bare call to '${s.name}' (no callable target); record unchanged`;
    }
    case "variant-match":
      // Frontend-only effect statement (Stage 2) — gated to action bodies.
      throw new Error(
        "variant-match statement is frontend-only; it must not reach the vanilla Elixir backend",
      );
  }
}

/** Render a provenanced `field := value` write with inline lineage capture.
 *  Mirrors the Hono `withTrace` / .NET `withProvCapture` shape, in Elixir's
 *  immutable struct-rebind idiom. */
function renderProvenancedAssign(
  field: string,
  prov: ProvSite,
  value: ExprIR,
  rc: RenderCtx,
  index: number,
): string {
  const appModule = rc.contextModule.split(".")[0]!;
  // No leading underscore — these are READ after being set, and Elixir's
  // `--warnings-as-errors` flags a used `_`-prefixed var.  The `loom_` prefix
  // avoids collision with any snake-cased param/let local.
  const inputsVar = `loom_prov_inputs_${index}`;
  const linVar = `loom_lineage_${index}`;
  const inputs = collectVanillaLeaves(value, rc)
    .map((l) => `%{path: ${JSON.stringify(l.path)}, value: ${l.value}}`)
    .join(", ");
  const targetLit = `%{type: ${JSON.stringify(prov.target.type)}, field: ${JSON.stringify(prov.target.field)}}`;
  return [
    `    ${inputsVar} = [${inputs}]`,
    `    record = %{record | ${field}: ${renderExpr(value, rc)}}`,
    `    ${linVar} = %{snapshot_id: ${JSON.stringify(prov.snapshotId)}, target: ${targetLit}, inputs: ${inputsVar}, computed_value: record.${field}}`,
    `    record = %{record | ${provColumn(field)}: ${linVar}}`,
    `    _ = ${appModule}.Provenance.record(${linVar})`,
  ].join("\n");
}

/** Bounded walk over a provenanced write's RHS collecting leaf inputs — the
 *  `this`-props, params and let-bindings (and member chains rooted at them)
 *  that fed the value, each rendered to its current Elixir value.  Lambdas are
 *  skipped (their bodies reference lambda-local params, not stored leaves).
 *  Elixir sibling of the TS/.NET `collectLeaves`. */
function collectVanillaLeaves(
  e: ExprIR,
  rc: RenderCtx,
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderExpr(e, rc) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderExpr(e, rc) });
      break;
    case "method-call":
      collectVanillaLeaves(e.receiver, rc, out);
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "call":
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "paren":
      collectVanillaLeaves(e.inner, rc, out);
      break;
    case "unary":
      collectVanillaLeaves(e.operand, rc, out);
      break;
    case "binary":
      collectVanillaLeaves(e.left, rc, out);
      collectVanillaLeaves(e.right, rc, out);
      break;
    case "ternary":
      collectVanillaLeaves(e.cond, rc, out);
      collectVanillaLeaves(e.then, rc, out);
      collectVanillaLeaves(e.otherwise, rc, out);
      break;
  }
  return out;
}

/** Dotted source-side path for a member-access chain (e.g. `line.price`). */
function leafPath(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "this") return "this";
  if (e.kind === "member") return `${leafPath(e.receiver)}.${e.member}`;
  return "<expr>";
}

// ---------------------------------------------------------------------------
// Controller action — case over the tagged result.
// ---------------------------------------------------------------------------

/** The `POST /<plural>/:id/<op>` member action for a returning operation:
 *  load the aggregate, run the op, then translate the tagged result — a success
 *  to 200 + body, each error variant to its RFC-7807 ProblemDetails status. */
export function renderReturningOpControllerAction(
  ctxModule: string,
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
): string {
  const opSnake = snake(op.name);
  const aggSnake = snake(agg.name);
  const aggPascal = upperFirst(agg.name);
  // The tagged-result dispatch lives in a dedicated `<op>_<agg>_result/2`
  // helper rather than an inline `case` so Elixir 1.18's type checker can't
  // narrow the scrutinee to the op's exact inferred result (e.g. an op whose
  // body always rejects infers `{:error, …}`-only, which would flag the
  // `{:ok, _}` arm — and vice-versa).  A multi-clause private fn keeps every
  // outcome reachable.
  const resultFn = `${opSnake}_${aggSnake}_result`;
  // Public (not `defp`): Elixir 1.18 infers a private fn's parameter type
  // from its (single) call site, so a `defp` helper would re-trigger an
  // "unused clause" warning for whichever outcome this op's body can't
  // produce.  A public fn keeps the parameter at its full clause domain.
  // An audited / provenanced returning op persists its mutated columns inside a
  // forced transaction, so a persist validation failure surfaces as
  // `{:error, %Ecto.Changeset{}}` — translated to a 422 (the same shape the
  // generic update/create paths use).  Unaudited ops never persist, so they
  // never produce this 2-tuple and the clause is omitted (an unreachable clause
  // would trip Elixir 1.18's type checker / `--warnings-as-errors`).
  const persists = op.audited === true || opHasProvSite(op);
  const resultClauses = [
    `  def ${resultFn}(conn, {:ok, success}), do: json(conn, success)`,
    ...errorVariantsOf(op, ctx).map(
      (v) => `  def ${resultFn}(conn, {:error, ${JSON.stringify(v.tag)}, data}),
    do: problem_variant(conn, ${v.status}, ${JSON.stringify(v.type)}, ${JSON.stringify(v.title)}, data)`,
    ),
    ...(persists
      ? [
          `  def ${resultFn}(conn, {:error, %Ecto.Changeset{} = changeset}),
    do: ProblemDetails.validation_error_response(conn, changeset)`,
        ]
      : []),
  ].join("\n\n");
  // An op whose guard/body references `currentUser` needs `current_user`
  // threaded into the context call (the context fn carries the matching
  // `current_user \\ nil` arity); bind it off `conn.assigns`.
  const opActor = opUsesCurrentUser(op);
  const opCuBind = opActor ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
  const opCallActor = opActor ? ", current_user" : "";
  return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])
${opCuBind}    ${renderPhoenixLogCall("operationInvoked", [
    { name: "aggregate", valueExpr: `"${aggPascal}"` },
    { name: "op", valueExpr: `"${op.name}"` },
    { name: "id", valueExpr: "id" },
  ])}

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id) do
      ${resultFn}(conn, ${ctxModule}.${opSnake}_${aggSnake}(record, attrs${opCallActor}))
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end

${resultClauses}`;
}

/** The shared per-controller responder for an error variant — RFC-7807
 *  envelope + the variant's own fields as §3.2 extension members. */
export function renderProblemVariantHelper(): string {
  return `  defp problem_variant(conn, status, type, title, data) do
    body =
      Map.merge(
        %{type: type, title: title, status: status, detail: title, instance: conn.request_path},
        data
      )

    conn
    |> put_resp_content_type("application/problem+json")
    |> put_status(status)
    |> json(body)
  end`;
}
