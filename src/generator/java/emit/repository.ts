import type {
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
  SortTermIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import {
  bypassedPromotedCaps,
  type FilterBypass,
  wrapWithFilterBypass,
} from "../capability-filter.js";
import {
  boxedJavaType,
  collectJavaExprImports,
  collectJavaTypeImports,
  renderJavaExpr,
  renderJavaType,
} from "../render-expr.js";
import { renderJpqlWhere } from "../render-jpql.js";

// ---------------------------------------------------------------------------
// Repository emission — three artifacts per aggregate:
//
//   1. `<Agg>Repository`        (domain)        — the port the domain and
//      application layers see: save / findById / getById / findAll /
//      delete + the declared finds.
//   2. `<Agg>JpaRepository`     (infrastructure) — Spring Data JPA
//      interface; IR-derived finds render as `@Query` JPQL (derived
//      method names can't express an arbitrary ExprIR filter —
//      java-backend.md).
//   3. `<Agg>RepositoryImpl`    (infrastructure) — @Repository bean
//      delegating to (2); getById maps the miss to
//      AggregateNotFoundException (→ 404 in the controller advice).
// ---------------------------------------------------------------------------

export interface JavaRepoCtx {
  basePkg: string;
  /** Package of the domain interface (layout-resolved). */
  domainPkg: string;
  /** Package of the Spring Data interface + impl (layout-resolved). */
  infraPkg: string;
  /** Package the entity classes live in (imported by infra when it differs). */
  entityPkg: string;
  /** Package the reified `<Agg>Criteria` factories live in. */
  criteriaPkg?: string;
  /** Package `OffsetLimitPageRequest` lives in (infrastructure.persistence). */
  persistencePkg?: string;
  /** Retrievals targeting this aggregate (named query bundles). */
  retrievals?: RetrievalIR[];
  /** True when the retrieval's `where` is exactly an eligible criterion
   *  reference — the impl then consumes the Specification factory. */
  isReified?: (r: RetrievalIR) => boolean;
  /** True when this aggregate declares a `provenanced` field (provenance.md):
   *  the save impl drains the per-write lineage buffer into provenance_records
   *  in the same `@Transactional` boundary as the aggregate save. */
  provenance?: boolean;
  /** §11.6: the PROMOTED non-principal capabilities for this aggregate — those
   *  some read `ignoring`s, emitted as bypassable Hibernate named @Filters on the
   *  entity (capability-filter.ts).  A find / view / retrieval that drops one of
   *  these is wrapped with `session.disableFilter`/`enableFilter` in the impl. */
  promotedCaps?: ReadonlySet<string>;
  /** §11.6: per-retrieval-name UNION bypass spec, drawn from the inline
   *  `Repo.run(<Retrieval>(…)) ignoring …` call-sites in the context's workflows.
   *  A retrieval's `run<Name>` impl method is SHARED across call-sites, so its
   *  promoted-cap disable set is the union of every site's bypass. */
  bypassByRetrieval?: ReadonlyMap<string, FilterBypass>;
}

const dottedSortPath = (t: SortTermIR): string => t.path.map((s) => s.name).join(".");

/** `Sort.by(Sort.Order.asc("a.b"), …)` for the Specification path. */
function springSort(sort: readonly SortTermIR[]): string {
  if (sort.length === 0) return "Sort.unsorted()";
  const orders = sort.map((t) => `Sort.Order.${t.direction}(${JSON.stringify(dottedSortPath(t))})`);
  return `Sort.by(${orders.join(", ")})`;
}

/** ` order by e.a.b asc, …` for the JPQL path. */
function jpqlOrderBy(sort: readonly SortTermIR[]): string {
  if (sort.length === 0) return "";
  return ` order by ${sort.map((t) => `e.${dottedSortPath(t)} ${t.direction}`).join(", ")}`;
}

/** A `sort:` term as a chained accessor key extractor over `x`
 *  (`x.a().b()`) for an in-memory `Comparator`. */
function inMemorySortKey(t: SortTermIR): string {
  return `x -> x.${t.path.map((s) => `${s.name}()`).join(".")}`;
}

/** The in-memory `Comparator<Agg>` chain for a retrieval's `sort:`, or
 *  null when unsorted.  Each term is keyed off the accessor path; `desc`
 *  reverses that single term (`Comparator.comparing(...).reversed()`). */
function inMemoryComparator(sort: readonly SortTermIR[], agg: string): string | null {
  if (sort.length === 0) return null;
  const term = (t: SortTermIR): string => {
    const base = `Comparator.<${agg}, Comparable>comparing(${inMemorySortKey(t)})`;
    return t.direction === "desc" ? `${base}.reversed()` : base;
  };
  return sort
    .map(term)
    .reduce((acc, t, i) => (i === 0 ? t : `${acc}.thenComparing(${term(sort[i])})`));
}

/** Document- / event-sourced repositories can't push a retrieval into the
 *  store (the jsonb document / event log is not a query target), so each
 *  `run<Name>` rehydrates every aggregate via `findAll()`, evaluates the
 *  retrieval's `where` predicate (a typed `ExprIR`) in memory through the
 *  Java expression renderer, applies the `sort:` as a `Comparator`, and —
 *  for the paged overload — offset/limits the result (null offset → 0,
 *  null limit → unbounded).  The .NET document/event repos take the same
 *  hydrate-then-filter shape.  Returns the method lines plus the extra
 *  imports they need (`java.util.Comparator` when any retrieval sorts). */
export function inMemoryRetrievalLines(
  agg: EnrichedAggregateIR,
  retrievals: readonly RetrievalIR[],
  exprImports: Set<string>,
  /** §11.6: the promoted-cap `.filter(...)` clause to re-apply for a retrieval's
   *  `run<Name>` (minus the caps the retrieval's inline `Repo.run` call-sites
   *  `ignoring`).  `findAll()` applies only the always-on caps here, so a
   *  document repo must conjoin the promoted ones it doesn't bypass.  Returns ""
   *  when there are none.  Absent → no promoted re-application (event store /
   *  the relational path's always-on @Filter handles it at the DB). */
  promotedClauseFor?: (retrievalName: string, varName: string) => string,
): string[] {
  if (retrievals.length === 0) return [];
  if (retrievals.some((r) => r.sort.length > 0)) exprImports.add("java.util.Comparator");
  return retrievals.flatMap((r) => {
    const declared = r.params.map((p) => {
      collectJavaTypeImports(p.type, exprImports);
      return `${renderJavaType(p.type)} ${p.name}`;
    });
    collectJavaExprImports(r.where, exprImports);
    const where = renderJavaExpr(r.where, { thisName: "x", agg, accessorProps: true });
    const cmp = inMemoryComparator(r.sort, agg.name);
    const promotedClause = promotedClauseFor?.(r.name, "x") ?? "";
    const filtered = `findAll().stream().filter(x -> ${where})${promotedClause}`;
    const sorted = cmp ? `${filtered}.sorted(${cmp})` : filtered;
    const bareParams = declared.join(", ");
    const pagedParams = [bareParams, "Integer offset, Integer limit"].filter(Boolean).join(", ");
    return [
      `    @Override`,
      `    public List<${agg.name}> run${upperFirst(r.name)}(${bareParams}) {`,
      `        return ${sorted}.toList();`,
      `    }`,
      ``,
      `    @Override`,
      `    public List<${agg.name}> run${upperFirst(r.name)}(${pagedParams}) {`,
      `        return ${sorted}`,
      `            .skip(offset == null ? 0L : offset.longValue())`,
      `            .limit(limit == null ? Long.MAX_VALUE : limit.longValue())`,
      `            .toList();`,
      `    }`,
      ``,
    ];
  });
}

/** The enrichment-injected parameterless `all` find — already covered by
 *  the canonical `findAll()` surface (and the GET / route), so every
 *  emitter skips it. */
export function isAutoAllFind(f: FindIR): boolean {
  return f.name === "all" && f.params.length === 0 && !f.filter;
}

/** The declared finds an emitter should surface. */
export function declaredFinds(repo: RepositoryIR | undefined): FindIR[] {
  return (repo?.finds ?? []).filter((f) => !isAutoAllFind(f));
}

/** `find x(): T paged` — the carrier-bounded paged find. */
export function isPagedFind(f: FindIR): boolean {
  return f.returnType.kind === "genericInstance" && f.returnType.ctor === "paged";
}

/** A union-returning find (`Order or NotFound` / `Order option`) reaches
 *  the repository/service as its OPTIONAL TWIN — a single nullable row;
 *  the controller owns the union translation (absent → 404 / problem,
 *  found → the tagged wire record).  Mirrors .NET's
 *  `unionFindAsOptionalTwin`; the Domain layer never names the
 *  Response-side union type. */
export function unionFindAsOptionalTwin(find: FindIR, aggName: string): FindIR {
  if (find.returnType.kind !== "union") return find;
  const success = find.returnType.variants.find(
    (v) => v.kind === "entity" && v.name === aggName,
  ) ?? { kind: "entity" as const, name: aggName };
  return { ...find, returnType: { kind: "optional", inner: success } };
}

/** Finds keep their DSL name; a find returning `T[]` → `List<T>`,
 *  a single `T` → `T` (nullable); `T paged` → `Paged<T>` with trailing
 *  `int page, int pageSize` parameters (1-based, cross-backend). */
function findSignature(find: FindIR, imports: Set<string>): string {
  const params = [
    ...find.params.map((p) => {
      collectJavaTypeImports(p.type, imports);
      return `${renderJavaType(p.type)} ${p.name}`;
    }),
    ...(isPagedFind(find) ? ["int page", "int pageSize"] : []),
  ].join(", ");
  const ret = findReturn(find.returnType, imports);
  return `${ret} ${find.name}(${params})`;
}

function findReturn(t: TypeIR, imports: Set<string>): string {
  if (t.kind === "array") {
    imports.add("java.util.List");
    return `List<${boxedJavaType(t.element)}>`;
  }
  if (t.kind === "genericInstance" && t.ctor === "paged") {
    return `Paged<${boxedJavaType(t.arg)}>`;
  }
  collectJavaTypeImports(t, imports);
  return renderJavaType(t);
}

export function renderJavaRepositoryInterface(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
): string {
  const imports = new Set<string>(["java.util.List", "java.util.Optional"]);
  const findLines = declaredFinds(repo).map(
    (f) => `    ${findSignature(unionFindAsOptionalTwin(f, agg.name), imports)};`,
  );
  // Two overloads per retrieval, mirroring .NET's optional call-site
  // `page` tuple: the bare run plus `(…, Integer offset, Integer limit)`
  // (either may be null — partial pages are legal in the DSL).
  const retrievalLines = (ctx.retrievals ?? []).flatMap((r) => {
    const params = r.params
      .map((p) => {
        collectJavaTypeImports(p.type, imports);
        return `${renderJavaType(p.type)} ${p.name}`;
      })
      .join(", ");
    const pagedParams = [params, "Integer offset, Integer limit"].filter(Boolean).join(", ");
    return [
      `    List<${agg.name}> run${upperFirst(r.name)}(${params});`,
      ``,
      `    List<${agg.name}> run${upperFirst(r.name)}(${pagedParams});`,
    ];
  });
  const anyPaged = declaredFinds(repo).some(isPagedFind);
  return lines(
    `package ${ctx.domainPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    anyPaged ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.enums.*;`,
    ``,
    `@org.jmolecules.ddd.annotation.Repository`,
    `public interface ${agg.name}Repository {`,
    `    ${agg.name} save(${agg.name} aggregate);`,
    ``,
    `    Optional<${agg.name}> findById(${idClass} id);`,
    ``,
    `    /** @throws ${ctx.basePkg}.domain.common.AggregateNotFoundException on a miss (→ 404). */`,
    `    ${agg.name} getById(${idClass} id);`,
    ``,
    `    List<${agg.name}> findAll();`,
    ``,
    `    void delete(${agg.name} aggregate);`,
    findLines.length > 0 ? `` : null,
    ...findLines,
    retrievalLines.length > 0 ? `` : null,
    ...retrievalLines,
    `}`,
    ``,
  );
}

export function renderJavaSpringDataRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
): string {
  const imports = new Set<string>(["org.springframework.data.jpa.repository.JpaRepository"]);
  const finds = declaredFinds(repo).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const retrievals = ctx.retrievals ?? [];
  const anyReified = retrievals.some((r) => ctx.isReified?.(r));
  if (anyReified) {
    imports.add("org.springframework.data.jpa.repository.JpaSpecificationExecutor");
  }
  const enumsPkg = `${ctx.basePkg}.domain.enums`;
  // A principal (tenancy) `filter` (`this.tenantId == currentUser.tenantId`)
  // renders to JPQL with a SpEL accessor for the ambient request principal —
  // unlike a non-principal filter (which rides the entity's static
  // `@SQLRestriction`), it must be AND-ed into every query that can return a
  // row: each find/retrieval/view below, plus `findAll`/`findById` (which JPA
  // derives, so we override them with a scoped @Query).  `null` when the
  // aggregate has no principal filter — every other repository stays identical.
  const principalClause = principalJpqlClause(agg, enumsPkg);
  const jpqlWhere = (base: string | null): string => {
    const combined =
      base && principalClause ? `(${base}) and ${principalClause}` : (base ?? principalClause);
    return combined ? ` where ${combined}` : "";
  };
  const methodLines = finds.flatMap((f) => {
    if (f.params.length > 0) imports.add("org.springframework.data.repository.query.Param");
    imports.add("org.springframework.data.jpa.repository.Query");
    const where = jpqlWhere(f.filter ? renderJpqlWhere(f.filter, { alias: "e", enumsPkg }) : null);
    const declaredParams = f.params.map((p) => {
      collectJavaTypeImports(p.type, imports);
      return `@Param("${p.name}") ${renderJavaType(p.type)} ${p.name}`;
    });
    if (isPagedFind(f)) {
      // Spring Data derives the count query from the @Query + Pageable.
      imports.add("org.springframework.data.domain.Page");
      imports.add("org.springframework.data.domain.Pageable");
      const arg = f.returnType.kind === "genericInstance" ? f.returnType.arg : f.returnType;
      return [
        `    @Query("select e from ${agg.name} e${where}")`,
        `    Page<${boxedJavaType(arg)}> ${f.name}(${[...declaredParams, "Pageable pageable"].join(", ")});`,
        ``,
      ];
    }
    const ret = findReturn(f.returnType, imports);
    return [
      `    @Query("select e from ${agg.name} e${where}")`,
      `    ${ret} ${f.name}(${declaredParams.join(", ")});`,
      ``,
    ];
  });
  // Non-reified retrievals render as @Query JPQL (where + order by); the
  // reified ones ride JpaSpecificationExecutor in the impl instead.
  const retrievalLines = retrievals
    .filter((r) => !ctx.isReified?.(r))
    .flatMap((r) => {
      imports.add("org.springframework.data.jpa.repository.Query");
      if (r.params.length > 0) imports.add("org.springframework.data.repository.query.Param");
      imports.add("java.util.List");
      // Trailing Pageable carries the call-site offset/limit page; the
      // impl passes Pageable.unpaged() for the bare run.  The `order by`
      // is baked into the JPQL (an unsorted Pageable leaves it alone).
      imports.add("org.springframework.data.domain.Pageable");
      const where = jpqlWhere(renderJpqlWhere(r.where, { alias: "e", enumsPkg }));
      const params = r.params
        .map((p) => {
          collectJavaTypeImports(p.type, imports);
          return `@Param("${p.name}") ${renderJavaType(p.type)} ${p.name}`;
        })
        .join(", ");
      const sigParams = [params, "Pageable pageable"].filter(Boolean).join(", ");
      return [
        `    @Query("select e from ${agg.name} e${where}${jpqlOrderBy(r.sort)}")`,
        `    List<${agg.name}> run${upperFirst(r.name)}(${sigParams});`,
        ``,
      ];
    });
  // Scope the JPA-derived `findAll`/`findById` by re-declaring them with a
  // principal @Query — otherwise an unauthenticated-scope read or a guessed id
  // on another tenant's row would leak (the static @SQLRestriction can't carry
  // the runtime principal).
  const principalOverrides: string[] = [];
  if (principalClause) {
    imports.add("org.springframework.data.jpa.repository.Query");
    imports.add("org.springframework.data.repository.query.Param");
    imports.add("java.util.List");
    imports.add("java.util.Optional");
    principalOverrides.push(
      `    @Query("select e from ${agg.name} e where ${principalClause}")`,
      `    List<${agg.name}> findAll();`,
      ``,
      `    @Query("select e from ${agg.name} e where e.id = :id and ${principalClause}")`,
      `    Optional<${agg.name}> findById(@Param("id") ${idClass} id);`,
      ``,
    );
  }
  // Command-load path (authorization Phase 3 P3.1): a WRITE-scope-narrowed
  // `findByIdForWrite` the impl's `getById` loads through when the aggregate's
  // write scope is narrower than its read scope.  Same SpEL-principal @Query
  // shape as the read override, but with the write predicate — a row a caller
  // may READ but not WRITE reads as empty → 404 (no existence leak).
  const writeOverride: string[] = [];
  if (agg.writeScopeFilter) {
    imports.add("org.springframework.data.jpa.repository.Query");
    imports.add("org.springframework.data.repository.query.Param");
    imports.add("java.util.Optional");
    const writeClause = renderJpqlWhere(agg.writeScopeFilter, { alias: "e", enumsPkg });
    writeOverride.push(
      `    @Query("select e from ${agg.name} e where e.id = :id and ${writeClause}")`,
      `    Optional<${agg.name}> findByIdForWrite(@Param("id") ${idClass} id);`,
      ``,
    );
  }
  const allMethodLines = [
    ...principalOverrides,
    ...writeOverride,
    ...methodLines,
    ...retrievalLines,
  ];
  while (allMethodLines.length > 0 && allMethodLines[allMethodLines.length - 1] === "")
    allMethodLines.pop();
  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.enums.*;`,
    ``,
    `public interface ${agg.name}JpaRepository extends JpaRepository<${agg.name}, ${idClass}>${anyReified ? `, JpaSpecificationExecutor<${agg.name}>` : ""} {`,
    ...allMethodLines,
    `}`,
    ``,
  );
}

/** The aggregate's PRINCIPAL (tenancy) capability filters as a single JPQL
 *  predicate (each parenthesised, AND-ed) under the `e` alias, or null when it
 *  has none.  Non-principal filters are excluded — they ride the entity's
 *  static `@SQLRestriction` (see `emit/entity.ts`); only principal filters need
 *  the per-query SpEL-principal form. */
function principalJpqlClause(agg: EnrichedAggregateIR, enumsPkg: string): string | null {
  const preds = (agg.contextFilters ?? []).filter(exprUsesCurrentUser);
  if (preds.length === 0) return null;
  return preds.map((p) => `(${renderJpqlWhere(p, { alias: "e", enumsPkg })})`).join(" and ");
}

export function renderJavaRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
): string {
  const imports = new Set<string>(["java.util.List", "java.util.Optional"]);
  const finds = declaredFinds(repo).map((f) => unionFindAsOptionalTwin(f, agg.name));
  const retrievals = ctx.retrievals ?? [];
  const anyReified = retrievals.some((r) => ctx.isReified?.(r));
  // A reified retrieval reads via JpaSpecificationExecutor.findAll(spec), which
  // bypasses the scoped findAll/findById @Query overrides — so a PRINCIPAL
  // (tenancy) filter must be AND-ed in as a `tenantScope(User)` Specification,
  // which needs the request actor.  Inject CurrentUserAccessor only then.
  const principalScoped = (agg.contextFilters ?? []).some(exprUsesCurrentUser);
  const injectAccessor = anyReified && principalScoped;
  const provenance = !!ctx.provenance;
  const tenantScopeAnd = injectAccessor
    ? `.and(${agg.name}Criteria.tenantScope(currentUserAccessor.user()))`
    : "";
  // §11.6 selective bypass: a find / view / retrieval read that `ignoring`s a
  // PROMOTED capability runs with that cap's Hibernate named @Filter DISABLED.
  // The impl wraps the delegate body with `session.disableFilter/enableFilter`;
  // the @SQLRestriction-resident caps + principal filters are unaffected here
  // (the latter omit the conjunct in the JpaRepository @Query instead).
  const promotedCaps = ctx.promotedCaps ?? new Set<string>();
  let needsEntityManager = false;
  const wrapBypass = (bypass: FilterBypass | undefined, body: string[]): string[] => {
    const caps = bypassedPromotedCaps(promotedCaps, bypass);
    if (caps.length === 0) return body;
    needsEntityManager = true;
    return wrapWithFilterBypass(caps, body);
  };
  const retrievalDelegates = retrievals.flatMap((r) => {
    const retrievalBypass = ctx.bypassByRetrieval?.get(r.name);
    const params = r.params
      .map((p) => {
        collectJavaTypeImports(p.type, imports);
        return `${renderJavaType(p.type)} ${p.name}`;
      })
      .join(", ");
    const pagedParams = [params, "Integer offset, Integer limit"].filter(Boolean).join(", ");
    const bareArgs = r.params.map((p) => p.name).join(", ");
    if (ctx.isReified?.(r) && r.criterionRef) {
      // A reified `criterion` retrieval reads via
      // JpaSpecificationExecutor.findAll(spec); the scoped findAll/findById
      // @Query overrides don't apply, so a principal (tenancy) filter is AND-ed
      // in via `<Agg>Criteria.tenantScope(currentUserAccessor.user())`
      // (`tenantScopeAnd`).  The non-reified path below is scoped via `jpqlWhere`.
      imports.add("org.springframework.data.domain.Sort");
      const args = r.criterionRef.args.map((a) => {
        collectJavaExprImports(a, imports);
        return renderJavaExpr(a);
      });
      const spec = `${agg.name}Criteria.${r.criterionRef.name}(${args.join(", ")})${tenantScopeAnd}`;
      return [
        `    @Override`,
        `    public List<${agg.name}> run${upperFirst(r.name)}(${params}) {`,
        ...wrapBypass(retrievalBypass, [
          `        return jpa.findAll(${spec}, ${springSort(r.sort)});`,
        ]),
        `    }`,
        ``,
        `    @Override`,
        `    public List<${agg.name}> run${upperFirst(r.name)}(${pagedParams}) {`,
        ...wrapBypass(retrievalBypass, [
          `        return jpa.findAll(${spec}, new OffsetLimitPageRequest(offset, limit, ${springSort(r.sort)})).getContent();`,
        ]),
        `    }`,
        ``,
      ];
    }
    imports.add("org.springframework.data.domain.Pageable");
    imports.add("org.springframework.data.domain.Sort");
    const jpaArgs = (pageable: string): string => [bareArgs, pageable].filter(Boolean).join(", ");
    return [
      `    @Override`,
      `    public List<${agg.name}> run${upperFirst(r.name)}(${params}) {`,
      ...wrapBypass(retrievalBypass, [
        `        return jpa.run${upperFirst(r.name)}(${jpaArgs("Pageable.unpaged()")});`,
      ]),
      `    }`,
      ``,
      `    @Override`,
      `    public List<${agg.name}> run${upperFirst(r.name)}(${pagedParams}) {`,
      ...wrapBypass(retrievalBypass, [
        `        return jpa.run${upperFirst(r.name)}(${jpaArgs("new OffsetLimitPageRequest(offset, limit, Sort.unsorted())")});`,
      ]),
      `    }`,
      ``,
    ];
  });
  // find_executed (debug) per declared find — the `rows` field is just an
  // integer count, so map every cardinality to a number (paged → total
  // elements, list → size, single nullable → 0/1).  Mirrors the .NET/Hono repo
  // emission so cross-backend consumers see the same event identity + fields.
  const findExecutedLog = (f: FindIR, rowsExpr: string): string =>
    `        CatalogLog.event("find_executed", "debug", "aggregate", "${agg.name}", "find", "${f.name}", "rows", ${rowsExpr});`;
  const delegateLines = finds.flatMap((f) => {
    const sig = findSignature(f, imports);
    const findBypass: FilterBypass = { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps };
    if (isPagedFind(f)) {
      imports.add("org.springframework.data.domain.PageRequest");
      const args = [...f.params.map((p) => p.name), "PageRequest.of(page - 1, pageSize)"].join(
        ", ",
      );
      return [
        `    @Override`,
        `    public ${sig} {`,
        ...wrapBypass(findBypass, [
          `        var result = jpa.${f.name}(${args});`,
          findExecutedLog(f, "result.getTotalElements()"),
          `        return new Paged<>(result.getContent(), page, pageSize, (int) result.getTotalElements(), result.getTotalPages());`,
        ]),
        `    }`,
        ``,
      ];
    }
    const args = f.params.map((p) => p.name).join(", ");
    const rowsExpr = f.returnType.kind === "array" ? "result.size()" : "result == null ? 0 : 1";
    return [
      `    @Override`,
      `    public ${sig} {`,
      ...wrapBypass(findBypass, [
        `        var result = jpa.${f.name}(${args});`,
        findExecutedLog(f, rowsExpr),
        `        return result;`,
      ]),
      `    }`,
      ``,
    ];
  });
  while (delegateLines.length > 0 && delegateLines[delegateLines.length - 1] === "")
    delegateLines.pop();
  // Constructor wiring — `jpa` plus any of: the principal accessor (reified +
  // tenancy), the provenance-records repo, and (§11.6) the EntityManager when a
  // read bypasses a promoted @Filter (the impl unwraps it to a Hibernate Session
  // to disableFilter/enableFilter).
  if (needsEntityManager) imports.add("jakarta.persistence.EntityManager");
  if (needsEntityManager) imports.add("jakarta.persistence.PersistenceContext");
  const ctorParams = [`${agg.name}JpaRepository jpa`];
  const ctorAssigns = [`        this.jpa = jpa;`];
  if (injectAccessor) {
    ctorParams.push("CurrentUserAccessor currentUserAccessor");
    ctorAssigns.push("        this.currentUserAccessor = currentUserAccessor;");
  }
  if (provenance) {
    ctorParams.push("ProvenanceRecordRepository provenanceRecords");
    ctorAssigns.push("        this.provenanceRecords = provenanceRecords;");
  }
  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import org.springframework.stereotype.Repository;`,
    ``,
    `import ${ctx.basePkg}.config.CatalogLog;`,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ctx.domainPkg !== ctx.infraPkg ? `import ${ctx.domainPkg}.${agg.name}Repository;` : null,
    `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;`,
    finds.some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    anyReified && ctx.criteriaPkg && ctx.criteriaPkg !== ctx.infraPkg
      ? `import ${ctx.criteriaPkg}.${agg.name}Criteria;`
      : null,
    injectAccessor ? `import ${ctx.basePkg}.auth.CurrentUserAccessor;` : null,
    provenance ? `import java.time.Instant;` : null,
    provenance ? `import org.springframework.transaction.annotation.Transactional;` : null,
    retrievals.length > 0 && ctx.persistencePkg && ctx.persistencePkg !== ctx.infraPkg
      ? `import ${ctx.persistencePkg}.OffsetLimitPageRequest;`
      : null,
    provenance && ctx.persistencePkg && ctx.persistencePkg !== ctx.infraPkg
      ? `import ${ctx.persistencePkg}.ProvenanceRecord;`
      : null,
    provenance && ctx.persistencePkg && ctx.persistencePkg !== ctx.infraPkg
      ? `import ${ctx.persistencePkg}.ProvenanceRecordRepository;`
      : null,
    provenance ? `import ${ctx.basePkg}.config.RequestContext;` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    `import ${ctx.basePkg}.domain.enums.*;`,
    ``,
    `@Repository`,
    `public class ${agg.name}RepositoryImpl implements ${agg.name}Repository {`,
    `    private final ${agg.name}JpaRepository jpa;`,
    injectAccessor ? `    private final CurrentUserAccessor currentUserAccessor;` : null,
    provenance ? `    private final ProvenanceRecordRepository provenanceRecords;` : null,
    needsEntityManager ? `    @PersistenceContext` : null,
    needsEntityManager ? `    private EntityManager em;` : null,
    ``,
    `    public ${agg.name}RepositoryImpl(${ctorParams.join(", ")}) {`,
    ...ctorAssigns,
    `    }`,
    ``,
    provenance ? `    @Transactional` : null,
    `    @Override`,
    `    public ${agg.name} save(${agg.name} aggregate) {`,
    `        var saved = jpa.save(aggregate);`,
    // Provenance flush (provenance.md): drain the per-write lineage buffer and
    // persist one provenance_records row per write, BEFORE the @Transactional
    // method returns, so the history commits atomically with the state (the
    // Java mirror of the Hono/.NET transactional `drainProv()` insert).
    ...(provenance
      ? [
          `        var __now = Instant.now();`,
          `        var __prov = aggregate.drainProv();`,
          `        for (var __lin : __prov) {`,
          `            provenanceRecords.save(new ProvenanceRecord(`,
          `                java.util.UUID.randomUUID().toString(),`,
          `                __lin.snapshotId(),`,
          `                __lin.target().type(),`,
          `                __lin.target().field(),`,
          `                __lin.inputs(),`,
          `                __lin.computedValue(),`,
          `                __now,`,
          `                RequestContext.correlationId(),`,
          `                RequestContext.scopeId(),`,
          `                RequestContext.actorId(),`,
          `                RequestContext.parentId()));`,
          `        }`,
          `        if (!__prov.isEmpty()) {`,
          `            CatalogLog.event("provenance_recorded", "debug", "aggregate", "${agg.name}", "count", __prov.size());`,
          `        }`,
        ]
      : []),
    // repository_save (debug) — after the save committed; field set mirrors the
    // Hono/.NET emission's (aggregate, id) prefix (children omitted — not
    // cheaply available here).
    `        CatalogLog.event("repository_save", "debug", "aggregate", "${agg.name}", "id", String.valueOf(saved.id().value()));`,
    `        return saved;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Optional<${agg.name}> findById(${idClass} id) {`,
    `        return jpa.findById(id);`,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} getById(${idClass} id) {`,
    // Command load (authorization Phase 3 P3.1): when the aggregate's write
    // scope is narrower than its read scope, load through the write-scoped
    // `findByIdForWrite` @Query — a readable-but-not-writable (or missing) row
    // → 404.  Otherwise the ordinary read-scoped `findById` (byte-identical).
    `        var found = jpa.${agg.writeScopeFilter ? "findByIdForWrite" : "findById"}(id);`,
    // aggregate_loaded (debug) — mirrors the Hono/.NET repo emission; `found` is
    // a bool so a downstream filter can grep failed loads by
    // (event="aggregate_loaded", found=false).
    `        CatalogLog.event("aggregate_loaded", "debug", "aggregate", "${agg.name}", "id", String.valueOf(id.value()), "found", found.isPresent());`,
    `        return found.orElseThrow(() ->`,
    `            new AggregateNotFoundException("${agg.name} " + id + " not found"));`,
    `    }`,
    ``,
    `    @Override`,
    `    public List<${agg.name}> findAll() {`,
    `        return jpa.findAll();`,
    `    }`,
    ``,
    `    @Override`,
    `    public void delete(${agg.name} aggregate) {`,
    `        jpa.delete(aggregate);`,
    `    }`,
    delegateLines.length > 0 ? `` : null,
    ...delegateLines,
    ...(retrievalDelegates.length > 0 ? [``] : []),
    ...retrievalDelegates,
    `}`,
    ``,
  );
}

/** The offset/limit `Pageable` behind the call-site `page:` tuple on
 *  `Repo.run(...)` — Spring's `PageRequest` is page-number based, so an
 *  arbitrary offset needs its own implementation (the analog of .NET's
 *  `ApplyPaging` Skip/Take extension).  Null offset → 0, null limit →
 *  unbounded.  Emitted once per project when any retrieval exists. */
export function renderOffsetLimitPageRequest(pkg: string): string {
  return lines(
    `package ${pkg};`,
    ``,
    `import org.springframework.data.domain.Pageable;`,
    `import org.springframework.data.domain.Sort;`,
    ``,
    `public final class OffsetLimitPageRequest implements Pageable {`,
    `    private final long offset;`,
    `    private final int limit;`,
    `    private final Sort sort;`,
    ``,
    `    public OffsetLimitPageRequest(Integer offset, Integer limit, Sort sort) {`,
    `        this.offset = offset == null ? 0L : offset.longValue();`,
    `        this.limit = limit == null ? Integer.MAX_VALUE : limit;`,
    `        this.sort = sort == null ? Sort.unsorted() : sort;`,
    `    }`,
    ``,
    `    @Override`,
    `    public int getPageNumber() {`,
    `        return limit == 0 ? 0 : (int) (offset / limit);`,
    `    }`,
    ``,
    `    @Override`,
    `    public int getPageSize() {`,
    `        return limit;`,
    `    }`,
    ``,
    `    @Override`,
    `    public long getOffset() {`,
    `        return offset;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Sort getSort() {`,
    `        return sort;`,
    `    }`,
    ``,
    `    @Override`,
    `    public Pageable next() {`,
    `        return new OffsetLimitPageRequest((int) (offset + limit), limit, sort);`,
    `    }`,
    ``,
    `    @Override`,
    `    public Pageable previousOrFirst() {`,
    `        return new OffsetLimitPageRequest((int) Math.max(0L, offset - limit), limit, sort);`,
    `    }`,
    ``,
    `    @Override`,
    `    public Pageable first() {`,
    `        return new OffsetLimitPageRequest(0, limit, sort);`,
    `    }`,
    ``,
    `    @Override`,
    `    public Pageable withPage(int pageNumber) {`,
    `        return new OffsetLimitPageRequest(pageNumber * limit, limit, sort);`,
    `    }`,
    ``,
    `    @Override`,
    `    public boolean hasPrevious() {`,
    `        return offset > 0;`,
    `    }`,
    `}`,
    ``,
  );
}
