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

import { forApiRead, wireFieldsForAggregate } from "../../../ir/enrich/wire-projection.js";
import { variantTag } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ChannelIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  OperationIR,
  ProvSite,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { escapeElixirIdent, snake, upperFirst } from "../../../util/naming.js";
import { renderPhoenixDomainOperation, renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import { type SourceMapSubRegion, statementSubRegions } from "../../_trace/sourcemap.js";
import { MONEY_WIRE_SCALE } from "../../money-scale.js";
import {
  type ElixirChannelsCfg,
  elixirDispatchCall,
  opEmitsDurableEvent,
} from "../channels-emit.js";
import { contextHasDispatcher } from "../dispatch-emit.js";
import { opUsesCurrentUser } from "../domain/predicates.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import {
  appModuleOf,
  denialClause,
  denialOverrides,
  denialResponse,
  denialTerm,
  disallowedResponse,
  disallowedTerm,
  type ErrorStatusMap,
  guardErrorModule,
  guardRaiseLine,
  opHasWireDenial,
  wireValidationResponse,
} from "./denial.js";
import { collectVanillaLeaves, provColumn, provenancedFieldsOf } from "./provenance-emit.js";
import { isRefCollFieldName, refCollTargetModule } from "./ref-collection-emit.js";

/** One operation body's exact emitted text plus its per-statement
 *  sub-regions — surfaced by `renderReturningOpFunction` (and the sibling
 *  `renderNamedOpFunction` in `context-emit.ts`, which shares this type) when
 *  `opFragments` is passed, to the caller that owns the recorder and the
 *  POOLED per-context module's final content (`emitVanillaContextModule` in
 *  `context-emit.ts`), which anchors it via `SourceMapRecorder.fragment`.
 *
 *  Vanilla has no pre-joined statement renderer to split into a chunked
 *  sibling — `renderReturningStmt` already renders one (possibly multi-line)
 *  string per statement, so the existing per-statement map each caller builds
 *  (`bodyLines`) IS the chunk list; no separate chunk-producing renderer is
 *  needed here (contrast the TS/.NET/Python backends, which pre-join and so
 *  need a `renderXStatementChunks` sibling).  Covers only the REGULAR
 *  (non-extern, non-event-sourced) named/returning operation body path —
 *  extern check bodies, event-sourced init, and appliers are out of scope for
 *  this milestone. */
export interface OpFragment {
  fragmentText: string;
  subRegions: SourceMapSubRegion[];
}

/** The wire field list a returning op's success branch serialises `record`
 *  into — the same ordered `wireShape` the find/CRUD controllers expose, so the
 *  success body matches what `GET /<plural>/:id` returns for the same aggregate.
 *  `forApiRead` drops `internal` / `secret` fields, exactly as the REST
 *  serializer does (RS-25) — an op success body is the same read boundary. */
function wireFieldsOf(agg: AggregateIR): string[] {
  return forApiRead(wireFieldsForAggregate(agg)).map((f) => snake(f.name));
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
  // Second-precision `:utc_datetime` columns — see the truncation note below.
  const datetimeColumns = new Set(
    agg.fields
      .filter((f) => {
        const t = f.type.kind === "optional" ? f.type.inner : f.type;
        return t.kind === "primitive" && t.name === "datetime";
      })
      .map((f) => snake(f.name)),
  );
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
      // FORCE the change: the op body rebinds `record = %{record | f: newval}`
      // BEFORE this changeset is built, so the changeset's DATA already carries the
      // new value.  `put_change/3` DROPS a change whose value equals the data
      // (`Ecto.Type.equal?`), leaving an EMPTY changeset — `Repo.update` then runs
      // no SQL and the operation's write is silently lost.  `force_change/3` stores
      // it regardless, so the assigned column actually persists.
      //
      // A `datetime` column is `:utc_datetime` (SECOND precision — schema-emit's
      // `mapTypeToEcto`), and `force_change` bypasses casting, so a microsecond
      // DateTime — which `now()` renders to (`DateTime.utc_now()`) — makes Ecto
      // refuse the DUMP:
      //
      //     ** (ArgumentError) :utc_datetime expects microseconds to be empty,
      //        got: ~U[2026-08-05 19:32:36.811626Z]
      //
      // …a raw 500 on the operation.  `stamp-emit` already truncates for exactly
      // this reason (its `stampFieldIsDatetime` seam, B7), and `audit-emit` /
      // `provenance-emit` truncate their own `:utc_datetime` writes — the
      // OPERATION assignment path was the one arm that never reached the same
      // rule.  Found 2026-08-05 by the caller-census drain: `softDelete()`
      // (`deletedAt := now()`) got its first runtime caller and 500'd.
      return datetimeColumns.has(f)
        ? `Ecto.Changeset.force_change(:${f}, __truncate_dt(record.${f}))`
        : `Ecto.Changeset.force_change(:${f}, record.${f})`;
    }),
    ...provColumns.map((c) => `Ecto.Changeset.force_change(:${c}, record.${c})`),
  ];
}

/** An operation that declares an `or`-union return type (exception-less). */
export function isReturningOperation(op: OperationIR): boolean {
  return !!op.returnType;
}

/** True when an operation body raises at least one domain event (`emit`).  Such
 *  a body is restructured to persist-then-dispatch (S5a) — the `emit`s are hoisted
 *  out of the interleaved body and fanned out AFTER `persist_change` commits, so
 *  no phantom event fires on a failed write and each event reaches the context
 *  `Dispatcher` (the saga seam), not just the subscriber-less raw broadcast. */
export function opEmitsEvent(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "emit");
}

/** Does an operation carry any `requires`/`precondition` guard?  A guarded op's
 *  HTTP-boundary context fn short-circuits to a typed denial tuple
 *  (`{:error, :forbidden}` / `{:error, :precondition_failed}`) instead of
 *  raising an `ArgumentError` (which the fallback handler would turn into a 500);
 *  the controller maps those to 403 / 422.  Gates both the `with ensure(...)`
 *  body wrap AND the matching controller denial clauses, so the two never
 *  disagree.  A guard-free op stays byte-identical. */
export function opHasGuards(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "requires" || s.kind === "precondition");
}

/** One `requires`/`precondition` statement → an `ensure/2` with-clause.  A
 *  `requires` (authorisation gate) denies with `:forbidden` → 403; a
 *  `precondition` denies with `:precondition_failed` → 422.  Identical atoms +
 *  status mapping to the vanilla workflow (`workflow-execution-emit.ts`) and
 *  ES-command (`eventsourced-emit.ts`) renderers, so every guard path across the
 *  Phoenix backend maps to the same HTTP status. */
function renderOpGuardClause(
  s: Extract<StmtIR, { kind: "requires" | "precondition" }>,
  rc: RenderCtx,
  /** The operation's param names — the request body a wire-rung denial can
   *  point into (M-T6.20).  A messaged `precondition` classified wire-translatable
   *  against this set denies with `{:validation_failed, errors}` instead of the
   *  domain floor; everything else is byte-identical. */
  wireAvailable?: ReadonlySet<string>,
): string {
  return `:ok <- ensure(${renderExpr(s.expr, rc)}, ${denialTerm(s, wireAvailable)})`;
}

/** Does the operation declare a `when` canCommand state gate (criterion.md use
 *  site 2)?  A `when`-gated op evaluates the predicate against the loaded
 *  aggregate BEFORE the body runs; false → 409 Conflict.  Parity gate for the
 *  controller's `{:error, :disallowed}` denial arm + the shared `ensure/2`. */
export function opHasWhenGate(op: OperationIR): boolean {
  return op.when !== undefined;
}

/** The `when` state gate → a leading `:ok <- ensure(<pred>, :disallowed)`
 *  with-clause.  The predicate reads the loaded `record`'s own state (op params
 *  are out of scope by design); a false predicate short-circuits the `with` to
 *  `{:error, {:disallowed, msg}}`, which the controller maps to 409 Conflict —
 *  parity with Hono/​.NET/​Java/​Python's `DisallowedError` → 409, message included
 *  (RS-17).  Rendered FIRST in the guard chain so the state gate precedes any
 *  `precondition`. */
function renderWhenGateClause(aggName: string, op: OperationIR, rc: RenderCtx): string {
  return `:ok <- ensure(${renderExpr(op.when as ExprIR, rc)}, ${disallowedTerm(aggName, op.name)})`;
}

/** All hoisted guard with-clauses for an op, in evaluation order: the `when`
 *  state gate (→ `:disallowed` / 409) first, then each `requires` (→ `:forbidden`
 *  / 403) and `precondition` (→ `:precondition_failed` / 422) in body order.
 *  Byte-identical to the old requires/precondition-only list when the op has no
 *  `when`, so a guard-free / `when`-free op is unchanged. */
export function collectOpGuardClauses(aggName: string, op: OperationIR, rc: RenderCtx): string[] {
  const clauses: string[] = [];
  if (op.when) clauses.push(renderWhenGateClause(aggName, op, rc));
  // The request body a wire-rung denial can point into is the op's own params —
  // the same `available` set `routes-builder.ts` / `_i18n/validation-catalog.ts`
  // classify an `<Op>Request` refine against (M-T6.20).
  const wireAvailable = new Set(op.params.map((p) => p.name));
  for (const s of op.statements) {
    if (s.kind === "requires" || s.kind === "precondition") {
      clauses.push(renderOpGuardClause(s, rc, wireAvailable));
    }
  }
  return clauses;
}

/** Wrap an operation body (its rendered 4-space-indented `bodyLines` + persist
 *  tail) in a leading `with :ok <- ensure(...)` guard chain, so a failed
 *  `requires`/`precondition` short-circuits to `{:error, :forbidden}` /
 *  `{:error, :precondition_failed}` BEFORE any mutation or persist runs — the
 *  controller maps those to 403 / 422 (vs the old `raise(ArgumentError, …)`,
 *  which the fallback handler turned into a 500).  The `with` default `else`
 *  passes the `{:error, atom}` tuple straight through as the function's return
 *  value.  Mirrors the workflow / ES-command `ensure/2` guard shape.  Returns
 *  the wrapped lines (guards hoisted ahead of the body — the guards read only
 *  `record` fields + params, both bound before the `with`). */
export function wrapOpBodyWithGuards(guardClauses: string[], innerLines: string[]): string[] {
  const header = `    with ${guardClauses.join(",\n         ")} do`;
  // Re-indent the body + persist two spaces deeper for the `do` block; skip
  // blank lines so no trailing whitespace is emitted (`mix compile
  // --warnings-as-errors` / Biome would flag it).
  const inner = innerLines.join("\n").replace(/^(?=.)/gm, "  ");
  return [header, inner, "    end"];
}

/** A returning op whose body falls through to its aggregate success variant
 *  (`Order` in `Order or NotFound`) — the only branch that commits a state
 *  change (and thus the only one with an `{:ok, saved}` seam to dispatch after).
 *  Extracted so the controller's `{:error, changeset}` clause gating matches the
 *  body's persist decision exactly. */
export function returningOpHasSuccessPath(op: OperationIR, agg: AggregateIR): boolean {
  const lastIsReturn = op.statements[op.statements.length - 1]?.kind === "return";
  const succeedsWithAggregate =
    op.returnType?.kind === "union" &&
    op.returnType.variants.some((v) => v.kind === "entity" && v.name === agg.name);
  return !lastIsReturn && succeedsWithAggregate;
}

/** Does an op body mutate aggregate state (`assign` / collection or scalar
 *  `add`/`remove`)?  This is exactly the condition under which
 *  `persistPutBodies` is non-empty — its put bodies are keyed off those three
 *  statement kinds (plus the co-located provenance columns, a subset of the
 *  assigned fields).  A mutating returning op MUST persist regardless of its
 *  success-path SHAPE (fall-through vs explicit `return this`) — S12. */
export function opMutatesState(op: OperationIR): boolean {
  return op.statements.some((s) => s.kind === "assign" || s.kind === "add" || s.kind === "remove");
}

/** A returning op has a COMMIT path when its body reaches a success outcome —
 *  either it falls through to the aggregate success variant, or it ends in a
 *  SUCCESS `return` (`return this`, an aggregate-typed value, OR a non-aggregate
 *  success variant like `return Reserved {…}`).  An unconditional trailing ERROR
 *  return has no commit (returning an error must NOT persist a mutation).  This
 *  is what decouples the persist decision from the success-path SHAPE (S12). */
export function returningOpHasCommitPath(
  op: OperationIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): boolean {
  if (returningOpHasSuccessPath(op, agg)) return true; // fall-through to the aggregate
  const last = op.statements[op.statements.length - 1];
  if (last?.kind !== "return") return false;
  return !(last.variantTag !== undefined && isErrorTag(last.variantTag, ctx));
}

/** The body renderer's persist decision — a returning op persists whenever it
 *  has a commit path AND it mutates state / is audited / provenanced / emits
 *  (S5a + S12).  A persisting body can return `{:error, %Ecto.Changeset{}}`, so
 *  the controller's matching validation clause is gated on the SAME predicate
 *  (an unreachable clause trips Elixir 1.18's `--warnings-as-errors`). */
export function returningOpPersistsChangeset(
  op: OperationIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): boolean {
  return (
    returningOpHasCommitPath(op, agg, ctx) &&
    (opMutatesState(op) || op.audited === true || opHasProvSite(op) || opEmitsEvent(op))
  );
}

/** Render the post-commit event-dispatch block for an op body's `emit`
 *  statements (S5a).  Each event struct is bound, the `event_dispatched` catalog
 *  line logged, then the event routed through the context `Dispatcher` (saga
 *  seam — only when the context emits one, mirroring the event-sourced path's
 *  `dispatchLine` gating) AND the raw PubSub broadcast.  Emitted INSIDE the
 *  `{:ok, saved}` branch of `persist_change`, so an event is observed iff the
 *  write committed.  `baseIndent` is the leading whitespace for each line.
 *
 *  M13 (#1704 leftover) — a hoisted `emit` renders OUTSIDE the regular body
 *  `OpFragment` (that fragment deliberately excludes hoisted emits, see its
 *  doc comment above), so it gets its OWN per-emit fragment here: pushed
 *  into the SAME `opFragments` out-param the regular body uses, keyed to
 *  the SAME `construct` — the caller's existing `sourcemap.fragment(path,
 *  content, frag.fragmentText, frag.subRegions)` loop over `opFragments`
 *  (context-emit.ts) picks it up with no changes of its own. */
export function renderEmitDispatchLines(
  op: OperationIR,
  rc: RenderCtx,
  hasDispatcher: boolean,
  baseIndent: string,
  /** Dotted construct id (`Ctx.Agg.op`) — only needed when `opFragments` is
   *  passed. */
  construct?: string,
  /** Source-map Milestone 13 collector (`--sourcemap`) — only allocated by
   *  the caller when a recorder is present (zero cost otherwise). */
  opFragments?: OpFragment[],
  /** Broker channels (M-T4.4 slice 6c) — presence re-routes the dispatch
   *  line through the `<App>.Channels` tee (see channels-emit.ts). */
  channels?: ElixirChannelsCfg,
): string[] {
  const flat = { bind: baseIndent, dispatch: baseIndent, broadcast: baseIndent };
  const lines: string[] = [];
  for (const p of emitParts(op, rc, hasDispatcher, flat, channels)) {
    const emitLines = [...p.bind, ...p.dispatch, ...p.broadcast];
    lines.push(...emitLines);
    if (opFragments && construct) {
      opFragments.push({
        fragmentText: emitLines.join("\n"),
        subRegions: [{ rel: [1, emitLines.length], origin: p.origin, construct }],
      });
    }
  }
  return lines;
}

/** The three PHASES of one hoisted `emit`, kept separable because a DURABLE
 *  channel has to split them across the persist-transaction boundary. */
interface OneEmitParts {
  /** `loom_event_<i> = %<Ctx>.Events.<E>{…}` + the `event_dispatched` narrative
   *  line.  Reads only `record` / params, so it is hoistable ahead of the
   *  transaction — which is what puts the event variable in scope on BOTH
   *  sides of it. */
  bind: string[];
  /** The `Dispatcher` / `<App>.Channels` call.  For a DURABLE channel this is
   *  the `__loom_outbox` INSERT, so it MUST run inside the persist transaction:
   *  "row saved" and "event owed" commit or roll back as one. */
  dispatch: string[];
  /** `Phoenix.PubSub.broadcast(...)` — the SSE / LiveView wire.  MUST run AFTER
   *  the transaction commits.  Inside it, a commit failure still rolls the write
   *  back, but the broadcast has already left: a subscriber observes an event
   *  whose write never happened, and there is no compensating "unsend". */
  broadcast: string[];
  origin: Extract<StmtIR, { kind: "emit" }>["origin"];
}

interface EmitIndents {
  bind: string;
  dispatch: string;
  broadcast: string;
}

/** Per-`emit` phase builder shared by {@link renderEmitDispatchLines} (which
 *  concatenates the three phases back together at one indent — byte-identical
 *  to the pre-split rendering) and {@link renderDurableEmitDispatchParts}. */
function emitParts(
  op: OperationIR,
  rc: RenderCtx,
  hasDispatcher: boolean,
  indents: EmitIndents,
  channels?: ElixirChannelsCfg,
): OneEmitParts[] {
  const appModule = rc.contextModule.split(".")[0]!;
  const out: OneEmitParts[] = [];
  let i = 0;
  for (const s of op.statements) {
    if (s.kind !== "emit") continue;
    const fields = s.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, rc)}`).join(", ");
    const struct = `%${rc.contextModule}.Events.${upperFirst(s.eventName)}{${fields}}`;
    const evVar = `loom_event_${i}`;
    // Narrative line at the dispatch seam — event_type stays a per-event LITERAL
    // (byte-similar to the pre-hoist emit arm; asserted by the obs / narrative-log
    // gates), so a heterogeneous emit list logs each event by name.
    const logCall = renderPhoenixLogCall("eventDispatched", [
      { name: "event_type", valueExpr: `"${upperFirst(s.eventName)}"` },
      ...(rc.agg ? [{ name: "aggregate", valueExpr: `"${upperFirst(rc.agg.name)}"` }] : []),
    ]);
    const dispatchCall = elixirDispatchCall(evVar, rc.contextModule, hasDispatcher, channels);
    out.push({
      bind: [`${indents.bind}${evVar} = ${struct}`, `${indents.bind}${logCall}`],
      dispatch: dispatchCall ? [`${indents.dispatch}${dispatchCall}`] : [],
      broadcast: [
        `${indents.broadcast}Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", ${evVar})`,
      ],
      origin: s.origin,
    });
    i++;
  }
  return out;
}

/** The DURABLE-emit split of {@link renderEmitDispatchLines}: the event binds
 *  hoisted ahead of the persist transaction, the outbox INSERT inside it, and
 *  the PubSub broadcast after it commits.
 *
 *  Why the split exists.  A durable channel's `dispatch` is a table INSERT, so
 *  it has to share the persist transaction — but the broadcast rode along with
 *  it, which meant SSE and LiveView subscribers could observe an event whose
 *  write then failed to commit.  The non-durable branches already document (and
 *  do) the right thing: dispatch AFTER `{:ok, saved}`.  This makes the durable
 *  branch agree, without giving up the outbox's atomicity.
 *
 *  Hoisting the BIND is what makes it possible: `loom_event_<i>` is then in
 *  scope both inside the transaction fn and in the post-commit arm, and the
 *  struct's field expressions read `record` / params, which are bound earlier
 *  still. */
export function renderDurableEmitDispatchParts(
  op: OperationIR,
  rc: RenderCtx,
  hasDispatcher: boolean,
  indents: EmitIndents,
  construct?: string,
  opFragments?: OpFragment[],
  channels?: ElixirChannelsCfg,
): { bind: string[]; dispatch: string[]; broadcast: string[] } {
  const bind: string[] = [];
  const dispatch: string[] = [];
  const broadcast: string[] = [];
  for (const p of emitParts(op, rc, hasDispatcher, indents, channels)) {
    bind.push(...p.bind);
    dispatch.push(...p.dispatch);
    broadcast.push(...p.broadcast);
    // The three phases are no longer contiguous, so the source map anchors on
    // the BIND chunk — the lines that actually carry the `emit`'s own
    // expressions.  (`fragment()` silently skips text it cannot locate, so a
    // split fragment would just lose coverage.)
    if (opFragments && construct) {
      opFragments.push({
        fragmentText: p.bind.join("\n"),
        subRegions: [{ rel: [1, p.bind.length], origin: p.origin, construct }],
      });
    }
  }
  return { bind, dispatch, broadcast };
}

/** Does this aggregate have any public returning operation (→ the controller
 *  needs the shared `problem_variant/5` responder)? */
export function aggregateHasReturningOp(agg: AggregateIR): boolean {
  return agg.operations.some((op) => op.visibility === "public" && isReturningOperation(op));
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
  /** Source-map Milestone 3 collector (`--sourcemap`) — only allocated by the
   *  caller when a recorder is present (zero cost otherwise). */
  opFragments?: OpFragment[],
  /** Broker channels (M-T4.4 slice 6c) — see renderEmitDispatchLines. */
  channels?: ElixirChannelsCfg,
  extraChannels: ChannelIR[] = [],
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
  // `loom.vanilla-document-unsupported`), so the relational projection always
  // applies here.
  const beforeBind = hasAudit
    ? [`    audit_before = ${wireSnapshot("record", false, appModule)}`]
    : [];
  // A body that doesn't end in an explicit `return` falls through to its
  // aggregate success variant (`Order` in `Order or NotFound`) — the mutated
  // `record`.  That fall-through success branch is the only place a state change
  // commits, so it's also the only place an audit / provenance row is recorded.
  // S12: the persist decision is DECOUPLED from the success-path shape.  A
  // returning op persists whenever its body mutates (assign/add/remove →
  // `persistPutBodies` non-empty), is audited/provenanced, or emits — regardless
  // of whether it falls through to the aggregate variant or ends in an explicit
  // `return this`.  Only a body that never commits (a pure read/return, or one
  // ending in an unconditional ERROR return) stays in-memory (no DB round-trip).
  const fallThrough = returningOpHasSuccessPath(op, agg);
  const lastStmt = op.statements[op.statements.length - 1];
  const trailingReturn = lastStmt?.kind === "return" ? lastStmt : undefined;
  const trailingIsError =
    trailingReturn?.variantTag !== undefined && isErrorTag(trailingReturn.variantTag, ctx);
  // A trailing `return this` / aggregate-typed success return commits the same
  // mutated aggregate as a fall-through — normalize it onto the persist path
  // (the success wire projects off `saved`).  A trailing NON-aggregate success
  // return (shape C, `return Reserved {…}`) instead re-renders its own tuple
  // over the persisted struct.
  const trailingIsAggregate =
    trailingReturn !== undefined &&
    !trailingIsError &&
    (trailingReturn.value.kind === "this" || trailingReturn.variantTag === agg.name);
  const persists = returningOpPersistsChangeset(op, agg, ctx);
  // Project the aggregate wire off `saved` for a fall-through OR a normalized
  // trailing `return this` (both yield the aggregate success variant).
  const aggregateSuccess = persists && (fallThrough || trailingIsAggregate);
  // S5a: when the op both persists and emits, the `emit`s are hoisted out of the
  // interleaved body and fanned out (Dispatcher + broadcast) AFTER the write
  // commits, so no phantom event fires on a failed persist and the event reaches
  // the context Dispatcher (saga seam).  A non-persisting emit (a rare emit-only
  // body ending in a non-committing return) keeps the legacy inline emit.
  const hoistEmits = opEmitsEvent(op) && persists;
  const hasDispatcher = contextHasDispatcher(ctx as EnrichedBoundedContextIR, extraChannels);
  // Transactional outbox (dispatch-delivery-semantics.md §1): a DURABLE emit is
  // an `__loom_outbox` INSERT, not a fan-out, so it has to ride the SAME
  // `Repo.transaction` as the persist — see the `txWrapEmits` tail below.  The
  // dispatch lines then sit two columns deeper.
  const txWrapEmits = hoistEmits && opEmitsDurableEvent(op, channels);
  const dispatchLines =
    hoistEmits && !txWrapEmits
      ? renderEmitDispatchLines(
          op,
          renderCtx,
          hasDispatcher,
          "        ",
          `${ctx.name}.${agg.name}.${op.name}`,
          opFragments,
          channels,
        )
      : [];
  // Durable emit: the three phases straddle the transaction — binds ahead of it
  // (so the event var is in scope on both sides), the outbox INSERT inside it,
  // the PubSub broadcast only after it commits.
  const durableEmit = txWrapEmits
    ? renderDurableEmitDispatchParts(
        op,
        renderCtx,
        hasDispatcher,
        { bind: "    ", dispatch: "          ", broadcast: "        " },
        `${ctx.name}.${agg.name}.${op.name}`,
        opFragments,
        channels,
      )
    : { bind: [], dispatch: [], broadcast: [] };
  const lastIdx = op.statements.length - 1;
  // Per-statement index disambiguates provenance temp vars across writes.  When
  // persisting, the hoisted `emit`s and the relocated trailing success `return`
  // are rendered post-commit (below), not inline.  `bodyStmts` is kept
  // alongside `bodyLines` (rather than only the mapped-over result) so a
  // source-map collector can zip the two SAME-length, SAME-order arrays back
  // together via `statementSubRegions` — the hoisted `emit`(s) and the
  // relocated trailing return are deliberately excluded from both, matching
  // the "regular body" scope this milestone covers (see `OpFragment`).
  // The `when` state gate + `requires`/`precondition` guards are hoisted out of
  // the linear body into a leading `with :ok <- ensure(...)` chain (below), so a
  // failed guard returns a typed denial tuple (`:disallowed` 409 / `:forbidden`
  // 403 / `:precondition_failed` 422) instead of raising (→ 500).  Exclude the
  // guard STATEMENTS from the in-body statements (they no longer render inline;
  // the `when` gate is a predicate field, not a statement, so it needs no
  // exclusion).
  const guardClauses = collectOpGuardClauses(agg.name, op, renderCtx);
  const bodyStmts = op.statements.filter((s, idx) => {
    if (s.kind === "requires" || s.kind === "precondition") return false;
    if (hoistEmits && s.kind === "emit") return false;
    if (persists && trailingReturn !== undefined && idx === lastIdx) return false;
    return true;
  });
  const bodyLines = bodyStmts.map((s, i) => renderReturningStmt(s, ctx, renderCtx, i));
  if (opFragments && bodyLines.length > 0) {
    opFragments.push({
      fragmentText: bodyLines.join("\n"),
      subRegions: statementSubRegions(bodyStmts, bodyLines, `${ctx.name}.${agg.name}.${op.name}`),
    });
  }
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
  // RS-21 NOTE — the AGGREGATE success variant of a union-returning op
  // (`operation adjust(): Item or NotFound` falling through, or ending in
  // `return this`) is deliberately left UNTAGGED here, unlike the scalar / none
  // / record variants that `taggedSuccess` tags.  Not because the contract
  // differs: `_payload/union-wire.ts` says every variant carries `type`.  It is
  // because this shape has NO conforming oracle to match — node's domain method
  // for it has no `return` at all (it falls off the end and the route
  // `c.json`s `undefined`), and `return this` spreads a class instance's PRIVATE
  // `_`-prefixed fields.  Tagging vanilla here would be a guess at a contract no
  // shipped backend implements.  Tracked as its own gap; see
  // docs/conformance-semantics.md RS-21.
  const wireMap = (recordVar: string, projectRefColls: boolean): string =>
    `%{${wireFieldsOf(agg)
      .map((f) =>
        projectRefColls && isRefCollFieldName(agg, f)
          ? `${f}: __ref_id_list(${recordVar}.${f})`
          : `${f}: ${recordVar}.${f}`,
      )
      .join(", ")}}`;

  // The persist put bodies + changeset assignment are shared by every persisting
  // shape (6-space indent, inside the `changeset =` block).
  const putBodies = persistPutBodies(
    op,
    agg,
    appModule,
    facadeMod.split(".").slice(1).join("."),
    relationalContainments,
  );
  const putBlock = putBodies.map((b) => `\n      |> ${b}`).join("");

  // The `versioned` counter bump, on the RETURNING-operation write path.
  //
  // `versioned` declares `version: int token = 1`, incremented per command
  // (`src/macros/prelude.ts`), and the named-operation path in `context-emit.ts`
  // already emits `change(%{version: record.version + 1})` — its comment says it
  // "brings the relational/embedded path in line" with the document path.  This
  // arm was never brought in line: it emitted a bare `change(%{})`, so an
  // exception-less `T or Error` operation persisted its field write and left
  // `version` untouched.
  //
  // Not the RS-20 shape (java's Hibernate `@Version` tracks ROW DIRTINESS, so it
  // misses a bump only when nothing actually changed).  Here the write is a real
  // change and the bump is simply absent from one emitter arm — elixir alone,
  // against a capability the other four backends honour, so it is a fix rather
  // than a waiver.
  //
  // Found 2026-08-05 by the caller-census drain: `corpus/operation-returns`'
  // `accept()` (`reserved := true`, returning `: string or NotFound`) read back
  // `version: 2` where every other backend read 3.
  //
  // M-T6.27: the bump now rides `optimistic_lock(:version)` instead of a plain
  // `change(%{version: …+1})` — same +1 on the wire, plus the CAS filter the
  // plain bump lacked, so a raced returning operation raises
  // `Ecto.StaleEntryError` (rescued to `{:error, :conflict}` → 409 in
  // `persist_change/1`) instead of silently overwriting the other writer.
  const versionLock = aggregateIsVersioned(agg)
    ? "\n      |> Ecto.Changeset.optimistic_lock(:version)"
    : "";
  // A trailing NON-aggregate success return (shape C), re-rendered to sit inside
  // the `{:ok, saved}` commit arm over the persisted struct — a preceding
  // `record = saved` rebinds `record`, so the return's `this.*` reads reflect the
  // saved values.
  const shapeCReturn = (): string =>
    renderReturningStmt(trailingReturn!, ctx, renderCtx, lastIdx).trimStart();

  // Derived rows that must commit with the state change (provenance flush /
  // audit record) — hoisted out of the prov/audit branch so the durable-outbox
  // branch below can reuse the same transaction tail.
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
        after: wireSnapshot("saved", false, appModule),
        indent: "          ",
      }),
    );
  }

  let tailLines: string[];
  if (!persists) {
    // Non-committing: a pure read/return (or one ending in an unconditional ERROR
    // return) never touches the DB.  A fall-through returns the in-memory wire
    // projection; an explicit `return` is rendered inline in `bodyLines`.
    // Byte-identical to pre-S12 for these shapes.
    tailLines = fallThrough ? [`    {:ok, ${wireMap("record", false)}}`] : [];
  } else if (txWrapEmits) {
    // Durable emit (dispatch-delivery-semantics.md §1): `Channels.dispatch/2`
    // INSERTs an `__loom_outbox` row instead of fanning out, so persist + the
    // outbox INSERT (+ any prov/audit rows) run in ONE `Repo.transaction` —
    // commit records "this event is owed", rollback erases both.  The result is
    // unwrapped post-commit so the returned tuple shape is unchanged.
    //
    // The PubSub BROADCAST does NOT ride that transaction.  It is the
    // SSE / LiveView wire, and a broadcast inside the tx is observable before
    // the commit: a rollback then leaves subscribers holding an event whose
    // write never happened, with no way to retract it.  So the event struct is
    // bound BEFORE the transaction (that is what keeps `loom_event_<i>` in
    // scope on both sides), the outbox INSERT stays inside, and the broadcast
    // fires in the `{:ok, saved}` arm — the same after-commit ordering the
    // non-durable branch below already documents.
    const txBody = [
      `    tx_result =`,
      `      ${appModule}.Repo.transaction(fn ->`,
      `      case ${repoMod}.persist_change(changeset) do`,
      `        {:ok, saved} ->`,
      ...txTail,
      ...durableEmit.dispatch,
      `          saved`,
      ``,
      `        {:error, reason} ->`,
      `          ${appModule}.Repo.rollback(reason)`,
      `      end`,
      `    end)`,
      ``,
    ];
    tailLines = [
      ...durableEmit.bind,
      ...(durableEmit.bind.length > 0 ? [``] : []),
      `    changeset =`,
      `      record`,
      `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
      ``,
      ...txBody,
      `    case tx_result do`,
      `      {:ok, saved} ->`,
      ...durableEmit.broadcast,
      ...(aggregateSuccess
        ? [`        {:ok, ${wireMap("saved", mutatesRefColl)}}`]
        : [`        record = saved`, `        ${shapeCReturn()}`]),
      ``,
      `      {:error, reason} ->`,
      `        {:error, reason}`,
      `    end`,
    ];
  } else if (hasProv || hasAudit) {
    // Forced transaction: persist the assigned columns, flush provenance and/or
    // record the audit row — all in ONE transaction so the derived rows commit
    // atomically with the state change.  A persist failure rolls back to
    // `{:error, changeset}` (the controller's `_result/2` gains a matching
    // validation clause).
    tailLines = aggregateSuccess
      ? hoistEmits
        ? [
            // Emit + prov/audit: the transaction commits the state change (+ derived
            // rows), then the events are dispatched AFTER commit (outside the tx fn),
            // so a rollback drops them too.
            `    changeset =`,
            `      record`,
            `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
            ``,
            `    tx_result =`,
            `      ${appModule}.Repo.transaction(fn ->`,
            `      case ${repoMod}.persist_change(changeset) do`,
            `        {:ok, saved} ->`,
            ...txTail,
            `          saved`,
            ``,
            `        {:error, reason} ->`,
            `          ${appModule}.Repo.rollback(reason)`,
            `      end`,
            `    end)`,
            ``,
            `    case tx_result do`,
            `      {:ok, saved} ->`,
            ...dispatchLines,
            `        {:ok, ${wireMap("saved", mutatesRefColl)}}`,
            ``,
            `      {:error, reason} ->`,
            `        {:error, reason}`,
            `    end`,
          ]
        : [
            `    changeset =`,
            `      record`,
            `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
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
          ]
      : // Shape C under prov/audit (rare): the transaction returns `saved` so the
        // derived rows commit with it, then the trailing non-aggregate success
        // return is rendered over `saved` post-commit — the tagged tuple is NOT
        // wrapped by `Repo.transaction` (which would double-tag it).
        [
          `    changeset =`,
          `      record`,
          `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
          ``,
          `    tx_result =`,
          `      ${appModule}.Repo.transaction(fn ->`,
          `      case ${repoMod}.persist_change(changeset) do`,
          `        {:ok, saved} ->`,
          ...txTail,
          `          saved`,
          ``,
          `        {:error, reason} ->`,
          `          ${appModule}.Repo.rollback(reason)`,
          `      end`,
          `    end)`,
          ``,
          `    case tx_result do`,
          `      {:ok, saved} ->`,
          `        record = saved`,
          ...dispatchLines,
          `        ${shapeCReturn()}`,
          ``,
          `      {:error, reason} ->`,
          `        {:error, reason}`,
          `    end`,
        ];
  } else if (mutatesRefColl) {
    // Reference-collection mutation (`X id[]` add/remove → a `many_to_many` join
    // table): the body bound an id-list local, so persist it via a `put_assoc`
    // changeset and return the saved wire.  No provenance/audit → no transaction
    // is needed (a single state write); a validation failure surfaces as
    // `{:error, changeset}` (the controller's `_result/2` validation clause).
    tailLines = hoistEmits
      ? [
          `    changeset =`,
          `      record`,
          `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
          ``,
          `    case ${repoMod}.persist_change(changeset) do`,
          `      {:ok, saved} ->`,
          ...dispatchLines,
          `        {:ok, ${wireMap("saved", true)}}`,
          ``,
          `      {:error, changeset} ->`,
          `        {:error, changeset}`,
          `    end`,
        ]
      : [
          `    changeset =`,
          `      record`,
          `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
          ``,
          `    case ${repoMod}.persist_change(changeset) do`,
          `      {:ok, saved} -> {:ok, ${wireMap("saved", true)}}`,
          `      {:error, changeset} -> {:error, changeset}`,
          `    end`,
        ];
  } else if (aggregateSuccess) {
    // S12: a mutating (or emitting) success body — a fall-through OR a normalized
    // trailing `return this` — persists the assigned columns and projects the
    // aggregate wire off the SAVED struct.  Dispatch (if any) fires AFTER
    // `{:ok, saved}`; a validation failure surfaces as `{:error, changeset}` (the
    // controller gains the matching clause via `returningOpPersistsChangeset`).
    tailLines = [
      `    changeset =`,
      `      record`,
      `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
      ``,
      `    case ${repoMod}.persist_change(changeset) do`,
      `      {:ok, saved} ->`,
      ...dispatchLines,
      `        {:ok, ${wireMap("saved", false)}}`,
      ``,
      `      {:error, changeset} ->`,
      `        {:error, changeset}`,
      `    end`,
    ];
  } else {
    // Shape C: a mutating body ending in a NON-aggregate success return
    // (`return Reserved {…}`).  Persist FIRST, rebind `record = saved`, then
    // render the return over the persisted struct so it references saved values.
    tailLines = [
      `    changeset =`,
      `      record`,
      `      |> Ecto.Changeset.change(%{})${putBlock}${versionLock}`,
      ``,
      `    case ${repoMod}.persist_change(changeset) do`,
      `      {:ok, saved} ->`,
      `        record = saved`,
      ...dispatchLines,
      `        ${shapeCReturn()}`,
      ``,
      `      {:error, changeset} ->`,
      `        {:error, changeset}`,
      `    end`,
    ];
  }
  // A guarded op wraps its body + persist in a leading `with ensure(...)` chain
  // (guards short-circuit to `{:error, atom}` before any write); a guard-free op
  // keeps the flat linear body (byte-identical).
  const innerLines = [...bodyLines, ...tailLines];
  const body = (
    guardClauses.length > 0
      ? [...beforeBind, ...paramReads, ...wrapOpBodyWithGuards(guardClauses, innerLines)]
      : [...beforeBind, ...paramReads, ...innerLines]
  ).join("\n");
  // The guard denial adds a TYPED-DENIAL outcome to the result union; the
  // controller's `<op>_<agg>_result/2` gains the matching 403/409/422 clauses.
  //
  // The reason is a 2-TUPLE, not a bare atom: since the typed denial protocol
  // (`denial.ts`) a guard short-circuits to `{:error, {:forbidden, msg}}` /
  // `{:precondition_failed, msg}` / `{:disallowed, msg}` /
  // `{:validation_failed, [%{…}]}` — the tag carries the rung and the second
  // element the RFC 7807 `detail` (or the `errors[]` list).  The spec said
  // `{:error, atom()}`, which no denial this function can produce matches.
  const denialSpec = guardClauses.length > 0 ? " | {:error, {atom(), term()}}" : "";

  return `  @doc "Returning operation \`${op.name}\` on \`${aggPascal}\` (exception-less)."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, term()} | {:error, binary(), map()} | {:error, Ecto.Changeset.t()}${denialSpec}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${opUsesCurrentUser(op) ? ", current_user \\\\ nil" : ""}) when is_map(params) do
${body}
  end`;
}

/** RS-21 — the TAGGED-WIRE shape a SUCCESS variant carries out of a union-
 *  returning operation (`_payload/union-wire.ts`; docs/payloads.md).  Vanilla's
 *  carrier is `{:ok, <value>}`, and the controller `json/2`s `<value>` straight
 *  through — so if the value isn't tagged HERE, the tag never reaches the wire.
 *  That is what diverged: node/.NET/Java/Python ship
 *  `{"type":"string","value":"OR1"}` for `operation accept(): string or NotFound`
 *  while vanilla shipped a bare `"OR1"`, so a client narrowing on `type` (the
 *  whole point of the discriminated union) saw nothing to narrow on.
 *
 *  The three shapes come straight off the IR (`StmtIR.return.variantShape`),
 *  which lowering already resolved:
 *    - `scalar` → `%{type: "<tag>", value: <v>}`
 *    - `none`   → `%{type: "none"}`
 *    - `record` → the value's own map with `type` merged in
 *  An UNTAGGED return (a plain non-union `: string` return) passes through
 *  verbatim — there is no union to discriminate.
 *
 *  `record` is tagged only when the returned value is an OBJECT LITERAL
 *  (`return Reserved { sku: sku }`), which renders to a plain Elixir map that
 *  `Map.put/3` can extend.  A `return this` is left alone: its value is an Ecto
 *  STRUCT, and there is no oracle to copy — node's `{ type, ...this }` spreads
 *  the domain class's PRIVATE `_`-prefixed fields, so no shipped backend gets
 *  that shape right (same gap as the aggregate fall-through; see the wireMap
 *  note below and docs/conformance-semantics.md RS-21). */
function taggedSuccess(value: string, s: Extract<StmtIR, { kind: "return" }>): string {
  const { variantTag, variantShape: shape } = s;
  if (!variantTag || !shape) return value;
  const tag = JSON.stringify(variantTag);
  if (shape === "none") return `%{type: ${tag}}`;
  if (shape === "scalar") return `%{type: ${tag}, value: ${value}}`;
  if (s.value.kind !== "object") return value;
  return `Map.put(${value}, :type, ${tag})`;
}

/** A statement in a returning-op body.  `return` is the terminal tagged tuple;
 *  the guard/mutation/emit forms mirror what the other backends render for a
 *  returning op (exception-less.md "Two-regime split"):
 *
 *  - `precondition`/`requires` render as `if not (…), do: raise(ArgumentError,…)`
 *    guards.  This raise form is used ONLY by the paths where raising is the
 *    correct contract: the PURE domain core (`domain-core-emit.ts`, a Repo-free
 *    in-memory fn the generated ExUnit tests `assert_raise` against), the
 *    document-op body, and pure `function` bodies.  The HTTP-boundary context
 *    fns (`renderReturningOpFunction` here + `renderNamedOpFunction` in
 *    `context-emit.ts`) DON'T reach this arm — they hoist their guards into a
 *    leading `with :ok <- ensure(…)` chain (`renderOpGuardClause` /
 *    `wrapOpBodyWithGuards`) so an expected denial returns `{:error, :forbidden}`
 *    (403) / `{:error, :precondition_failed}` (422), never a 500.
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
        // Error variant → `{:error, "<tag>", <fields-map>}`, and that map is
        // `Map.merge`d verbatim into the RFC 7807 body by `problem_variant/5`
        // as §3.2 extension members.  So it is a WIRE surface, and its keys
        // must be camelCase like every other wire key — but rendering the
        // object through `renderExpr` runs the shared `object` leaf, which
        // snakes names because every OTHER object literal in elixir is a
        // domain-side Ecto map.  That produced `%{min_amount: …,
        // offered_amount: …}` against node/python/dotnet/java's `minAmount` /
        // `offeredAmount` — a cross-backend casing break at the one wire site
        // that does not go through `wireShape`.
        //
        // Fixed by keying off the DECLARED field names and rendering only the
        // VALUES through `renderExpr`, so the domain-side leaf still applies
        // where it should.  It survived every gate because the only golden
        // recording a declared-error body (`operation-returns.json`) uses
        // `error NotFound { resource: string }` — a single-word field, where
        // snake and camel coincide.
        // ATOM keys, matching the base map `problem_variant/5` merges into.
        // A string key would not collide with the base map's `:type` in the
        // MAP, but both would encode to `"type"` in the JSON — so a field
        // named `type` would emit a duplicate key. Atom keys let `Map.merge`
        // resolve that the way it already does for every other member.
        const data =
          s.value.kind === "object"
            ? `%{${s.value.fields.map((f) => `${f.name}: ${renderExpr(f.value, rc)}`).join(", ")}}`
            : `%{value: ${value}}`;
        return `    {:error, ${JSON.stringify(s.variantTag)}, ${data}}`;
      }
      return `    {:ok, ${taggedSuccess(value, s)}}`;
    }
    case "let":
      return `    ${escapeElixirIdent(snake(s.name))} = ${renderExpr(s.expr, rc)}`;
    case "precondition":
    case "requires":
      // Raise form — reached only by the pure-core / document / function paths
      // (HTTP-boundary ops hoist guards to `with ensure(…)` for a 422 / 403
      // denial).  The typed `<App>.GuardError` carries the classification in its
      // `:kind` field, so the `:message` is the SAME `denialMessage(s)` the
      // `ensure` path emits — the author's `message "…"` when there is one
      // (M-T6.20; it used to be forced to the derived form because `guardRescue`
      // routed on the message prefix).
      return guardRaiseLine(s, renderExpr(s.expr, rc), appModuleOf(rc.contextModule));
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
    // RS-1 — the lineage map's OWN members are camelCase, because this map goes
    // on the wire verbatim (RS-18) and every other backend's `ProvLineage`
    // spells them `snapshotId` / `computedValue`.  Only the OUTER key
    // (`<field>_provenance`) is the documented snake_case exception; the
    // `provenance_records` COLUMNS stay snake_case, which is a SQL name, not a
    // wire one.
    `    ${linVar} = %{snapshotId: ${JSON.stringify(prov.snapshotId)}, target: ${targetLit}, inputs: ${inputsVar}, computedValue: record.${field}}`,
    `    record = %{record | ${provColumn(field)}: ${linVar}}`,
    `    _ = ${appModule}.Provenance.record(${linVar})`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Controller action — case over the tagged result.
// ---------------------------------------------------------------------------

/** The `POST /<plural>/:id/<op>` member action for a returning operation:
 *  load the aggregate, run the op, then translate the tagged result — a success
 *  to 200 + body, each error variant to its RFC-7807 ProblemDetails status. */
// A rejected `requires` / `precondition` in an operation / function /
// domain-service body RAISES the typed `<App>.GuardError` (`guardRaise` in
// `denial.ts`, shared with the `function-emit` / `domain-service-emit`
// siblings).  A controller action appends this `rescue` clause so the raise maps
// to the same HTTP status the other backends return — `requires` → 403 (Hono
// `ForbiddenError`), `precondition` → 422 (RS-15 — a domain-floor rejection is
// well-formed-but-semantically-rejected, not malformed; the typed-denial path
// below has always answered 422, so this rescue arm was the odd one out) —
// instead of propagating to Phoenix's default 500.
//
// M-T6.20 — the ROUTING KEY is the exception's `:kind` FIELD, not its message.
// It used to be a `cond` over `String.starts_with?(guard_msg, "Precondition
// failed: ")`, which made the message load-bearing and therefore unwritable: an
// author's `message "…"` missed the prefix and fell to the `reraise` → 500.
// With the classification out of band the detail is free text, and no `reraise`
// arm is needed either — an exception that is not a `<App>.GuardError` is
// simply not rescued and propagates with its own stacktrace (still a 500 for a
// genuine bug, one construct less to keep in lockstep).  Only the STATUS +
// TITLE are resolved (M-T5.20).
export function guardRescue(appModule: string, overrides?: ErrorStatusMap): string {
  return `  rescue
    guard_error in ${guardErrorModule(appModule)} ->
      guard_msg = Exception.message(guard_error)

      case guard_error.kind do
        :forbidden ->
          ${denialResponse("forbidden", "guard_msg", overrides)}

        _ ->
          ${denialResponse("precondition", "guard_msg", overrides)}
      end`;
}

export function renderReturningOpControllerAction(
  /** The APP module (`Api`), not the aliased context (`Sales`) — the rescue
   *  below names `<App>.GuardError`, which lives in the domain root. */
  appModule: string,
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
  // A returning op that MUTATES, is audited/provenanced, or emits from a commit
  // path persists (S12) — a persist validation failure surfaces as
  // `{:error, %Ecto.Changeset{}}`, translated to a 422 (the same shape the
  // generic update/create paths use).  A non-persisting op never produces this
  // 2-tuple, so the clause is omitted (an unreachable clause would trip Elixir
  // 1.18's type checker / `--warnings-as-errors`).  Gated on the SAME predicate
  // as the body renderer so the two never disagree.
  const persists = returningOpPersistsChangeset(op, agg, ctx);
  // A guarded op's body can short-circuit to `{:error, :forbidden}` (403) or
  // `{:error, :precondition_failed}` (422) — the typed denials that replace the
  // old `raise(ArgumentError, …)` (→ 500).  Emit the matching clauses only when
  // the op has a guard (else the clauses would be unreachable — `--warnings-as-
  // errors`).  Same status + ProblemDetails body as the ES-command controller.
  const denialClauses = [
    // The `when` state gate denies with `:disallowed` → 409 Conflict (parity with
    // Hono/​.NET/​Java/​Python's DisallowedError → 409).  Gated on `op.when` alone so
    // a guard-free `when`-gated op still gets its 409 arm (and a `when`-free op
    // never emits an unreachable clause).
    ...(opHasWhenGate(op)
      ? [
          `  def ${resultFn}(conn, {:error, {:disallowed, detail}}),
    do: ${disallowedResponse("detail", denialOverrides(ctx))}`,
        ]
      : []),
    // M-T6.20 — the WIRE-VALIDATION rung: a messaged `precondition` over the op's
    // own request params denies with the `errors[]` 422 the other four backends'
    // lifted request validator produces, not the domain floor.
    ...(opHasWireDenial(op)
      ? [
          `  def ${resultFn}(conn, {:error, {:validation_failed, errors}}),
    do: ${wireValidationResponse()}`,
        ]
      : []),
    ...(opHasGuards(op)
      ? (["forbidden", "precondition"] as const).map((rung) => {
          const { head, body } = denialClause(rung, resultFn, denialOverrides(ctx));
          return `  ${head},\n    do: ${body}`;
        })
      : []),
  ];
  // A scalar money RETURN carries the FIXED money wire scale (RS-12), same as a
  // money field — a bare `%Decimal{}` Jason-encodes at its own scale.  Rounded
  // inline (not via the wire-serialize `__money_round/1`, which is only emitted
  // when the aggregate's own wire shape carries money) for parity with the
  // node/.NET/java/python scalar-return path.
  const scalarMoneyReturn = op.returnType?.kind === "primitive" && op.returnType.name === "money";
  const okClause = scalarMoneyReturn
    ? `  def ${resultFn}(conn, {:ok, success}), do: json(conn, Decimal.round(success, ${MONEY_WIRE_SCALE}))`
    : `  def ${resultFn}(conn, {:ok, success}), do: json(conn, success)`;
  const resultClauses = [
    okClause,
    ...errorVariantsOf(op, ctx).map(
      (v) => `  def ${resultFn}(conn, {:error, ${JSON.stringify(v.tag)}, data}),
    do: problem_variant(conn, ${v.status}, ${JSON.stringify(v.type)}, ${JSON.stringify(v.title)}, data)`,
    ),
    ...denialClauses,
    ...(persists
      ? [
          `  def ${resultFn}(conn, {:error, %Ecto.Changeset{} = changeset}),
    do: ProblemDetails.validation_error_response(conn, changeset)`,
        ]
      : []),
    // A persisting op on a `versioned` aggregate can lose the optimistic-lock
    // race (`persist_change/1` rescues `Ecto.StaleEntryError` to
    // `{:error, :conflict}`) — map it to the shared 409 responder.  Gated so an
    // unversioned/non-persisting op emits no unreachable clause
    // (`--warnings-as-errors`).
    ...(persists && aggregateIsVersioned(agg)
      ? [
          `  def ${resultFn}(conn, {:error, :conflict}),
    do: ProblemDetails.conflict_response(conn)`,
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
    ${renderPhoenixDomainOperation(aggPascal, op.name)}

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id) do
      ${resultFn}(conn, ${ctxModule}.${opSnake}_${aggSnake}(record, attrs${opCallActor}))
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
${guardRescue(appModule, denialOverrides(ctx))}
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
