import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  CriterionIR,
  EnrichedAggregateIR,
  ExprIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { effectiveSavingShape } from "../../ir/util/resolve-datasource.js";
import { snake, upperFirst } from "../../util/naming.js";
import { promotedCapabilities, promotedReadFilter } from "./capability-filter.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Repository / find emission for Ash.
//
// Ash auto-generates standard CRUD actions (`get`, `read`, `create`,
// `update`, `destroy`) from `defaults`.  Only user-declared `find <name>`
// entries in a `repository` block need explicit Ash read actions.
//
// Strategy: emit explicit read actions as a side-channel file
//   `lib/<app>/<context>/<aggregate>_finds.ex`
// that the resource module `use`-includes.  The resource's `actions do`
// block declares only the defaults; the finds file appends extra actions.
//
// Alternative (splice into domain-emit's actions block): also supported —
// `buildFindActions` returns a list of action snippet strings that
// domain-emit can splice directly.  Both strategies are exported; the
// orchestrator chooses which to use.
// ---------------------------------------------------------------------------

/** Build Ash read action snippets for each custom find on a repository.
 *  Returns an array of multi-line strings, each representing one
 *  `read :<name> do … end` block suitable for splicing into a resource's
 *  `actions do … end` section by domain-emit.ts. */
export function buildFindActions(
  repo: RepositoryIR,
  agg: EnrichedAggregateIR,
  contextModule: string,
  bctx: BoundedContextIR,
): string[] {
  // `agg` threaded so renderMethodCall's contains branch (see
  // render-expr.ts) can resolve `this.<refColl>.contains(param)` to
  // `exists(<rel>, id == ^arg(:<param>))` against the join entity.
  const ctx: RenderCtx = { thisName: "record", contextModule, agg };
  // §11.6 triage: the capabilities promoted out of `base_filter` (some read
  // `ignoring`s them) must be re-applied per-read.  Each find combines the
  // promoted predicate — minus the capabilities IT bypasses — with its own
  // `where`.
  const promoted = new Set(promotedCapabilities(agg, bctx));
  // Skip the IR-enriched "all" find: Ash's `defaults [:read, ...]`
  // already provides an equivalent default :read action.  Emitting a
  // custom `read :all do end` block alongside is harmless but
  // redundant; leaving it would also force the domain to keep a
  // duplicate `define :all_X, action: :all` which adds noise without
  // adding behaviour.
  return repo.finds
    .filter((f) => f.name !== "all")
    .map((find) =>
      renderFindAction(
        find,
        agg,
        ctx,
        reifiedCriterionForRef(find.criterionRef, bctx),
        promotedReadFilter(agg, bctx, ctx, promoted, {
          bypassAll: find.bypassAll,
          bypassCaps: find.bypassCaps,
        }),
      ),
    );
}

/** Build Ash read-action snippets for each context retrieval targeting
 *  `agg` (retrieval.md) — the Phoenix analog of Hono's `run<Name>` /
 *  .NET's `Run<Name>Async`.  Each becomes a paginated, sorted read whose
 *  `where` is rendered as an Ash `filter expr(...)` with read-action
 *  arguments bound via `^arg(:name)`. */
export function buildRetrievalActions(
  ctx: BoundedContextIR,
  agg: EnrichedAggregateIR,
  contextModule: string,
): string[] {
  const rctx: RenderCtx = { thisName: "record", contextModule, agg };
  const promoted = new Set(promotedCapabilities(agg, ctx));
  // §11.6: a retrieval read action is shared across its inline `Repo.run`
  // call-sites.  When some call-site `ignoring`s a promoted capability, that
  // capability's predicate is omitted from the SHARED action (the bypass is
  // per-action here, not per-call — the validator admits no conflicting mix on
  // one retrieval).  The union of the bypasses of every repo-run hitting this
  // retrieval drives the omission.
  const bypassByRetrieval = inlineRunBypassesByRetrieval(ctx, agg.name);
  return (ctx.retrievals ?? [])
    .filter((r) => r.targetType.kind === "entity" && r.targetType.name === agg.name)
    .map((r) =>
      renderRetrievalAction(
        r,
        rctx,
        agg,
        reifiedCriterionOf(r, ctx),
        promotedReadFilter(agg, ctx, rctx, promoted, bypassByRetrieval.get(r.name)),
      ),
    );
}

/** The union bypass spec per retrieval name, drawn from the inline
 *  `Repo.run(<Retrieval>(…)) ignoring …` call-sites in the context's workflows
 *  that target `aggName`.  A retrieval read action is shared, so all its
 *  call-sites' bypasses union (`bypassAll` if ANY bypasses all, else the union
 *  of named caps). */
function inlineRunBypassesByRetrieval(
  ctx: BoundedContextIR,
  aggName: string,
): Map<string, { bypassAll?: boolean; bypassCaps?: string[] }> {
  const acc = new Map<string, { bypassAll: boolean; caps: Set<string> }>();
  const visit = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (s.kind === "repo-run" && s.aggName === aggName) {
        const cur = acc.get(s.retrievalName) ?? { bypassAll: false, caps: new Set<string>() };
        if (s.bypassAll) cur.bypassAll = true;
        for (const c of s.bypassCaps ?? []) cur.caps.add(c);
        acc.set(s.retrievalName, cur);
      }
      if (s.kind === "for-each") visit(s.body);
      if (s.kind === "if-let") {
        visit(s.thenBody);
        visit(s.elseBody ?? []);
      }
    }
  };
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) visit(c.statements);
    for (const h of wf.handlers ?? []) visit(h.statements);
    for (const on of wf.subscriptions ?? []) visit(on.statements);
  }
  const out = new Map<string, { bypassAll?: boolean; bypassCaps?: string[] }>();
  for (const [name, v] of acc) {
    out.set(name, v.bypassAll ? { bypassAll: true } : { bypassCaps: [...v.caps] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reified criteria (Ash).  A `retrieval` whose `where` is exactly a named
// `criterion` reifies to an Ash boolean **calculation** — the platform-native
// analog of .NET's `Criterion<T>` / Hono's predicate fn.  The read action's
// `filter` references the calculation (`filter expr(named_like(needle: ^arg(:needle)))`)
// instead of inlining the predicate.  Behaviour-identical to the inline form
// (the calculation expr is the same predicate), so cross-backend conformance
// parity is unaffected — only the generated Ash is organised around the
// criterion as a first-class, reusable, queryable predicate.
// ---------------------------------------------------------------------------

/** The named criterion a `criterionRef` reifies to — present in the context —
 *  or undefined (the `where` is composed/anonymous, so it stays inline).
 *  Shared by retrievals and finds (both carry an optional `criterionRef`). */
export function reifiedCriterionForRef(
  ref: { name: string; args: ExprIR[] } | undefined,
  ctx: BoundedContextIR,
): CriterionIR | undefined {
  if (!ref) return undefined;
  return (ctx.criteria ?? []).find((c) => c.name === ref.name);
}

/** The named criterion a retrieval's `where` reifies to (see
 *  `reifiedCriterionForRef`). */
export function reifiedCriterionOf(r: RetrievalIR, ctx: BoundedContextIR): CriterionIR | undefined {
  return reifiedCriterionForRef(r.criterionRef, ctx);
}

/** Ash calculation atom for a reified criterion (`:named_like`). */
export function criterionCalcName(name: string): string {
  return snake(name);
}

/** The distinct criteria the retrievals, finds, *and capability filters*
 *  targeting `agg` reify to — one Ash boolean calculation each, deduped by name
 *  across all consumers (a criterion shared by a find and a `filter` yields one
 *  calculation).  Covers every `criterionRef` the read-action emitters AND
 *  `renderBaseFilter` reference, so a filter-only criterion (`filter
 *  ActiveOrders()` with no find using it) still gets its `<calc>` defined —
 *  otherwise `base_filter expr(<calc>(...))` would name an undefined calculation
 *  and `mix compile` would fail.  Principal-referencing filters are gated off
 *  elixir and never reach `base_filter`, so they're skipped here too. */
export function reifiedCriteriaFor(ctx: BoundedContextIR, agg: EnrichedAggregateIR): CriterionIR[] {
  const seen = new Set<string>();
  const out: CriterionIR[] = [];
  const add = (c: CriterionIR | undefined) => {
    if (c && !seen.has(c.name)) {
      seen.add(c.name);
      out.push(c);
    }
  };
  for (const r of ctx.retrievals ?? []) {
    if (r.targetType.kind !== "entity" || r.targetType.name !== agg.name) continue;
    add(reifiedCriterionOf(r, ctx));
  }
  for (const f of findRepoFor(ctx, agg.name)?.finds ?? []) {
    add(reifiedCriterionForRef(f.criterionRef, ctx));
  }
  const refs = agg.contextFilterRefs ?? [];
  (agg.contextFilters ?? []).forEach((predicate, i) => {
    if (exprUsesCurrentUser(predicate)) return;
    add(reifiedCriterionForRef(refs[i], ctx));
  });
  return out;
}

/** `calculate :named_like, :boolean, expr(<body>) do argument … end` — the
 *  boolean calculation a reified criterion becomes.  The body renders exactly
 *  as the derived-field calculations do (`this-prop` → `record.<attr>`, the
 *  established Ash-calc receiver — see `renderCalculations` / the `:display`
 *  derived), with `filterArgs` so the criterion's params bind as `^arg(:p)`
 *  (the calc's own arguments). */
export function renderCriterionCalculation(
  c: CriterionIR,
  agg: EnrichedAggregateIR,
  contextModule: string,
): string {
  const ctx: RenderCtx = { thisName: "record", contextModule, agg, filterArgs: true };
  const body = renderExpr(c.body, ctx);
  const name = criterionCalcName(c.name);
  if (c.params.length === 0) {
    return `    calculate :${name}, :boolean, expr(${body})`;
  }
  const args = c.params
    .map((p) => `      argument :${snake(p.name)}, ${ashArgType(p.type)}`)
    .join("\n");
  return `    calculate :${name}, :boolean, expr(${body}) do\n${args}\n    end`;
}

/** The owned-containment relationships a retrieval eager-loads, as Ash
 *  load atoms (`:lines`, …).  Every retrieval loads the **whole**
 *  aggregate: explicit `loads:` narrowing is gated at IR validation (not
 *  supported yet — the planned replacement is per-operation autoload, see
 *  validate.ts / load-specifications.md), so the load set is purely a
 *  function of the aggregate.  Only `relational` aggregates expose their
 *  `contains` as Ash relationships; `embedded`/`document` shapes fold the
 *  parts inline (jsonb attributes — always materialised, nothing to
 *  load), so those yield an empty list.  Loading every owned containment
 *  lets a downstream operation read `record.<part>` without a
 *  `%NotLoaded{}` crash.  Cross-aggregate references (`X id`) stay ids and
 *  are never loaded.  Ash realises `load` as a separate batched query per
 *  relationship, so this composes with the action's offset pagination
 *  without the in-memory collection-paging penalty an ORM join-fetch hits. */
function retrievalLoadAtoms(agg: EnrichedAggregateIR): string[] {
  if (effectiveSavingShape(agg) !== "relational") return [];
  return agg.contains.map((c) => `:${snake(c.name)}`);
}

function renderRetrievalAction(
  r: RetrievalIR,
  ctx: RenderCtx,
  agg: EnrichedAggregateIR,
  reified: CriterionIR | undefined,
  /** The §11.6 promoted-capability filter this retrieval action must apply
   *  (minus the caps its inline `Repo.run` call-sites `ignoring`), or null. */
  promotedFilter?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`    read :${snake(r.name)} do`);
  // §11.6: promoted-capability predicate, applied as its own `filter expr(...)`
  // line (Ash conjoins multiple `filter` clauses on an action).
  if (promotedFilter) {
    lines.push(`      filter expr(${promotedFilter})`);
  }
  for (const p of r.params) {
    lines.push(`      argument :${snake(p.name)}, ${ashArgType(p.type)}`);
  }
  // Offset pagination — the call-site `page: [offset:, limit:]` rides
  // here; `required?: false` keeps an unpaged call returning a plain list.
  lines.push(`      pagination offset?: true, required?: false`);
  // Sort → `prepare build(sort: [field: :dir, ...])` (first path segment
  // per term, mirroring the Hono/.NET v1 single-column sort).
  if (r.sort.length > 0) {
    const terms = r.sort.map((s) => `${snake(s.path[0]!.name)}: :${s.direction}`).join(", ");
    lines.push(`      prepare build(sort: [${terms}])`);
  }
  // Eager-load shape (load-specifications.md / loadPlan).  Every
  // retrieval loads the whole aggregate — every owned containment
  // relationship — so a downstream for-loop op can read `record.<part>`.
  // (Explicit narrowing is gated at IR validation until autoload lands.)
  // Embedded/document aggregates carry parts inline and yield no atoms.
  const loadAtoms = retrievalLoadAtoms(agg);
  if (loadAtoms.length > 0) {
    lines.push(`      prepare build(load: [${loadAtoms.join(", ")}])`);
  }
  // `where` → Ash filter.  When the `where` reifies to a named criterion,
  // reference its boolean calculation (`named_like(needle: ^arg(:needle))`)
  // instead of inlining the predicate; the calc args pair the criterion's
  // parameter names with the retrieval's call-site argument expressions
  // (`^arg(:…)` under `filterArgs`).  Otherwise render the inlined `where`
  // directly — stripping the `record.` receiver Ash filters don't use (bare
  // attribute names — same convention as the #762 base_filter).
  const filterCtx: RenderCtx = { ...ctx, thisName: "record", filterArgs: true };
  let rendered: string;
  if (reified) {
    const callArgs = reified.params.map((p, i) => {
      const argExpr = r.criterionRef!.args[i]!;
      const val = renderExpr(argExpr, filterCtx).replace(/\brecord\./g, "");
      return `${snake(p.name)}: ${val}`;
    });
    rendered =
      callArgs.length === 0
        ? criterionCalcName(reified.name)
        : `${criterionCalcName(reified.name)}(${callArgs.join(", ")})`;
  } else {
    rendered = renderExpr(r.where, filterCtx).replace(/\brecord\./g, "");
  }
  lines.push(`      filter expr(${rendered})`);
  lines.push(`    end`);
  return lines.join("\n");
}

/** Map a Loom param type to the Ash argument type atom.  Conservative:
 *  the common scalars; anything else falls back to `:string` (the prior
 *  hardcoded behaviour for find args). */
function ashArgType(type: import("../../ir/types/loom-ir.js").TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
        return ":integer";
      case "decimal":
        return ":decimal";
      case "bool":
        return ":boolean";
      case "datetime":
        return ":utc_datetime";
      default:
        return ":string";
    }
  }
  if (type.kind === "id") return ":uuid";
  return ":string";
}

function renderFindAction(
  find: FindIR,
  agg: AggregateIR,
  ctx: RenderCtx,
  reified?: CriterionIR | undefined,
  /** The §11.6 promoted-capability filter this read must apply (minus the caps
   *  it `ignoring`s), or null when none — see `promotedReadFilter`.  AND-ed with
   *  the find's own `where`. */
  promotedFilter?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`    read :${snake(find.name)} do`);
  // Arguments
  for (const p of find.params) {
    lines.push(`      argument :${snake(p.name)}, :string`);
  }
  // §11.6: the promoted-capability predicate this read applies, AND-ed onto its
  // own filter.  Rendered as its own `filter expr(...)` line — Ash conjoins
  // multiple `filter` clauses on an action — so the find's own filter path
  // below stays unchanged.
  if (promotedFilter) {
    lines.push(`      filter expr(${promotedFilter})`);
  }
  // Filter preparation
  if (find.filter) {
    // When the `where` reifies to a named criterion, reference its boolean
    // calculation (`in_region(rgn: ^arg(:r))`) instead of inlining the
    // predicate — matching the retrieval path (renderRetrievalAction).  The
    // calc args pair the criterion's parameter names with the find's call-site
    // argument expressions (`^arg(:…)` under `filterArgs`).
    if (reified) {
      const filterCtx: RenderCtx = { ...ctx, thisName: "record", filterArgs: true };
      const callArgs = reified.params.map((p, i) => {
        const argExpr = find.criterionRef!.args[i]!;
        const val = renderExpr(argExpr, filterCtx).replace(/\brecord\./g, "");
        return `${snake(p.name)}: ${val}`;
      });
      const rendered =
        callArgs.length === 0
          ? criterionCalcName(reified.name)
          : `${criterionCalcName(reified.name)}(${callArgs.join(", ")})`;
      lines.push(`      filter expr(${rendered})`);
    } else {
      const filterExpr = renderFilterPreparation(find, agg, ctx);
      lines.push(`      filter ${filterExpr}`);
    }
  } else if (find.params.length > 0) {
    // Convention-based: match params to same-named fields
    const conditions = buildConventionFilter(find, agg);
    if (conditions) {
      lines.push(`      filter expr(${conditions})`);
    }
  }
  // Single-result reads
  if (find.returnType.kind !== "array" && !pagedReturn(find.returnType)) {
    lines.push(`      get? true`);
  }
  // Paged (P3b): Ash offset pagination — the controller passes
  // `page: [limit:, offset:, count: true]`; the count gives `total`.
  if (pagedReturn(find.returnType)) {
    lines.push(`      pagination offset?: true, required?: false`);
  }
  lines.push(`    end`);
  return lines.join("\n");
}

function renderFilterPreparation(find: FindIR, _agg: AggregateIR, ctx: RenderCtx): string {
  // Render as an Ash expr(...) filter — money/decimal lower to the data layer
  // via native operators here, not the Elixir `Decimal.*` struct API.
  const exprStr = renderExpr(find.filter!, { ...ctx, thisName: "record", ashExpr: true });
  return `expr(${exprStr})`;
}

function buildConventionFilter(find: FindIR, agg: AggregateIR): string {
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`${snake(matchedField.name)} == ^arg(:${snake(p.name)})`);
    }
  }
  return conditions.join(" and ");
}

/** Emit a standalone finds file for an aggregate.
 *
 *  Path: `lib/<app>/<ctxSnake>/<aggSnake>_finds.ex`
 *
 *  The emitted module uses `Ash.Resource.Info` to get action definitions and
 *  re-opens the resource module to add custom read actions.  Elixir does not
 *  support reopening modules, so instead this emits the actions as a string
 *  that domain-emit splices inline — this function is provided for
 *  documentation and alternate-strategy callers.
 *
 *  In the primary strategy the orchestrator uses `buildFindActions` and
 *  domain-emit splices them into the resource's `actions do` block. */
export function emitFindsSideFile(
  appName: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  repo: RepositoryIR,
  appModule: string,
): { path: string; content: string } {
  const ctxSnake = snake(ctx.name);
  const aggSnake = snake(agg.name);
  const aggModule = `${appModule}.${upperFirst(ctx.name)}.${upperFirst(agg.name)}`;
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const findsCtx: RenderCtx = { thisName: "record", contextModule };

  const actionBlocks = repo.finds.map((find) => renderFindAction(find, agg, findsCtx));

  // This file documents the custom finds but is not used in the primary
  // emission path (domain-emit splices find actions inline).
  const content = `# Auto-generated — custom Ash read actions for ${upperFirst(agg.name)}.
# These are spliced inline into lib/${appName}/${ctxSnake}/${aggSnake}.ex by the generator.
# This file is provided for reference only.

defmodule ${aggModule}.Finds do
  @moduledoc """
  Custom read actions for ${upperFirst(agg.name)}.

  Standard CRUD (get / read / create / update / destroy) are auto-emitted
  via \`defaults\` in the resource module.  Only the user-declared finds
  below need explicit action definitions.
  """

  @doc "Custom find actions (for reference):"
  def actions do
    [
${actionBlocks
  .map((b) =>
    b
      .split("\n")
      .map((l) => "      " + l)
      .join("\n"),
  )
  .join(",\n")}
    ]
  end
end
`;
  return {
    path: `lib/${appName}/${ctxSnake}/${aggSnake}_finds.ex`,
    content,
  };
}

/** Find the repository for an aggregate in a context, if declared. */
export function findRepoFor(ctx: BoundedContextIR, aggName: string): RepositoryIR | undefined {
  return ctx.repositories.find((r) => r.aggregateName === aggName);
}

/** Synthesise view finds as extra read actions — matches dotnet/index.ts
 *  `mergeViewsAsFinds` pattern so views become first-class reads. */
export function mergeViewFindsForAgg(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
  ctx: BoundedContextIR,
): RepositoryIR | undefined {
  const matchingViews = ctx.views.filter(
    (v) => v.source.kind === "aggregate" && v.source.name === agg.name,
  );
  if (matchingViews.length === 0) return repo;

  const arrayReturn: import("../../ir/types/loom-ir.js").TypeIR = {
    kind: "array",
    element: { kind: "entity", name: agg.name },
  };
  const synthesised: FindIR[] = matchingViews.map((v) => ({
    name: snake(v.name),
    params: [],
    returnType: arrayReturn,
    filter: v.filter,
    // Carry the view's `ignoring` bypass onto the synthesised find so the
    // §11.6 promoted-capability filter is OMITTED on the view's read action.
    bypassAll: v.bypassAll,
    bypassCaps: v.bypassCaps,
  }));

  if (!repo) {
    return {
      name: `${agg.name}Repository`,
      aggregateName: agg.name,
      finds: synthesised,
    };
  }
  return { ...repo, finds: [...repo.finds, ...synthesised] };
}

// Re-export for convenience
export type { FindIR, RepositoryIR };
