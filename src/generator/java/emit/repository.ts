import type {
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";
import { boxedJavaType, collectJavaTypeImports, renderJavaType } from "../render-expr.js";
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
  while (methodLines.length > 0 && methodLines[methodLines.length - 1] === "") methodLines.pop();
  return lines(
    `package ${ctx.infraPkg};`,
    ``,
    ...[...imports].sort().map((i) => `import ${i};`),
    ``,
    ctx.entityPkg !== ctx.infraPkg ? `import ${ctx.entityPkg}.${agg.name};` : null,
    `import ${ctx.basePkg}.domain.ids.*;`,
    ``,
    `public interface ${agg.name}JpaRepository extends JpaRepository<${agg.name}, ${idClass}> {`,
    ...methodLines,
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
  const delegateLines = finds.flatMap((f) => {
    const sig = findSignature(f, imports);
    if (isPagedFind(f)) {
      imports.add("org.springframework.data.domain.PageRequest");
      const arg = f.returnType.kind === "genericInstance" ? f.returnType.arg : f.returnType;
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
    `}`,
    ``,
  );
}
