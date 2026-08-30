// ---------------------------------------------------------------------------
// Vanilla context module — `lib/<app>/<ctx>.ex`.  Slices 1, 2, 5c of
// vanilla-foundation-tdd-plan.md.
//
// Plain Elixir context module.  Façade that
// re-exports the per-aggregate Repository functions plus named-
// operation handlers (Slice 5c prerequisite — workflows on vanilla
// need `<op>_<agg>(record, params)` for cross-aggregate operation
// calls in the workflow body).
// ---------------------------------------------------------------------------

import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ChannelIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  OperationIR,
  StmtIR,
  SystemIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { stmtUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lifecycleGates, lifecycleGatesUseCurrentUser } from "../../../ir/util/op-gates.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { walkStmtExprsDeep } from "../../../ir/util/walk.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import { statementSubRegions } from "../../_trace/sourcemap.js";
import { type ElixirChannelsCfg, opEmitsDurableEvent } from "../channels-emit.js";
import { contextHasDispatcher } from "../dispatch-emit.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import { renderReadingServiceContextFns } from "../domain-service-emit.js";
import { unguardedName } from "../lifecycle-seam.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { aggregateHasResidualInvariants } from "./changeset-invariant-emit.js";
import { denialTerm } from "./denial.js";
import {
  isVanillaDocAgg,
  renderDocNamedOpFunction,
  renderDocReturningOpFunction,
} from "./document-emit.js";
import {
  customFindsOfAgg,
  esContextNeedsEnsure,
  isEventSourced,
  renderEnsureHelper,
  renderEsContextBlock,
} from "./eventsourced-emit.js";
import { externImplModule, externPersistForceChanges, isExternOp } from "./extern-emit.js";
import { renderAggregateFunctions } from "./function-emit.js";
import { isAbstractBase } from "./inheritance-emit.js";
import {
  collectOpGuardClauses,
  isReturningOperation,
  type OpFragment,
  opEmitsEvent,
  opHasGuards,
  opHasWhenGate,
  persistPutBodies,
  renderDurableEmitDispatchParts,
  renderEmitDispatchLines,
  renderReturningOpFunction,
  renderReturningStmt,
  wrapOpBodyWithGuards,
} from "./operation-returns-emit.js";
import { refCollFieldNames } from "./ref-collection-emit.js";
import { customFindsOf } from "./repository-emit.js";
import { emitsRestDelete } from "./rest-surface.js";
import { usesRelationalContainments } from "./schema-emit.js";
import { stampUsesPrincipal } from "./stamp-emit.js";

// ---------------------------------------------------------------------------
// The canonical `create` / `destroy` authorization gate — IN THE CONTEXT.
//
// Every other backend gates at its own request-side chokepoint (route, Mediator
// handler, service).  Phoenix cannot: it is the ONE backend whose frontend runs
// IN-PROCESS, so a controller-level gate has a second front door and the
// scaffolded LiveView walks straight through it —
//
//     new-form submit      → <Ctx>.create_<agg>(params)
//     DestroyForm button   → <Ctx>.destroy_<agg>!(id)
//
// — neither of which passes through a controller.  The context function is the
// narrowest point ALL callers share, so gating there makes Phoenix's placement
// converge with the other four rather than diverge from them: each backend gates
// at its own chokepoint.
//
// The principal is threaded as an EXPLICIT argument, not read ambiently.  The
// REST plug assigns `conn.assigns.current_user` in the HTTP request process; a
// LiveView is a SEPARATE socket process with its own `socket.assigns
// .current_user`, so `Process.get(:loom_current_user)` is nil there — an
// ambient-principal gate would fail closed on every LiveView write, silently
// breaking the default-scaffolded UI.  An explicit `current_user \\ nil` arg is
// also the local precedent (principal-filtered reads already carry one).
//
// A nil principal DENIES (`not is_nil(current_user) and (<pred>)`) instead of
// raising BadMapError on `nil.<claim>` — an internal caller with no principal
// (a workflow create step, a seed) then gets the typed `{:error, {:forbidden,
// …}}` its `with` chain already handles, rather than a 500.
// ---------------------------------------------------------------------------

/** The `ensure(...)` with-clauses for one lifecycle action's gates, in
 *  declaration order.  Same `ensure/2` + `denialTerm` protocol as the operation
 *  guard chain, so a denial is the same `{:error, {:forbidden, msg}}` term every
 *  controller / LiveView clause already knows. */
function lifecycleEnsureClauses(
  action: OperationIR | null | undefined,
  rc: RenderCtx,
): readonly string[] {
  return lifecycleGates(action).map((g) => {
    const pred = renderExpr(g.expr, rc);
    const guarded = stmtUsesCurrentUser(g) ? `not is_nil(current_user) and (${pred})` : `(${pred})`;
    return `:ok <- ensure(${guarded}, ${denialTerm(g)})`;
  });
}

/** The `current_user` parameter a guarded lifecycle function takes.  Underscored
 *  when nothing in the emitted body reads it — an unused binding is a `mix
 *  compile --warnings-as-errors` failure (C1 of the M-T3.16 plan), and a
 *  principal-only gate on one aggregate sits beside a row-only gate on the next,
 *  so this cannot be answered once per context. */
function principalParam(used: boolean): string {
  return used ? "current_user \\\\ nil" : "_current_user \\\\ nil";
}

/** Operation names whose `<op>_<agg>` collide with the CRUD
 *  defdelegates emitted above (list/get/create/update/delete).  Skipped
 *  for named-op emission to avoid Elixir function-clause redefinition.
 *  Exported so the controller emitter (`api-emit.ts`) only mounts a
 *  per-operation member route for ops that actually have a `<op>_<agg>`
 *  context function — CRUD-verb-named ops are served by the generic
 *  create/update/delete routes instead, exactly as the named-op emission
 *  here skips them. */
export const CRUD_RESERVED_NAMES = new Set([
  "create",
  "update",
  "delete",
  "destroy",
  "list",
  "get",
]);

export function emitVanillaContextModule(
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sys?: SystemIR,
  sourcemap?: SourceMapRecorder,
  /** Broker channels (M-T4.4 slice 6c) — re-routes op-emit dispatch lines
   *  through the `<App>.Channels` tee (see channels-emit.ts). */
  channels?: ElixirChannelsCfg,
  extraChannels: ChannelIR[] = [],
): void {
  const ctxSnake = snake(ctx.name);
  const ctxModule = upperFirst(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  const path = `lib/${appSnake}/${ctxSnake}.ex`;
  // This is the POOLED per-context module — every aggregate's CRUD facade
  // plus named/returning-op bodies land in ONE file, so (unlike a
  // per-aggregate file) there is no single IR node whose `origin` a
  // whole-file `sourcemap.file(...)` region could honestly point at; that's
  // a deliberate milestone-1 decision (see docs/old/plans/
  // source-map-debug-kickoff.md).  What we CAN record honestly is
  // statement-granular sub-regions inside each operation body — anchored by
  // exact-text search against THIS file's own final content, independent of
  // any whole-file region.
  const opFragments: OpFragment[] | undefined = sourcemap ? [] : undefined;
  const content = renderContextModule(
    appModule,
    ctxModule,
    ctx,
    sys,
    opFragments,
    channels,
    extraChannels,
  );
  out.set(path, content);
  if (sourcemap && opFragments) {
    for (const frag of opFragments) {
      sourcemap.fragment(path, content, frag.fragmentText, frag.subRegions);
    }
  }
}

/**
 * Bind one named-operation param out of the raw request map, COERCED to the
 * runtime form its declared type has.
 *
 * The op path hands the domain body `Map.get(params, "<name>")` — the value
 * straight off the decoded JSON — and the body then `force_change`s it onto the
 * aggregate.  `force_change` bypasses casting by design, so whatever the wire
 * carried is what Ecto tries to DUMP:
 *
 *     ** (Ecto.ChangeError) value `"7.25"` for `D.Shop.Order.total` in `update`
 *        does not match type :decimal
 *
 * …a 500 on any operation that assigns a `money`/`decimal`/`datetime` field
 * from a param, on every `platform: elixir` system that has one.  The four
 * other backends never see it: each deserializes the request into a TYPED DTO
 * (zod / pydantic / jackson / System.Text.Json) before the domain call, so the
 * param arrives already in its declared type.  Elixir alone passed a raw string.
 *
 * Only the two wire-form-vs-runtime-form mismatches are coerced — a JSON number
 * is already an integer/float, a JSON bool a boolean, a JSON string a string —
 * so every other param binds byte-identically to before.
 *
 * Found 2026-08-05 by the caller-census drain: `corpus/embedded`'s
 * `retotal(amount: money)` got its first runtime caller and 500'd.  (The crudish
 * `update` route never hit it because it runs the params through a real
 * `update_changeset`, which casts.)
 */
function coerceOpParam(varName: string, type: TypeIR | undefined): string {
  const t = type?.kind === "optional" ? type.inner : type;
  if (t?.kind !== "primitive") return varName;
  switch (t.name) {
    case "money":
    case "decimal":
      // `to_string` first so a JSON number (`7.25`) and a JSON string (`"7.25"`)
      // both land on the same Decimal — the wire allows either.
      return `(if is_nil(${varName}), do: nil, else: Decimal.new(to_string(${varName})))`;
    case "datetime":
      // `:utc_datetime` wants a DateTime struct; the wire is ISO-8601 text.
      return `(case ${varName} do\n      nil -> nil\n      %DateTime{} = __dt -> __dt\n      __s when is_binary(__s) -> (case DateTime.from_iso8601(__s) do\n        {:ok, __d, _} -> DateTime.truncate(__d, :second)\n        _ -> __s\n      end)\n      __other -> __other\n    end)`;
    default:
      return varName;
  }
}

function renderContextModule(
  appModule: string,
  ctxModule: string,
  ctx: BoundedContextIR,
  sys?: SystemIR,
  opFragments?: OpFragment[],
  channels?: ElixirChannelsCfg,
  extraChannels: ChannelIR[] = [],
): string {
  const facadeMod = `${appModule}.${ctxModule}`;
  const blocks = ctx.aggregates.map((agg) => {
    // Event-sourced aggregates expose create/get/list + per-op command
    // runners (emit→append→fold) instead of the CRUD defdelegates.
    if (isEventSourced(agg)) {
      return renderEsContextBlock(appModule, ctxModule, agg, customFindsOfAgg(ctx, agg));
    }
    const aggPascal = upperFirst(agg.name);
    const aggSnake = snake(agg.name);
    const repoMod = `${facadeMod}.${aggPascal}Repository`;
    // An abstract inheritance base is never instantiated — its façade is
    // READ-ONLY: `list_<base>s` / `get_<base>` over the polymorphic reader, no
    // create/update/delete/change defdelegates (there is no changeset / write
    // seam to delegate to).  Emitting them would reference functions the
    // read-only base repository never defines.
    if (isAbstractBase(agg)) {
      return `  # ${aggPascal} (abstract base — read-only polymorphic reader)
  defdelegate list_${aggSnake}s(), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id), to: ${repoMod}, as: :find_by_id
`;
    }
    // A principal (tenancy) filter threads the request actor through the read
    // seam, so the defdelegates that front a scoped read (`list`/`get` + custom
    // finds) carry the matching `current_user \\ nil` arity.  Non-principal
    // aggregates keep the original parameterless seam (byte-identical).
    const principal = aggregateUsesPrincipalContextFilter(agg);
    const actorArg = principal ? ", current_user \\\\ nil" : "";
    // The auto-`findAll` is paged-by-default (M-T2.6), so the `list_<agg>s`
    // defdelegate forwards the repository's `page`/`page_size`/`sort`/`dir`
    // (+ optional actor) arity.  The plain (unpaged) delegate stays byte-identical.
    const listRepo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    const listAllFind = listRepo?.finds?.find((f) => f.name === "all");
    const listPaged = listAllFind ? !!pagedReturn(listAllFind.returnType) : false;
    const listDelegateArgs = listPaged
      ? `page \\\\ ${PAGED_DEFAULT_PAGE}, page_size \\\\ ${PAGED_DEFAULT_PAGE_SIZE}, sort \\\\ "id", dir \\\\ "asc"${principal ? ", current_user \\\\ nil" : ""}`
      : principal
        ? "current_user \\\\ nil"
        : "";
    // A principal-referencing lifecycle stamp threads `current_user` into the
    // create/update WRITE seam too (the repository `insert`/`update` reads
    // `current_user.<idKey>` for `createdBy`/`updatedBy`).  The `\\ nil` default
    // keeps internal callers compiling + fail-safe (a nil actor stamps nil).
    const stampActorArg = stampUsesPrincipal(agg) ? ", current_user \\\\ nil" : "";
    // A `versioned` aggregate threads the client's expected version (parsed from
    // the If-Match header at the controller) as a trailing `expected_version \\ nil`
    // arg through the update defdelegate to the repository's optimistic-lock write.
    const versionedArg = aggregateIsVersioned(agg) ? ", expected_version \\\\ nil" : "";
    // Skip ops whose names collide with the CRUD defdelegates above —
    // notably `update`/`destroy` from `with crudish` would redefine
    // `update_<agg>/2`/`delete_<agg>/1` otherwise.  The CRUD seam
    // already provides those names.
    // Containment fields this aggregate persists as child tables (relational
    // §11c, not inline `embeds_*` jsonb) — an op that mutates one `put_assoc`s
    // it (vs `put_embed` for an embedded containment).  Computed ONCE here off
    // the single schema-emit shape predicate so the persist tail never re-derives
    // the embedded-vs-relational decision.
    const relationalContainments = usesRelationalContainments(agg, ctx, sys)
      ? new Set(agg.contains.map((c) => snake(c.name)))
      : new Set<string>();
    // A document-shaped aggregate persists as one jsonb blob with no flattened
    // columns, so its named operations run over the `data` map and persist via
    // the document repository's `update/2` (DEBT-07) rather than the relational
    // struct-update + `put_change` path.  Returning / audited / provenanced /
    // collection-mutating document ops are validate-gated, so only the scalar
    // `renderDocNamedOpFunction` shape reaches here.
    const isDoc = isVanillaDocAgg(agg, ctx, sys);
    const opBlocks = (agg.operations ?? [])
      .filter((op) => !CRUD_RESERVED_NAMES.has(op.name))
      .map((op) =>
        isDoc
          ? isReturningOperation(op)
            ? renderDocReturningOpFunction(facadeMod, op, agg, ctx, opFragments)
            : renderDocNamedOpFunction(facadeMod, op, agg, ctx, opFragments)
          : isReturningOperation(op)
            ? renderReturningOpFunction(
                facadeMod,
                ctx,
                agg,
                op,
                relationalContainments,
                opFragments,
                channels,
                extraChannels,
              )
            : renderNamedOpFunction(
                facadeMod,
                ctx,
                agg,
                aggPascal,
                aggSnake,
                op,
                relationalContainments,
                opFragments,
                channels,
                extraChannels,
              ),
      );
    // Custom-find defdelegates — `<find>_<agg>(args...)` routes to the
    // repository fn emitted by `customFindsOf`.  Workflow `repo-let`
    // lowering (for a non-getById method) calls through this seam.
    const repo = (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name);
    const findLines = customFindsOf(repo).map((f) => {
      const findSnake = snake(f.name);
      const baseArgs = f.params.map((p) => snake(p.name));
      // A `paged` find carries the same `page`/`page_size` + `sort`/`dir` arity
      // (with defaults) the repository fn declares, so the defdelegate matches
      // and the controller's paged call routes through (M-T2.6).
      const pageArgs = pagedReturn(f.returnType)
        ? [
            `page \\\\ ${PAGED_DEFAULT_PAGE}`,
            `page_size \\\\ ${PAGED_DEFAULT_PAGE_SIZE}`,
            `sort \\\\ "id"`,
            `dir \\\\ "asc"`,
          ]
        : [];
      const findArgs = [
        ...baseArgs,
        ...pageArgs,
        ...(principal ? ["current_user \\\\ nil"] : []),
      ].join(", ");
      return `  defdelegate ${findSnake}_${aggSnake}(${findArgs}), to: ${repoMod}, as: :${findSnake}`;
    });
    const findBlock = findLines.length > 0 ? `\n${findLines.join("\n")}\n` : "";
    // `change_<agg>/2` — a blank-or-seeded Ecto changeset facade the Phoenix
    // LiveView form lifecycle calls (`change_<agg>(%Agg{})` for a create form,
    // `change_<agg>(record, params)` for validate).  Delegates to the
    // per-aggregate Changeset module's `base_changeset/2`.  A DOCUMENT
    // aggregate has no `base_changeset` (it round-trips via `document_changeset`),
    // so skip the facade there — its form path is out of scope for this slice.
    const changesetMod = `${facadeMod}.${aggPascal}Changeset`;
    const changeFacade = isDoc
      ? ""
      : `\n
  @doc "Blank-or-seeded Ecto changeset for the ${aggPascal} create/operation forms."
  def change_${aggSnake}(record_or_struct \\\\ %${facadeMod}.${aggPascal}{}, attrs \\\\ %{}),
    do: ${changesetMod}.base_changeset(record_or_struct, attrs)`;
    // A `destroy` action (e.g. from `with crudish`) lets a detail page host a
    // `DestroyForm(of: <Agg>)`, whose hoisted `handle_event` calls
    // `<Ctx>.destroy_<agg>!(id)` directly (a `byId` ActionBinding — see
    // `heex-primitives.ts`).  Emit that bang fn: load the record by id (raising
    // if missing), hard-delete it (`Repo.delete!`), returning the deleted struct.
    // Mirror the LiveView's emit condition on the aggregate IR — it has a
    // `destroy` action.
    const hasDestroy = (agg.destroys ?? []).length > 0;
    const getArgs = principal ? "id, current_user" : "id";
    // The canonical destroy's authorization gate, evaluated against the row this
    // seam just loaded — so the DestroyForm path is gated exactly like the REST
    // one.  A bang function's contract is "raise on failure" (this one already
    // raises `Ecto.NoResultsError` for an absent row), so a denial raises too:
    // fail-closed, and the LiveView's own error handling is unchanged.
    const destroyGateRc: RenderCtx = {
      thisName: "record",
      contextModule: facadeMod,
      agg: agg as EnrichedAggregateIR,
    };
    const destroyClauses = lifecycleEnsureClauses(agg.canonicalDestroy, destroyGateRc);
    // `destroy_<agg>!` takes the principal when the gate reads it.  On a
    // principal (tenancy-filtered) aggregate the getter already carries one, and
    // that same binding feeds the gate — no second parameter.
    const destroyBangArgs =
      destroyClauses.length === 0 || principal
        ? getArgs
        : `id, ${principalParam(lifecycleGatesUseCurrentUser(agg.canonicalDestroy))}`;
    const destroyBangBody =
      destroyClauses.length === 0
        ? `      {:ok, record} -> ${appModule}.Repo.delete!(record)`
        : `      {:ok, record} ->
        with ${destroyClauses.join(",\n             ")} do
          ${appModule}.Repo.delete!(record)
        else
          {:error, {:forbidden, detail}} -> raise detail
        end
`;
    const destroyFacade = hasDestroy
      ? `\n
  @doc "Hard-delete a ${aggPascal} by id (DestroyForm seam) — raises if not found."
  def destroy_${aggSnake}!(${destroyBangArgs}) do
    case get_${aggSnake}(${getArgs}) do
${destroyBangBody}
      {:error, _} -> raise Ecto.NoResultsError, queryable: ${facadeMod}.${aggPascal}
    end
  end`
      : "";
    // §13: a LiveView `Action { c.<op> }` button on a NON-destroy operation
    // hoists a `handle_event` that calls `<Ctx>.get_<agg>!(id)` then
    // `<Ctx>.<op>_<agg>!(record)` (`liveview-emit.ts` ~`:396-397`) — bang seams
    // the non-bang op/getter don't provide, so without them `mix compile
    // --warnings-as-errors` fails on the undefined calls.  Emit them for any
    // aggregate carrying operations: a load-or-raise getter (arity-1 `id`, the
    // exact call-site arity — the non-bang `get_<agg>` takes `current_user \\ nil`
    // so this resolves for principal aggregates too) and, per operation, an
    // arity-1 bang that runs the op (empty params) and raises on `{:error, _}`.
    const bangOps = (agg.operations ?? []).filter((op) => !CRUD_RESERVED_NAMES.has(op.name));
    const opBangFacade =
      bangOps.length > 0
        ? `\n
  @doc "Load a ${aggPascal} by id or raise (LiveView Action seam)."
  def get_${aggSnake}!(id) do
    case get_${aggSnake}(id) do
      {:ok, record} -> record
      {:error, _} -> raise Ecto.NoResultsError, queryable: ${facadeMod}.${aggPascal}
    end
  end${bangOps
    .map((op) => {
      const opSnake = snake(op.name);
      const gated = opUsesCurrentUser(op);
      const cuP = gated ? ", current_user \\\\ nil" : "";
      const cuA = gated ? ", current_user" : "";
      // A returning (exception-less) op raises on guard failure and yields its
      // value (or a declared error tuple) directly — wrapping it in an
      // `{:ok,_}/{:error,_}` case emits an error clause the body never matches
      // ("the following clause will never match" → `--warnings-as-errors`).  Pass
      // its result straight through.  A standard op returns `{:ok,_} | {:error,_}`,
      // so unwrap and raise on error.
      const body = isReturningOperation(op)
        ? `    ${opSnake}_${aggSnake}(record, %{}${cuA})`
        : `    case ${opSnake}_${aggSnake}(record, %{}${cuA}) do
      {:ok, result} -> result
      {:error, reason} -> raise "${op.name} failed: #{inspect(reason)}"
    end`;
      return `\n
  @doc "Run the \`${op.name}\` operation on a loaded ${aggPascal} (LiveView Action seam)."
  def ${opSnake}_${aggSnake}!(record${cuP}) do
${body}
  end`;
    })
    .join("")}`
        : "";
    // The `can_<op>` PREDICATE of each `when`-gated public operation — the
    // side-effect-free probe behind `GET /<aggs>/{id}/can_<op>` (criterion.md,
    // use site 2).
    //
    // This backend already DECLARED that endpoint in its own OpenAPI
    // (`openapi-emit.ts` emits the PathItem for every `op.when`) while its
    // router never mounted it, so the published probe 404'd — the same
    // spec-vs-router split as the `update` route, found the moment a fixture
    // carried a `when` gate at all.
    //
    // The predicate is the SAME `op.when` expression the guard chain renders
    // into `ensure(...)`, against the same `thisName: "record"` context — so the
    // probe and the gate it probes cannot disagree by construction.
    const whenGatedOps = (agg.operations ?? []).filter(
      (op) => op.visibility === "public" && op.when,
    );
    const canFacade =
      whenGatedOps.length > 0
        ? whenGatedOps
            .map((op) => {
              const rc: RenderCtx = {
                thisName: "record",
                contextModule: facadeMod,
                agg: agg as EnrichedAggregateIR,
              };
              return `\n
  @doc "Whether the \`${op.name}\` state gate currently admits this ${aggPascal}."
  def can_${snake(op.name)}_${aggSnake}(%${facadeMod}.${aggPascal}{} = record) do
    ${renderExpr(op.when as ExprIR, rc)}
  end`;
            })
            .join("")
        : "";
    // Aggregate `function` members (§11b) — pure domain helpers callable from the
    // op / precondition / derived bodies emitted above.  Each renders as a
    // struct-guarded `def <fn>(%Agg{} = record, …)` so the lowered call site
    // (`<fn>(record, …)`) resolves in THIS module.
    const fnLines = renderAggregateFunctions(facadeMod, agg, isDoc);
    const functionBlock = fnLines.length > 0 ? `${fnLines.join("\n")}\n` : "";
    // The CRUD `delete_<agg>` defdelegate is emitted only when the aggregate
    // exposes a REST delete surface (a reachable `destroy`).  Without it the
    // delegate — and the repository `delete/1` it fronts — were dead code no
    // route reached (audit: dead hard-`delete`).  The `destroy_<agg>!` LiveView
    // bang seam above is the SEPARATE `DestroyForm` path (its own `hasDestroy`
    // gate), so a detail-page destroy button is unaffected.
    // GUARDED write seams.  A gated create / destroy stops being a bare
    // `defdelegate` and becomes a real function that evaluates the gate first,
    // then delegates — so EVERY caller (REST controller, LiveView form,
    // DestroyForm) passes the gate, not just the ones that go through a
    // controller.  Ungated aggregates keep the delegate byte-identical.
    const createClauses = lifecycleEnsureClauses(agg.canonicalCreate, {
      thisName: "record",
      contextModule: facadeMod,
      agg: agg as EnrichedAggregateIR,
    });
    const createStampsActor = stampUsesPrincipal(agg);
    // The GUARDED seam keeps the plain name, and the authorization-free entry the
    // in-process callers use is named `_unguarded` — see
    // `../lifecycle-seam.ts` for why that direction and not the other:
    // a caller that guesses `create_<agg>` gets the gate, and bypassing it is
    // something a call site has to SAY.  A workflow step / event dispatch /
    // emitted integration test has no request and no principal, and every other
    // backend's workflow body calls the domain factory directly — so routing
    // those through the guarded seam would 403 (or MatchError) a workflow whose
    // own caller does hold the permission, on this backend only.
    const createDelegate =
      createClauses.length === 0
        ? `  defdelegate create_${aggSnake}(attrs${stampActorArg}), to: ${repoMod}, as: :insert`
        : `  @doc "Create a ${aggPascal} — the canonical \`create\`'s \`requires\` gate runs HERE, so the REST and LiveView callers are gated alike."
  def create_${aggSnake}(attrs, ${principalParam(
    lifecycleGatesUseCurrentUser(agg.canonicalCreate) || createStampsActor,
  )}) do
    with ${createClauses.join(",\n         ")} do
      ${unguardedName("create", agg.name)}(attrs${createStampsActor ? ", current_user" : ""})
    end
  end

  @doc "Create a ${aggPascal} with NO authorization gate — the in-process entry (workflow step, event dispatch, emitted integration test), which carries no request principal.  Request-side callers use \`create_${aggSnake}/2\`."
  defdelegate ${unguardedName("create", agg.name)}(attrs${stampActorArg}), to: ${repoMod}, as: :insert`;
    const deleteClauses = lifecycleEnsureClauses(agg.canonicalDestroy, destroyGateRc);
    const deleteDelegate = !emitsRestDelete(agg)
      ? ""
      : deleteClauses.length === 0
        ? `\n  defdelegate delete_${aggSnake}(record), to: ${repoMod}, as: :delete`
        : `\n
  @doc "Delete a ${aggPascal} — the canonical \`destroy\`'s \`requires\` gate runs HERE, against the loaded row."
  def delete_${aggSnake}(record, ${principalParam(
    lifecycleGatesUseCurrentUser(agg.canonicalDestroy),
  )}) do
    with ${deleteClauses.join(",\n         ")} do
      ${unguardedName("delete", agg.name)}(record)
    end
  end

  @doc "Delete a ${aggPascal} with NO authorization gate — the in-process entry (a workflow \`destroy\` step holds the row already and has no request principal).  Request-side callers use \`delete_${aggSnake}/2\`."
  defdelegate ${unguardedName("delete", agg.name)}(record), to: ${repoMod}, as: :delete`;
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(${listDelegateArgs}), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id${actorArg}), to: ${repoMod}, as: :find_by_id${
    agg.writeScopeFilter
      ? `\n  defdelegate get_${aggSnake}_for_write(id${actorArg}), to: ${repoMod}, as: :find_by_id_for_write`
      : ""
  }
${createDelegate}
  defdelegate update_${aggSnake}(record, attrs${stampActorArg}${versionedArg}), to: ${repoMod}, as: :update${deleteDelegate}${changeFacade}${destroyFacade}${opBangFacade}${canFacade}
${findBlock}${opBlocks.length > 0 ? `\n${opBlocks.join("\n\n")}\n` : ""}${functionBlock}`;
  });

  // Retrieval defdelegates — `run_<retrieval>_<agg>(args..., opts \\ [])`
  // routes to the per-retrieval Ecto query module under
  // `Retrievals.<Name>`.  Workflow `repo-run` lowerings (follow-up
  // slice) call through this seam.
  const retrievalLines = (ctx.retrievals ?? [])
    .filter((r) => r.targetType.kind === "entity")
    .map((r) => {
      const aggName = (r.targetType as { kind: "entity"; name: string }).name;
      const retSnake = snake(r.name);
      const aggSnake = snake(aggName);
      const retMod = `${facadeMod}.Retrievals.${upperFirst(r.name)}`;
      // `defdelegate` carries the function arity through to the target.
      // `\\\\ []` is the default for the trailing `opts` arg.
      const args = r.params.map((p) => snake(p.name));
      const argList = args.length > 0 ? `${args.join(", ")}, opts \\\\ []` : "opts \\\\ []";
      return `  defdelegate run_${retSnake}_${aggSnake}(${argList}), to: ${retMod}, as: :run`;
    });
  const retrievalBlock =
    retrievalLines.length > 0 ? `\n  # Retrievals\n${retrievalLines.join("\n")}\n` : "";

  // Private `ensure/2` guard helper shared by the ES command runners AND every
  // relational/document named/returning op that hoists its `requires`/
  // `precondition` guards into a `with ensure(...)` chain (403/422 denials).
  // Only emitted when SOME op body actually has a guard, so it never sits unused
  // under --warnings-as-errors.
  const ensureBlock =
    esContextNeedsEnsure(ctx) || contextNeedsGuardEnsure(ctx) ? `\n${renderEnsureHelper()}\n` : "";

  // Shared ref-collection helpers — emitted once per context module when ANY
  // named operation appends/removes through a `many_to_many` reference
  // collection.  `__ref_id_list/1` normalises a preloaded relationship (target
  // structs) — or an already-raw id list — to a list of id strings;
  // `__resolve_refs/2` loads those ids back to target structs for `put_assoc`.
  // `__ref_id_list/1` is needed by BOTH the mutation path and a read-only
  // `contains` membership test; `__resolve_refs/2` (and its `import Ecto.Query`)
  // only by the mutation path.  Gate them separately so a contains-only op
  // doesn't emit an unused `__resolve_refs` (a `--warnings-as-errors` break).
  const mutatesRefColl = contextMutatesRefColl(ctx);
  const refCollHelpers = contextUsesRefCollOp(ctx)
    ? `\n${renderContextRefCollHelpers(appModule, mutatesRefColl)}\n`
    : "";

  // Shared relational-containment helper — emitted once per context module when
  // ANY named operation mutates a RELATIONAL containment (`lines += Line{…}` on a
  // `has_many` child-table aggregate, §11c).  `__put_assoc_parts/1` normalises the
  // mutated part-struct list to `put_assoc`-ready maps (the persist tail calls it);
  // see its emit for why a bare struct doesn't insert.
  const putAssocPartsHelper = contextMutatesRelationalContainment(ctx, sys)
    ? `\n${renderPutAssocPartsHelper()}\n`
    : "";

  // Shared `:utc_datetime` truncation helper — emitted once per context module
  // when ANY named operation assigns a `datetime` field.  Gated so a context
  // without one stays byte-identical (and never trips
  // `--warnings-as-errors` on an unused private fn).
  // Emitted iff a rendered block actually CALLS it — the declarative gate
  // ("any op assigns a datetime field") over-approximated the returning-op
  // persist path that renders the call, so projection-groupby's context
  // shipped the helper with zero callers: an unused private fn under
  // --warnings-as-errors (the same drifted-gate class as problem_variant/5,
  // fixed the same way — derive, don't stamp).

  // A named-/returning-op body that `emit`s a domain event renders a catalog
  // `event_dispatched` line (`renderReturningStmt` "emit" arm) — that needs
  // `require Logger` in this host module.  Gate it so the require never sits
  // unused.
  const requireLogger = contextEmitsEvent(ctx) ? "\n  require Logger" : "";

  // Reading-tier domain services (domain-services.md rev. 4, Slice 1; Elixir
  // decision B — ambient `Repo`).  A single-context `reading` service op lowers
  // to a CONTEXT FUNCTION on THIS module (not a `Domain.Services` module), so
  // its body's repo reads resolve against the ambient `Repo` via the
  // context-facade find fns above.  Empty for a pure-only / service-free
  // context (byte-identical to before).
  const readingServiceFns = renderReadingServiceContextFns(ctx, facadeMod, `${appModule}.Types`);
  const readingServiceBlock =
    readingServiceFns.length > 0
      ? `\n  # Reading-tier domain services (ambient Repo) — domain-services.md rev. 4\n${readingServiceFns.join("\n\n")}\n`
      : "";

  const truncateDtBody = [
    blocks.join("\n"),
    retrievalBlock,
    readingServiceBlock,
    ensureBlock,
    refCollHelpers,
    putAssocPartsHelper,
  ].some((s) => s.includes("__truncate_dt("))
    ? `\n${renderTruncateDtHelper()}\n`
    : "";

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions plus named-operation
  handlers (workflows need
  \`<op>_<agg>(record, params)\` for cross-aggregate calls in the
  workflow body).  Plain Elixir context module.
  """${requireLogger}${mutatesRefColl ? "\n  import Ecto.Query" : ""}

${blocks.join("\n")}${retrievalBlock}${readingServiceBlock}${ensureBlock}${refCollHelpers}${putAssocPartsHelper}${truncateDtBody}end
`;
}

/** Does any non-CRUD, non-ES operation in the context carry a `requires`/
 *  `precondition` guard?  Those hoist to a `with ensure(...)` chain (403/422
 *  typed denials — the fix for the raise→500 boundary bug), so the context
 *  module needs the shared private `ensure/2` helper.  Covers BOTH the
 *  relational (`renderNamedOpFunction`/`renderReturningOpFunction`) AND document
 *  (`renderDoc*OpFunction`) op renderers, which both hoist guards now.  MUST
 *  mirror the emit condition EXACTLY (else `ensure/2` sits unused under
 *  --warnings-as-errors).  (ES ops have their own `esContextNeedsEnsure` gate.) */
function contextNeedsGuardEnsure(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some((agg) => {
    if (isEventSourced(agg)) return false;
    // A canonical create/destroy gate hoists into `create_<agg>` /
    // `delete_<agg>` / `destroy_<agg>!` through the same `ensure/2`, so it needs
    // the helper too — and an aggregate whose ONLY guard is a lifecycle one is
    // exactly the shape that would otherwise emit `ensure(...)` calls with no
    // `ensure/2` defined (undefined function, not a warning).
    if (
      lifecycleGates(agg.canonicalCreate).length > 0 ||
      lifecycleGates(agg.canonicalDestroy).length > 0
    ) {
      return true;
    }
    return (agg.operations ?? []).some(
      (op) => !CRUD_RESERVED_NAMES.has(op.name) && (opHasGuards(op) || opHasWhenGate(op)),
    );
  });
}

/** Does any non-CRUD, non-ES named/returning operation in the context `emit` a
 *  domain event?  Those bodies render the catalog `event_dispatched` line via
 *  `renderReturningStmt`'s "emit" arm, which needs `require Logger` in this host
 *  module.  Gates the require so it never sits unused. */
function contextEmitsEvent(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some(
    (agg) =>
      !isEventSourced(agg) &&
      (agg.operations ?? []).some(
        (op) => !CRUD_RESERVED_NAMES.has(op.name) && op.statements.some((s) => s.kind === "emit"),
      ),
  );
}

/** True when an op statement's expression tree contains a `this.<refColl>.contains(x)`
 *  membership test — a `contains` method-call whose receiver is a reference
 *  collection (`X id[]` → receiverType array<id>).  render-expr lowers that to
 *  `Enum.member?(__ref_id_list(...), x)`, so the helper must be emitted even when
 *  the op only READS the collection (a precondition) and never `+=`/`-=`es it. */
function stmtHasRefCollContains(s: StmtIR): boolean {
  let found = false;
  walkStmtExprsDeep(s, (e) => {
    if (
      e.kind === "method-call" &&
      e.member === "contains" &&
      e.receiverType.kind === "array" &&
      e.receiverType.element.kind === "id"
    ) {
      found = true;
    }
  });
  return found;
}

/** Does any non-CRUD named operation in the context append/remove through a
 *  reference collection (`X id[]` → `many_to_many`)?  Gates `__resolve_refs/2`
 *  (+ its `import Ecto.Query`) — the WRITE helper `put_assoc` needs to load ids
 *  back to structs.  A read-only `contains` never touches it, so keeping this
 *  gate mutation-only avoids an emitted-but-unused `__resolve_refs` under
 *  `--warnings-as-errors`. */
function contextMutatesRefColl(ctx: BoundedContextIR): boolean {
  return ctx.aggregates.some((agg) => {
    if (isEventSourced(agg)) return false;
    const names = refCollFieldNames(agg);
    if (names.size === 0) return false;
    return (agg.operations ?? []).some(
      (op) =>
        !CRUD_RESERVED_NAMES.has(op.name) &&
        op.statements.some(
          (s) =>
            (s.kind === "add" || s.kind === "remove") &&
            s.collection &&
            names.has(snake(s.target.segments[0] ?? "")),
        ),
    );
  });
}

/** Does the context need the `__ref_id_list/1` helper — i.e. any non-CRUD op
 *  either mutates a reference collection OR tests membership over one
 *  (`this.<refColl>.contains(x)`, which render-expr lowers to
 *  `Enum.member?(__ref_id_list(...), x)`)?  The read path needs `__ref_id_list`
 *  even when the op never `+=`/`-=`es the collection. */
function contextUsesRefCollOp(ctx: BoundedContextIR): boolean {
  if (contextMutatesRefColl(ctx)) return true;
  return ctx.aggregates.some((agg) => {
    if (isEventSourced(agg)) return false;
    if (refCollFieldNames(agg).size === 0) return false;
    return (agg.operations ?? []).some(
      (op) =>
        !CRUD_RESERVED_NAMES.has(op.name) && op.statements.some((s) => stmtHasRefCollContains(s)),
    );
  });
}

/** Does any non-CRUD named operation in the context mutate a RELATIONAL
 *  containment?  Gates the shared `__put_assoc_parts/1` helper emission —
 *  relational containments persist via `put_assoc(..., __put_assoc_parts(record.f))`.
 *  TWO mutation shapes reach that persist tail (see `operation-returns-emit.ts`),
 *  so BOTH must arm the helper or the emitted call is undefined:
 *    - COLLECTION (`has_many`): `lines += Line{…}` / `-=` (`add`/`remove`).
 *    - SINGLE (`has_one`): `shipment := Shipment{…}` (`assign`).
 *  MUST mirror the persist-tail condition (any assign/add/remove whose target is a
 *  relational-containment field) exactly — else the helper is either emitted-but-
 *  unused (`--warnings-as-errors`) or called-but-undefined (the B9 compile error). */
function contextMutatesRelationalContainment(ctx: BoundedContextIR, sys?: SystemIR): boolean {
  return ctx.aggregates.some((agg) => {
    if (isEventSourced(agg)) return false;
    if (!usesRelationalContainments(agg, ctx, sys)) return false;
    const containNames = new Set(agg.contains.map((c) => snake(c.name)));
    if (containNames.size === 0) return false;
    return (agg.operations ?? []).some(
      (op) =>
        !CRUD_RESERVED_NAMES.has(op.name) &&
        op.statements.some(
          (s) =>
            (s.kind === "assign" || s.kind === "add" || s.kind === "remove") &&
            containNames.has(snake(s.target.segments[0] ?? "")),
        ),
    );
  });
}

/** `__truncate_dt/1` — the second-precision guard for a `:utc_datetime` column
 *  written through an OPERATION's `force_change` persist line.
 *
 *  `now()` renders to `DateTime.utc_now()`, which carries MICROSECONDS, and
 *  `force_change` bypasses the cast that would drop them — so Ecto refuses the
 *  dump with `** (ArgumentError) :utc_datetime expects microseconds to be
 *  empty`, surfacing as a raw 500.  `stamp-emit` (B7), `audit-emit` and
 *  `provenance-emit` each already truncate their own `:utc_datetime` writes;
 *  this is the same rule for the operation-assignment arm, which was the one
 *  that never reached it.  Found by the caller-census drain: `softDelete()`
 *  (`deletedAt := now()`) got its first runtime caller and 500'd.
 *
 *  Exactly TWO clauses.  Every value that reaches the helper is a
 *  \`%DateTime{}\`, a wire binary, or nil — vanilla datetime columns are all
 *  \`:utc_datetime\`, \`now()\` renders \`DateTime.utc_now()\`, and the wire
 *  coercion above never produces a \`%NaiveDateTime{}\` — so a
 *  \`%NaiveDateTime{}\` clause is disjoint from every call site's inferred
 *  argument type and Elixir ≥1.18's type checker flags it "never used"
 *  (a \`--warnings-as-errors\` compile failure; scaffold-macros' corpus cell,
 *  #2448).  The bare-variable catch-all is safe: a var pattern overlaps any
 *  inferred type, so it is never flagged even at a DateTime-only call site
 *  (verified empirically against the corpus gate's hexpm/elixir image). */
function renderTruncateDtHelper(): string {
  return `  # Second-precision guard for a \`:utc_datetime\` column assigned by an
  # operation body.  \`now()\` yields microsecond precision and \`force_change\`
  # skips casting, so Ecto would refuse the dump; truncating here matches what
  # the stamp / audit / provenance writers already do.
  defp __truncate_dt(%DateTime{} = dt), do: DateTime.truncate(dt, :second)
  defp __truncate_dt(other), do: other`;
}

/** The private helper a context module emits when a named op mutates a RELATIONAL
 *  containment.  Normalises the mutated part-struct list to `put_assoc`-ready
 *  maps: a bare part STRUCT with a nil PK is NOT inserted by `put_assoc` (Ecto
 *  reads a struct as an already-persisted row and produces an empty changeset —
 *  the child row silently never persists), whereas a plain map WITHOUT an `id`
 *  inserts and one WITH an `id` is kept/updated.  Dropping `__meta__` /
 *  timestamps / the unloaded `belongs_to` / nil fields keeps existing rows on
 *  their PK and lets new ones insert cleanly (`on_replace: :delete` rewrites). */
function renderPutAssocPartsHelper(): string {
  // Two call shapes reach this helper (see `contextMutatesRelationalContainment`):
  //   - COLLECTION (`has_many`): `record.<field>` is a LIST — the op body rebound
  //     it to `(record.<field> || []) ++ [<new part struct>]`.
  //   - SINGLE (`has_one`): `record.<field>` is a SINGLE part struct — the op body
  //     bound `record = %{record | <field>: %Part{…}}` (B9).
  // So the helper is multi-clause: the `is_list` clause maps the collection form
  // element-wise back through the SAME per-element clauses (recursion), and the
  // per-element clauses ALSO handle a single `has_one` value directly.  A bare
  // struct with a nil PK would NOT be inserted by `put_assoc` (Ecto reads a struct
  // as an already-persisted row → empty changeset), but a map WITHOUT `id` inserts
  // and one WITH `id` is kept/updated.  Every clause is reachable given the live
  // call sites, so `--warnings-as-errors` stays quiet.
  return `  # Normalise a relational-containment value to \`put_assoc\`-ready maps.
  # Accepts either a \`has_many\` LIST of part structs (collection containment) or a
  # single \`has_one\` part struct/changeset (single containment) — a bare struct
  # with a nil PK would NOT be inserted by \`put_assoc\` (Ecto reads a struct as an
  # already-persisted row → empty changeset), but a map WITHOUT \`id\` inserts and
  # one WITH \`id\` is kept/updated.
  defp __put_assoc_parts(list) when is_list(list), do: Enum.map(list, &__put_assoc_parts/1)
  defp __put_assoc_parts(%Ecto.Changeset{} = cs), do: cs

  defp __put_assoc_parts(%{__struct__: _} = part) do
    part
    |> Map.from_struct()
    |> Map.drop([:__meta__, :inserted_at, :updated_at])
    |> Enum.reject(fn {_k, v} ->
      match?(%Ecto.Association.NotLoaded{}, v) or is_nil(v)
    end)
    |> Map.new()
  end

  defp __put_assoc_parts(other), do: other`;
}

/** The two private helpers a context module emits when a named op mutates a
 *  reference collection. */
function renderContextRefCollHelpers(appModule: string, includeResolve: boolean): string {
  const refIdList = `  # Normalise a reference-collection value to a list of id strings — a
  # preloaded \`many_to_many\` is a list of target structs; a not-yet-loaded one
  # (or already-raw id list) passes through.
  defp __ref_id_list(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_id_list(list) when is_list(list) do
    Enum.map(list, fn
      %{id: id} -> to_string(id)
      id -> to_string(id)
    end)
  end
  defp __ref_id_list(_), do: []`;
  // `__resolve_refs` (and its `from` → `import Ecto.Query`) is only used by the
  // write path (`put_assoc`).  A read-only `contains` op omits it so it isn't
  // emitted-but-unused under `--warnings-as-errors`.
  const resolveRefs = `

  # Load reference-collection ids back to target structs for \`put_assoc\`.
  defp __resolve_refs(ids, target_mod) do
    ids = ids |> List.wrap() |> Enum.map(&to_string/1)
    ${appModule}.Repo.all(from(t in target_mod, where: t.id in ^ids))
  end`;
  return includeResolve ? refIdList + resolveRefs : refIdList;
}

// Named operation functions per aggregate operation.  `<op>_<agg>(record,
// params)` runs the operation BODY: bind the params it reads, render the
// statements (guards raise, `field := value` struct-updates the threaded
// `record`, `emit` broadcasts — the same vanilla renderer the returning-op
// path uses), then persist the assigned fields and `Repo.update`.
//
// The body is rendered against an immutable `record` struct: each `field :=
// value` re-binds `record = %{record | field: value}`, so after the body the
// struct holds the computed values.  Persistence then `put_change`s exactly the
// assigned fields onto a changeset (they're real schema columns), rather than
// `cast`ing the op's *params* — params are inputs to the formula, not columns,
// so casting them would raise `unknown field` at runtime.  This is the seam
// workflows call when their body invokes `<aggregate>.<operation>(args)`.
//
// Extern operation context function — the delegating seam (proposal §3a).
// Runs the preconditions (`ensure/2` guard chain), delegates to the co-located,
// user-owned `<Agg>ExternImpl.<op>(record, params)` hook, then persists the
// returned (mutated) struct's scalar columns via `force_change` and re-asserts
// invariants.  Replaces the old empty-`change(%{})` no-op that silently returned
// 204.  A missing user impl `raise`s (loud 500), never a silent success.
function renderExternOpFunction(
  facadeMod: string,
  agg: AggregateIR,
  aggPascal: string,
  aggSnake: string,
  op: OperationIR,
): string {
  const opSnake = snake(op.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  const implMod = externImplModule(facadeMod, aggPascal);
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    agg: agg as EnrichedAggregateIR,
  };
  // `when` state gate + preconditions → a leading `with :ok <- ensure(...)` chain
  // (identical atoms + status mapping to the non-extern guard path — `:disallowed`
  // 409 / `:forbidden` 403 / `:precondition_failed` 422); the extern delegation is
  // the final with-clause, rebinding `record` to the mutated struct.
  const guardClauses = collectOpGuardClauses(agg.name, op, rc);
  const withClauses = [...guardClauses, `{:ok, record} <- ${implMod}.${opSnake}(record, params)`];
  // Bind the params the preconditions reference (`score = Map.get(params,
  // "score")`) BEFORE the `with` — a precondition like `score >= 0` reads the op
  // param, not a column, so it needs the local.  Params the guards don't touch
  // stay inside the `params` map the hook receives (no unused-var warning).
  const paramBinds = op.params
    .filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)))
    .map(
      (p) =>
        `    ${snake(p.name)} = ${coerceOpParam(`Map.get(params, ${JSON.stringify(p.name)})`, p.type)}\n`,
    )
    .join("");
  // Re-assert the aggregate's cross-field invariants after the hook mutates and
  // before the write (D3c) — byte-identical when the aggregate has none.
  const changesetMod = `${aggModule}Changeset`;
  const invPipe = aggregateHasResidualInvariants(agg)
    ? `\n      |> ${changesetMod}.validate_invariants()`
    : "";
  // Persist EVERY scalar column off the returned struct (not the old empty
  // `change(%{})`): `force_change` because the changeset data already carries the
  // new value.  See `externPersistForceChanges`.
  const forceChanges = externPersistForceChanges(agg)
    .map((b) => `\n      |> ${b}`)
    .join("");
  const actorArg = opUsesCurrentUser(op) ? ", current_user \\\\ nil" : "";
  return `  @doc "Extern operation \`${op.name}\` on \`${aggPascal}\` — runs preconditions, delegates to the ${aggPascal}ExternImpl hook, then re-asserts invariants and persists."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t() | term()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${actorArg}) when is_map(params) do
${paramBinds}    with ${withClauses.join(",\n         ")} do
      record
      |> Ecto.Changeset.change(%{})${forceChanges}${invPipe}
      |> ${repoMod}.persist_change()
    end
  end`;
}

function renderNamedOpFunction(
  facadeMod: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  aggPascal: string,
  aggSnake: string,
  op: OperationIR,
  /** Containment fields persisted as child tables (relational §11c) — these
   *  `put_assoc` rather than `put_embed`.  Empty = embedded output (default). */
  relationalContainments: ReadonlySet<string> = new Set(),
  /** Source-map Milestone 3 collector (`--sourcemap`) — only allocated by the
   *  caller when a recorder is present (zero cost otherwise). */
  opFragments?: OpFragment[],
  /** Broker channels (M-T4.4 slice 6c) — see renderEmitDispatchLines. */
  channels?: ElixirChannelsCfg,
  extraChannels: ChannelIR[] = [],
): string {
  // An `extern` op has NO mutating body (only preconditions) — it delegates the
  // business decision to the user-owned `<Agg>ExternImpl` hook, then persists the
  // returned struct.  Handled by its own renderer (the empty-changeset path below
  // was the silent-204 bug this fixes — proposal §1b).
  if (isExternOp(op)) {
    return renderExternOpFunction(facadeMod, agg, aggPascal, aggSnake, op);
  }
  const opSnake = snake(op.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const repoMod = `${aggModule}Repository`;
  // A provenanced write-site captures lineage inline (co-located column + the
  // per-process trace buffer), and the persist drains that buffer into the
  // history table inside a transaction.  `captureProvenance` gates the body
  // rendering; `hasProv` gates the transactional persist tail.
  const hasProv = opHasProvSite(op);
  // An audited operation captures a who/what/when + before/after wire snapshot
  // into the `audit_records` table, recorded INSIDE the save transaction so the
  // row commits atomically with the aggregate update.  Like provenance, `audited`
  // forces the transactional persist tail — a bare changeset pipe has no
  // transaction to record into.  Where both are present they SHARE one transaction.
  const hasAudit = op.audited === true;
  const rc: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    captureProvenance: hasProv,
    // The enriched aggregate, so the body renderer can detect reference-
    // collection (`X id[]`) add/remove and normalise to id lists (the persist
    // then `put_assoc`s the resolved structs instead of `put_change`).
    agg: agg as EnrichedAggregateIR,
  };

  // The `before` wire snapshot — taken from the ORIGINAL `record` before the
  // body rebinds any field, so it reflects the pre-mutation state (parity with
  // the Hono/Python `before` captured before the mutation).
  const beforeBind = hasAudit
    ? `    audit_before = ${wireSnapshot("record", false, facadeMod.split(".")[0]!)}\n`
    : "";

  // Bind only the params the body references, so an unused param never trips
  // `mix compile --warnings-as-errors`.  (`record` is always used — the persist
  // pipeline reads it — so it needs no such guard.)
  const usedParams = op.params.filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)));
  const paramBinds = usedParams.map(
    (p) =>
      `    ${snake(p.name)} = ${coerceOpParam(`Map.get(params, ${JSON.stringify(p.name)})`, p.type)}`,
  );

  // S5a: a body that `emit`s a domain event is restructured to persist-then-
  // dispatch — the `emit`s are hoisted out of the interleaved body and fanned
  // out (Dispatcher + broadcast) AFTER `persist_change` commits, so no phantom
  // event fires on a failed write and each event reaches the context Dispatcher
  // (saga seam), not just the subscriber-less raw broadcast.  A named op always
  // persists, so the `{:ok, saved}` seam always exists.
  const emits = opEmitsEvent(op);
  const hasDispatcher = contextHasDispatcher(ctx as EnrichedBoundedContextIR, extraChannels);
  // Transactional outbox (dispatch-delivery-semantics.md §1, docs/channels.md):
  // when one of the emitted events is DURABLE, `<App>.Channels.dispatch/2` does
  // not fan out — it INSERTs an `__loom_outbox` row, and that row has to commit
  // with the aggregate change.  So the persist + emit pair is wrapped in one
  // `Repo.transaction`; the emit lines then sit two columns deeper.  An
  // ephemeral-only (or channel-less) op keeps the post-commit fan-out and its
  // byte-identical layout.
  const txWrapEmits = emits && opEmitsDurableEvent(op, channels);
  const dispatchLines =
    emits && !txWrapEmits
      ? renderEmitDispatchLines(
          op,
          rc,
          hasDispatcher,
          "        ",
          `${ctx.name}.${agg.name}.${op.name}`,
          opFragments,
          channels,
        )
      : [];
  // Durable emit: the phases straddle the transaction — event binds ahead of it
  // (keeping `loom_event_<i>` in scope on both sides), the `__loom_outbox`
  // INSERT inside it, the PubSub broadcast only after it commits.  Broadcasting
  // inside the tx let SSE / LiveView subscribers observe an event whose write
  // then rolled back.
  const durableEmit = txWrapEmits
    ? renderDurableEmitDispatchParts(
        op,
        rc,
        hasDispatcher,
        { bind: "    ", dispatch: "          ", broadcast: "        " },
        `${ctx.name}.${agg.name}.${op.name}`,
        opFragments,
        channels,
      )
    : { bind: [], dispatch: [], broadcast: [] };

  // Render the body (guards / assigns / let) — shared with the returning-op
  // path; a non-returning body never carries a `return` arm.  The statement index
  // disambiguates per-write provenance temp vars.  When emitting, the `emit`s are
  // rendered post-commit (below), not inline.  `bodyStmts` is kept alongside
  // `bodyLines` (rather than only the mapped-over result) so a source-map
  // collector can zip the two SAME-length, SAME-order arrays back together via
  // `statementSubRegions` — a hoisted `emit` is deliberately excluded from
  // both, matching the "regular body" scope this milestone covers (see
  // `OpFragment` in operation-returns-emit.ts).
  // The `when` state gate + `requires`/`precondition` guards are hoisted into a
  // leading `with :ok <- ensure(...)` chain so an expected denial returns a typed
  // tuple (`{:error, :disallowed}` 409 / `{:error, :forbidden}` 403 /
  // `{:error, :precondition_failed}` 422) BEFORE the mutation/persist runs, instead
  // of raising an ArgumentError (→ 500).  Exclude the guard STATEMENTS from the
  // in-body statements (the `when` gate is a predicate field, not a statement).
  const guardClauses = collectOpGuardClauses(agg.name, op, rc);
  const bodyStmts = op.statements.filter((s) => {
    if (s.kind === "requires" || s.kind === "precondition") return false;
    if (emits && s.kind === "emit") return false;
    return true;
  });
  const bodyLines = bodyStmts.map((s, i) => renderReturningStmt(s, ctx, rc, i));
  if (opFragments && bodyLines.length > 0) {
    opFragments.push({
      fragmentText: bodyLines.join("\n"),
      subRegions: statementSubRegions(bodyStmts, bodyLines, `${ctx.name}.${agg.name}.${op.name}`),
    });
  }

  // Persist the fields the body assigned (deduped, declaration order) + the
  // co-located `<field>_provenance` backing columns — shared with the
  // returning-op persist tail.  A reference collection (`X id[]` → `many_to_many`)
  // resolves its mutated id list back to target structs and `put_assoc`s them;
  // see `persistPutBodies`.  Re-indented per persist path (4-space for the plain
  // pipe, 6-space inside the `changeset =` assignment).
  const putBodies = persistPutBodies(
    op,
    agg,
    facadeMod.split(".")[0]!,
    facadeMod.split(".").slice(1).join("."),
    relationalContainments,
  );
  const putBlock = putBodies.map((b) => `\n    |> ${b}`).join("");
  const putBlock6 = putBodies.map((b) => `\n      |> ${b}`).join("");

  // An op that mutates an EMBEDDED containment (`items += Item{…}` on an
  // `embeds_many`/`embeds_one` jsonb field) rebinds `record.<field>` in the body,
  // then persists via `put_embed(:<field>, record.<field>)`.  `put_embed`, like
  // `put_change`, DROPS the change when the new embed equals the changeset DATA —
  // and the data is the ALREADY-mutated `record`, so `Repo.update` runs no SQL
  // and the write is silently lost (the embed analogue of the `force_change`
  // scalar trap; embeds have no `force_` variant).  B5.  Build the persist
  // changeset off the ORIGINAL (pre-mutation) struct `record_before` so
  // `put_embed` sees a real diff; scalar columns still `force_change` regardless
  // of the base.  Relational containments (`put_assoc`) don't hit this, so the
  // swap is gated on embedded-containment mutation only (byte-identical
  // otherwise).
  const containNames = new Set(agg.contains.map((c) => snake(c.name)));
  const mutatesEmbeddedContainment = op.statements.some((s) => {
    if (s.kind !== "add" && s.kind !== "remove") return false;
    const f = snake(s.target.segments[0] ?? "");
    return containNames.has(f) && !relationalContainments.has(f);
  });
  const persistBase = mutatesEmbeddedContainment ? "record_before" : "record";
  const captureBase = mutatesEmbeddedContainment ? "    record_before = record\n" : "";

  // Optimistic concurrency on the NAMED-OPERATION write path (M-T6.27).
  //
  // History: RS-14 first gave this path a PLAIN version bump
  // (`change(%{version: version + 1})`) so the wire value advanced — but a
  // plain bump carries no CAS filter, so two writers racing an operation both
  // landed and the second silently overwrote the first (a lost update the
  // other four backends answer with 409).  The bump now comes from
  // `optimistic_lock(:version)`, which bumps by exactly 1 (RS-14's wire values
  // are unchanged) AND filters the UPDATE on the version the row was loaded
  // with — a stale write raises `Ecto.StaleEntryError`, rescued to
  // `{:error, :conflict}` in `persist_change/1` (→ 409 at the controller),
  // the same protocol the generic PATCH seam has always used.
  const opVersioned = aggregateIsVersioned(agg);
  const opLockPipe6 = opVersioned ? "\n      |> Ecto.Changeset.optimistic_lock(:version)" : "";
  const opLockPipe = opVersioned ? "\n    |> Ecto.Changeset.optimistic_lock(:version)" : "";

  // Operation persistence re-runs the aggregate's cross-field invariants (the
  // audit's "operation persist skips validation"): the plain `change(%{})` +
  // `put_change` path bypasses every changeset validator, so a `handle := …`
  // mutation could break `handle != email`.  Pipe the persisted changeset
  // through the changeset module's `validate_invariants/1` before the write so an
  // unmet invariant returns `{:error, changeset}` (422) instead of committing.
  // Gated on residual invariants → byte-identical when the aggregate has none.
  const changesetMod = `${aggModule}Changeset`;
  const invPipe = aggregateHasResidualInvariants(agg)
    ? `\n    |> ${changesetMod}.validate_invariants()`
    : "";
  const invPipe6 = aggregateHasResidualInvariants(agg)
    ? `\n      |> ${changesetMod}.validate_invariants()`
    : "";

  const prelude = [...paramBinds, ...bodyLines].join("\n");
  const preludeBlock = prelude
    ? `${beforeBind}${captureBase}${prelude}\n`
    : `${beforeBind}${captureBase}`;

  // Persist tail.  Without provenance or audit: the plain changeset pipe.  With
  // either: build the changeset, then run the save + (history flush and/or audit
  // record) in ONE shared transaction so the derived rows commit atomically with
  // the aggregate update.
  const appModule = facadeMod.split(".")[0]!;
  const aggPascalName = upperFirst(agg.name);
  const txTail: string[] = [];
  if (hasProv) txTail.push(`          ${appModule}.Provenance.flush(${appModule}.Repo)`);
  if (hasAudit) {
    txTail.push(
      auditRecordCall({
        appModule,
        operationId: `${op.name}${aggPascalName}`,
        action: op.name,
        targetType: aggPascalName,
        targetId: "saved.id",
        before: "audit_before",
        after: wireSnapshot("saved", false, appModule),
        indent: "          ",
      }),
    );
  }
  const dispatchBlock = dispatchLines.join("\n");
  let persist: string;
  if (txWrapEmits) {
    // Durable emit: the outbox INSERT rides `Repo.transaction` together with
    // the persist (+ any prov/audit rows), so "aggregate saved" and "event
    // owed" commit or roll back as one.
    //
    // The PubSub BROADCAST does not ride it.  That is the SSE / LiveView wire,
    // and a broadcast inside the tx is observable before the commit — a
    // rollback then leaves subscribers holding an event whose write never
    // happened.  So: bind the event structs first, INSERT inside, broadcast in
    // the post-commit `{:ok, saved}` arm (the ordering the non-durable branches
    // below already use).  `Repo.transaction`'s result is unwrapped through
    // `tx_result` so the outer `{:ok, saved}` / `{:error, reason}` shape is
    // unchanged.
    persist = `${durableEmit.bind.length > 0 ? `${durableEmit.bind.join("\n")}\n\n` : ""}    changeset =
      ${persistBase}
      |> Ecto.Changeset.change(%{})${putBlock6}${opLockPipe6}${invPipe6}

    tx_result =
      ${appModule}.Repo.transaction(fn ->
      case ${repoMod}.persist_change(changeset) do
        {:ok, saved} ->
${txTail.length > 0 ? `${txTail.join("\n")}\n` : ""}${durableEmit.dispatch.join("\n")}
          saved

        {:error, reason} ->
          ${appModule}.Repo.rollback(reason)
      end
    end)

    case tx_result do
      {:ok, saved} ->
${durableEmit.broadcast.join("\n")}
        {:ok, saved}

      {:error, reason} ->
        {:error, reason}
    end`;
  } else if (hasProv || hasAudit) {
    persist = emits
      ? // Emit + prov/audit: commit the state change (+ derived rows) in the
        // transaction, then dispatch AFTER commit (outside the tx fn) so a
        // rollback drops the events too.
        `    changeset =
      ${persistBase}
      |> Ecto.Changeset.change(%{})${putBlock6}${opLockPipe6}${invPipe6}

    tx_result =
      ${appModule}.Repo.transaction(fn ->
      case ${repoMod}.persist_change(changeset) do
        {:ok, saved} ->
${txTail.join("\n")}
          saved

        {:error, reason} ->
          ${appModule}.Repo.rollback(reason)
      end
    end)

    case tx_result do
      {:ok, saved} ->
${dispatchBlock}
        {:ok, saved}

      {:error, reason} ->
        {:error, reason}
    end`
      : `    changeset =
      ${persistBase}
      |> Ecto.Changeset.change(%{})${putBlock6}${opLockPipe6}${invPipe6}

    ${appModule}.Repo.transaction(fn ->
      case ${repoMod}.persist_change(changeset) do
        {:ok, saved} ->
${txTail.join("\n")}
          saved

        {:error, reason} ->
          ${appModule}.Repo.rollback(reason)
      end
    end)`;
  } else {
    persist = emits
      ? // Emit, no prov/audit: persist then dispatch after `{:ok, saved}` — a
        // phantom event can no longer fire on a failed write, and the event
        // reaches the context Dispatcher (saga seam) + the raw broadcast.
        `    changeset =
      ${persistBase}
      |> Ecto.Changeset.change(%{})${putBlock6}${opLockPipe6}${invPipe6}

    case ${repoMod}.persist_change(changeset) do
      {:ok, saved} ->
${dispatchBlock}
        {:ok, saved}

      {:error, reason} ->
        {:error, reason}
    end`
      : `    ${persistBase}
    |> Ecto.Changeset.change(%{})${putBlock}${opLockPipe}${invPipe}
    |> ${repoMod}.persist_change()`;
  }

  // A guarded op hoists its guards into a leading `with ensure(...)` chain: param
  // binds stay before the `with`, and the body + persist tail move inside the
  // `do` block (a failed guard short-circuits to `{:error, :forbidden}` /
  // `{:error, :precondition_failed}` before any write).  The `{:error, term()}`
  // spec arm already covers those denial atoms.  A guard-free op keeps the flat
  // `${preludeBlock}${persist}` layout (byte-identical).
  const bodyContent =
    guardClauses.length > 0
      ? `${beforeBind}${captureBase}${paramBinds.length > 0 ? `${paramBinds.join("\n")}\n` : ""}${wrapOpBodyWithGuards(
          guardClauses,
          [...bodyLines, persist],
        ).join("\n")}`
      : `${preludeBlock}${persist}`;

  return `  @doc "Named operation \`${op.name}\` on \`${aggPascal}\` — runs the body, persists the assigned fields."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, ${aggModule}.t()} | {:error, Ecto.Changeset.t() | term()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params${opUsesCurrentUser(op) ? ", current_user \\\\ nil" : ""}) when is_map(params) do
${bodyContent}
  end`;
}
