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
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  StmtIR,
  SystemIR,
} from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import { statementSubRegions } from "../../_trace/sourcemap.js";
import { contextHasDispatcher } from "../dispatch-emit.js";
import { opUsesCurrentUser, stmtUsesParam } from "../domain/predicates.js";
import { renderReadingServiceContextFns } from "../domain-service-emit.js";
import type { RenderCtx } from "../render-expr.js";
import { auditRecordCall, wireSnapshot } from "./audit-emit.js";
import { aggregateUsesPrincipalContextFilter } from "./capability-filter.js";
import { aggregateHasResidualInvariants } from "./changeset-invariant-emit.js";
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
  isReturningOperation,
  type OpFragment,
  opEmitsEvent,
  opHasGuards,
  persistPutBodies,
  renderEmitDispatchLines,
  renderOpGuardClause,
  renderReturningOpFunction,
  renderReturningStmt,
  wrapOpBodyWithGuards,
} from "./operation-returns-emit.js";
import { refCollFieldNames } from "./ref-collection-emit.js";
import { customFindsOf } from "./repository-emit.js";
import { emitsRestDelete } from "./rest-surface.js";
import { usesRelationalContainments } from "./schema-emit.js";
import { stampUsesPrincipal } from "./stamp-emit.js";

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
  const content = renderContextModule(appModule, ctxModule, ctx, sys, opFragments);
  out.set(path, content);
  if (sourcemap && opFragments) {
    for (const frag of opFragments) {
      sourcemap.fragment(path, content, frag.fragmentText, frag.subRegions);
    }
  }
}

function renderContextModule(
  appModule: string,
  ctxModule: string,
  ctx: BoundedContextIR,
  sys?: SystemIR,
  opFragments?: OpFragment[],
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
    const destroyFacade = hasDestroy
      ? `\n
  @doc "Hard-delete a ${aggPascal} by id (DestroyForm seam) — raises if not found."
  def destroy_${aggSnake}!(${getArgs}) do
    case get_${aggSnake}(${getArgs}) do
      {:ok, record} -> ${appModule}.Repo.delete!(record)
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
    const deleteDelegate = emitsRestDelete(agg)
      ? `\n  defdelegate delete_${aggSnake}(record), to: ${repoMod}, as: :delete`
      : "";
    return `  # ${aggPascal}
  defdelegate list_${aggSnake}s(${listDelegateArgs}), to: ${repoMod}, as: :list
  defdelegate get_${aggSnake}(id${actorArg}), to: ${repoMod}, as: :find_by_id${
    agg.writeScopeFilter
      ? `\n  defdelegate get_${aggSnake}_for_write(id${actorArg}), to: ${repoMod}, as: :find_by_id_for_write`
      : ""
  }
  defdelegate create_${aggSnake}(attrs${stampActorArg}), to: ${repoMod}, as: :insert
  defdelegate update_${aggSnake}(record, attrs${stampActorArg}${versionedArg}), to: ${repoMod}, as: :update${deleteDelegate}${changeFacade}${destroyFacade}${opBangFacade}
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
  const refCollHelpers = contextUsesRefCollOp(ctx)
    ? `\n${renderContextRefCollHelpers(appModule)}\n`
    : "";

  // Shared relational-containment helper — emitted once per context module when
  // ANY named operation mutates a RELATIONAL containment (`lines += Line{…}` on a
  // `has_many` child-table aggregate, §11c).  `__put_assoc_parts/1` normalises the
  // mutated part-struct list to `put_assoc`-ready maps (the persist tail calls it);
  // see its emit for why a bare struct doesn't insert.
  const putAssocPartsHelper = contextMutatesRelationalContainment(ctx, sys)
    ? `\n${renderPutAssocPartsHelper()}\n`
    : "";

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

  return `# Auto-generated.
defmodule ${facadeMod} do
  @moduledoc """
  Plain context module for the ${ctx.name} bounded context.  Façade
  re-exporting per-aggregate Repository functions plus named-operation
  handlers (workflows need
  \`<op>_<agg>(record, params)\` for cross-aggregate calls in the
  workflow body).  Plain Elixir context module.
  """${requireLogger}${refCollHelpers ? "\n  import Ecto.Query" : ""}

${blocks.join("\n")}${retrievalBlock}${readingServiceBlock}${ensureBlock}${refCollHelpers}${putAssocPartsHelper}end
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
    return (agg.operations ?? []).some(
      (op) => !CRUD_RESERVED_NAMES.has(op.name) && opHasGuards(op),
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

/** Does any non-CRUD named operation in the context append/remove through a
 *  reference collection (`X id[]` → `many_to_many`)?  Gates the shared
 *  `__ref_id_list` / `__resolve_refs` helper emission. */
function contextUsesRefCollOp(ctx: BoundedContextIR): boolean {
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

/** Does any non-CRUD named operation in the context mutate a RELATIONAL
 *  containment (`lines += Line{…}` / `-=` on a `has_many` child-table aggregate,
 *  §11c)?  Gates the shared `__put_assoc_parts/1` helper emission — relational
 *  containments persist via `put_assoc(..., __put_assoc_parts(record.f))`. */
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
            (s.kind === "add" || s.kind === "remove") &&
            s.collection &&
            containNames.has(snake(s.target.segments[0] ?? "")),
        ),
    );
  });
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
  // The sole call site passes `record.<field>` AFTER the op body rebound it to
  // `(record.<field> || []) ++ [<new part struct>]` — always a concrete list —
  // so a single `is_list` clause covers every call (a `%Ecto.Association.NotLoaded{}`
  // / catch-all clause is provably unreachable and trips `--warnings-as-errors`
  // with "this clause is never used").  Per-element it still tolerates the three
  // forms a mutated list can hold: an already-built changeset, a part struct, or
  // a bare map.
  return `  # Normalise a relational-containment value (a \`has_many\` of part structs,
  # mixing loaded existing rows with freshly-built ones) to \`put_assoc\`-ready
  # maps — a bare struct with a nil PK would NOT be inserted by \`put_assoc\`
  # (Ecto reads a struct as an already-persisted row → empty changeset), but a
  # map WITHOUT \`id\` inserts and one WITH \`id\` is kept/updated.
  defp __put_assoc_parts(list) when is_list(list) do
    Enum.map(list, fn
      %Ecto.Changeset{} = cs ->
        cs

      %{__struct__: _} = part ->
        part
        |> Map.from_struct()
        |> Map.drop([:__meta__, :inserted_at, :updated_at])
        |> Enum.reject(fn {_k, v} ->
          match?(%Ecto.Association.NotLoaded{}, v) or is_nil(v)
        end)
        |> Map.new()

      other ->
        other
    end)
  end`;
}

/** The two private helpers a context module emits when a named op mutates a
 *  reference collection. */
function renderContextRefCollHelpers(appModule: string): string {
  return `  # Normalise a reference-collection value to a list of id strings — a
  # preloaded \`many_to_many\` is a list of target structs; a not-yet-loaded one
  # (or already-raw id list) passes through.
  defp __ref_id_list(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_id_list(list) when is_list(list) do
    Enum.map(list, fn
      %{id: id} -> to_string(id)
      id -> to_string(id)
    end)
  end
  defp __ref_id_list(_), do: []

  # Load reference-collection ids back to target structs for \`put_assoc\`.
  defp __resolve_refs(ids, target_mod) do
    ids = ids |> List.wrap() |> Enum.map(&to_string/1)
    ${appModule}.Repo.all(from(t in target_mod, where: t.id in ^ids))
  end`;
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
    foundation: "vanilla",
    agg: agg as EnrichedAggregateIR,
  };
  // Preconditions → a leading `with :ok <- ensure(...)` chain (identical atoms +
  // 422 mapping to the non-extern guard path); the extern delegation is the final
  // with-clause, rebinding `record` to the mutated struct.
  const guardClauses = op.statements
    .filter(
      (s): s is Extract<StmtIR, { kind: "requires" | "precondition" }> =>
        s.kind === "requires" || s.kind === "precondition",
    )
    .map((s) => renderOpGuardClause(s, rc));
  const withClauses = [...guardClauses, `{:ok, record} <- ${implMod}.${opSnake}(record, params)`];
  // Bind the params the preconditions reference (`score = Map.get(params,
  // "score")`) BEFORE the `with` — a precondition like `score >= 0` reads the op
  // param, not a column, so it needs the local.  Params the guards don't touch
  // stay inside the `params` map the hook receives (no unused-var warning).
  const paramBinds = op.params
    .filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)))
    .map((p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})\n`)
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
    foundation: "vanilla",
    captureProvenance: hasProv,
    // The enriched aggregate, so the body renderer can detect reference-
    // collection (`X id[]`) add/remove and normalise to id lists (the persist
    // then `put_assoc`s the resolved structs instead of `put_change`).
    agg: agg as EnrichedAggregateIR,
  };

  // The `before` wire snapshot — taken from the ORIGINAL `record` before the
  // body rebinds any field, so it reflects the pre-mutation state (parity with
  // the Hono/Python `before` captured before the mutation).
  const beforeBind = hasAudit ? `    audit_before = ${wireSnapshot("record")}\n` : "";

  // Bind only the params the body references, so an unused param never trips
  // `mix compile --warnings-as-errors`.  (`record` is always used — the persist
  // pipeline reads it — so it needs no such guard.)
  const usedParams = op.params.filter((p) => op.statements.some((s) => stmtUsesParam(s, p.name)));
  const paramBinds = usedParams.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );

  // S5a: a body that `emit`s a domain event is restructured to persist-then-
  // dispatch — the `emit`s are hoisted out of the interleaved body and fanned
  // out (Dispatcher + broadcast) AFTER `persist_change` commits, so no phantom
  // event fires on a failed write and each event reaches the context Dispatcher
  // (saga seam), not just the subscriber-less raw broadcast.  A named op always
  // persists, so the `{:ok, saved}` seam always exists.
  const emits = opEmitsEvent(op);
  const hasDispatcher = contextHasDispatcher(ctx as EnrichedBoundedContextIR);
  const dispatchLines = emits
    ? renderEmitDispatchLines(
        op,
        rc,
        hasDispatcher,
        "        ",
        `${ctx.name}.${agg.name}.${op.name}`,
        opFragments,
      )
    : [];

  // Render the body (guards / assigns / let) — shared with the returning-op
  // path; a non-returning body never carries a `return` arm.  The statement index
  // disambiguates per-write provenance temp vars.  When emitting, the `emit`s are
  // rendered post-commit (below), not inline.  `bodyStmts` is kept alongside
  // `bodyLines` (rather than only the mapped-over result) so a source-map
  // collector can zip the two SAME-length, SAME-order arrays back together via
  // `statementSubRegions` — a hoisted `emit` is deliberately excluded from
  // both, matching the "regular body" scope this milestone covers (see
  // `OpFragment` in operation-returns-emit.ts).
  // `requires`/`precondition` guards are hoisted into a leading `with :ok <-
  // ensure(...)` chain so an expected denial returns a typed tuple
  // (`{:error, :forbidden}` 403 / `{:error, :precondition_failed}` 422) BEFORE the
  // mutation/persist runs, instead of raising an ArgumentError (→ 500).  Exclude
  // them from the in-body statements.
  const guardStmts = op.statements.filter(
    (s): s is Extract<StmtIR, { kind: "requires" | "precondition" }> =>
      s.kind === "requires" || s.kind === "precondition",
  );
  const guardClauses = guardStmts.map((s) => renderOpGuardClause(s, rc));
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
  const preludeBlock = prelude ? `${beforeBind}${prelude}\n` : beforeBind;

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
        after: wireSnapshot("saved"),
        indent: "          ",
      }),
    );
  }
  const dispatchBlock = dispatchLines.join("\n");
  let persist: string;
  if (hasProv || hasAudit) {
    persist = emits
      ? // Emit + prov/audit: commit the state change (+ derived rows) in the
        // transaction, then dispatch AFTER commit (outside the tx fn) so a
        // rollback drops the events too.
        `    changeset =
      record
      |> Ecto.Changeset.change(%{})${putBlock6}${invPipe6}

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
      record
      |> Ecto.Changeset.change(%{})${putBlock6}${invPipe6}

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
      record
      |> Ecto.Changeset.change(%{})${putBlock6}${invPipe6}

    case ${repoMod}.persist_change(changeset) do
      {:ok, saved} ->
${dispatchBlock}
        {:ok, saved}

      {:error, reason} ->
        {:error, reason}
    end`
      : `    record
    |> Ecto.Changeset.change(%{})${putBlock}${invPipe}
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
      ? `${beforeBind}${paramBinds.length > 0 ? `${paramBinds.join("\n")}\n` : ""}${wrapOpBodyWithGuards(
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
