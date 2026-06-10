import type {
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
  SortTermIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
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
  const findLines = declaredFinds(repo).map((f) => `    ${findSignature(f, imports)};`);
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
  const finds = declaredFinds(repo);
  const retrievals = ctx.retrievals ?? [];
  const anyReified = retrievals.some((r) => ctx.isReified?.(r));
  if (anyReified) {
    imports.add("org.springframework.data.jpa.repository.JpaSpecificationExecutor");
  }
  const enumsPkg = `${ctx.basePkg}.domain.enums`;
  const methodLines = finds.flatMap((f) => {
    if (f.params.length > 0) imports.add("org.springframework.data.repository.query.Param");
    imports.add("org.springframework.data.jpa.repository.Query");
    const where = f.filter ? ` where ${renderJpqlWhere(f.filter, { alias: "e", enumsPkg })}` : "";
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
      const where = ` where ${renderJpqlWhere(r.where, { alias: "e", enumsPkg })}`;
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
  const allMethodLines = [...methodLines, ...retrievalLines];
  while (allMethodLines.length > 0 && allMethodLines[allMethodLines.length - 1] === "")
    allMethodLines.pop();
  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    ``,
    `public interface ${agg.name}JpaRepository extends JpaRepository<${agg.name}, ${idClass}>${anyReified ? `, JpaSpecificationExecutor<${agg.name}>` : ""} {`,
    ...allMethodLines,
    `}`,
    ``,
  );
}

export function renderJavaRepositoryImpl(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: JavaRepoCtx,
  idClass: string,
): string {
  const imports = new Set<string>(["java.util.List", "java.util.Optional"]);
  const finds = declaredFinds(repo);
  const retrievals = ctx.retrievals ?? [];
  const anyReified = retrievals.some((r) => ctx.isReified?.(r));
  const retrievalDelegates = retrievals.flatMap((r) => {
    const params = r.params
      .map((p) => {
        collectJavaTypeImports(p.type, imports);
        return `${renderJavaType(p.type)} ${p.name}`;
      })
      .join(", ");
    const pagedParams = [params, "Integer offset, Integer limit"].filter(Boolean).join(", ");
    const bareArgs = r.params.map((p) => p.name).join(", ");
    if (ctx.isReified?.(r) && r.criterionRef) {
      imports.add("org.springframework.data.domain.Sort");
      const args = r.criterionRef.args.map((a) => {
        collectJavaExprImports(a, imports);
        return renderJavaExpr(a);
      });
      const spec = `${agg.name}Criteria.${r.criterionRef.name}(${args.join(", ")})`;
      return [
        `    @Override`,
        `    public List<${agg.name}> run${upperFirst(r.name)}(${params}) {`,
        `        return jpa.findAll(${spec}, ${springSort(r.sort)});`,
        `    }`,
        ``,
        `    @Override`,
        `    public List<${agg.name}> run${upperFirst(r.name)}(${pagedParams}) {`,
        `        return jpa.findAll(${spec}, new OffsetLimitPageRequest(offset, limit, ${springSort(r.sort)})).getContent();`,
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
      `        return jpa.run${upperFirst(r.name)}(${jpaArgs("Pageable.unpaged()")});`,
      `    }`,
      ``,
      `    @Override`,
      `    public List<${agg.name}> run${upperFirst(r.name)}(${pagedParams}) {`,
      `        return jpa.run${upperFirst(r.name)}(${jpaArgs("new OffsetLimitPageRequest(offset, limit, Sort.unsorted())")});`,
      `    }`,
      ``,
    ];
  });
  const delegateLines = finds.flatMap((f) => {
    const sig = findSignature(f, imports);
    if (isPagedFind(f)) {
      imports.add("org.springframework.data.domain.PageRequest");
      const args = [...f.params.map((p) => p.name), "PageRequest.of(page - 1, pageSize)"].join(
        ", ",
      );
      return [
        `    @Override`,
        `    public ${sig} {`,
        `        var result = jpa.${f.name}(${args});`,
        `        return new Paged<>(result.getContent(), page, pageSize, (int) result.getTotalElements(), result.getTotalPages());`,
        `    }`,
        ``,
      ];
    }
    const args = f.params.map((p) => p.name).join(", ");
    return [
      `    @Override`,
      `    public ${sig} {`,
      `        return jpa.${f.name}(${args});`,
      `    }`,
      ``,
    ];
  });
  while (delegateLines.length > 0 && delegateLines[delegateLines.length - 1] === "")
    delegateLines.pop();
  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    `import org.springframework.stereotype.Repository;`,
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    ctx.domainPkg !== ctx.infraPkg ? `import ${ctx.domainPkg}.${agg.name}Repository;` : null,
    `import ${ctx.basePkg}.domain.common.AggregateNotFoundException;`,
    finds.some(isPagedFind) ? `import ${ctx.basePkg}.domain.common.Paged;` : null,
    anyReified && ctx.criteriaPkg && ctx.criteriaPkg !== ctx.infraPkg
      ? `import ${ctx.criteriaPkg}.${agg.name}Criteria;`
      : null,
    retrievals.length > 0 && ctx.persistencePkg && ctx.persistencePkg !== ctx.infraPkg
      ? `import ${ctx.persistencePkg}.OffsetLimitPageRequest;`
      : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    ``,
    `@Repository`,
    `public class ${agg.name}RepositoryImpl implements ${agg.name}Repository {`,
    `    private final ${agg.name}JpaRepository jpa;`,
    ``,
    `    public ${agg.name}RepositoryImpl(${agg.name}JpaRepository jpa) {`,
    `        this.jpa = jpa;`,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} save(${agg.name} aggregate) {`,
    `        return jpa.save(aggregate);`,
    `    }`,
    ``,
    `    @Override`,
    `    public Optional<${agg.name}> findById(${idClass} id) {`,
    `        return jpa.findById(id);`,
    `    }`,
    ``,
    `    @Override`,
    `    public ${agg.name} getById(${idClass} id) {`,
    `        return jpa.findById(id).orElseThrow(() ->`,
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
