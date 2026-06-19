import type {
  CriterionIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FieldIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { firstNonQueryableNode } from "../../../ir/validate/validate.js";
import { lines } from "../../../util/code-builder.js";
import { renderCriteriaPredicate } from "../render-criteria.js";
import { renderJavaType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Reified criteria → Spring Data `Specification<T>` factories — java is
// the first backend to consume `CriterionIR` directly (java-backend.md's
// headline differentiator).  One `<Agg>Criteria` class per aggregate
// with eligible criteria; each criterion becomes a static factory
// returning a composable Specification (`.and()` / `.or()` /
// `Specification.not()`).  Retrieval `where` clauses that are exactly a
// criterion reference consume these via `JpaSpecificationExecutor`.
//
// Eligibility = the shipped selectability model: an entity candidate
// whose body passes the queryable oracle (`firstNonQueryableNode`) and
// doesn't reference `currentUser` (principal binding inside a
// Specification is the multi-tenancy follow-up).
// ---------------------------------------------------------------------------

export function criterionEligible(
  crit: CriterionIR,
  ctx: EnrichedBoundedContextIR,
): EnrichedAggregateIR | null {
  if (crit.targetType.kind !== "entity") return null;
  const agg = ctx.aggregates.find(
    (a) => crit.targetType.kind === "entity" && a.name === crit.targetType.name,
  );
  if (!agg) return null;
  if (firstNonQueryableNode(crit.body) !== null) return null;
  if (exprUsesCurrentUser(crit.body)) return null;
  return agg;
}

export interface CriteriaFile {
  name: string;
  content: string;
}

/** All `<Agg>Criteria` classes for one context. */
export function renderJavaCriteriaClasses(
  ctx: EnrichedBoundedContextIR,
  voLookup: ReadonlyMap<string, readonly FieldIR[]>,
  pkg: string,
  basePkg: string,
  entityPkgOf: (aggName: string) => string,
): CriteriaFile[] {
  const byAgg = new Map<string, { agg: EnrichedAggregateIR; crits: CriterionIR[] }>();
  for (const crit of ctx.criteria) {
    const agg = criterionEligible(crit, ctx);
    if (!agg) continue;
    const entry = byAgg.get(agg.name) ?? { agg, crits: [] };
    entry.crits.push(crit);
    byAgg.set(agg.name, entry);
  }
  const out: CriteriaFile[] = [];
  for (const { agg, crits } of byAgg.values()) {
    const imports = new Set<string>();
    const factories = crits.flatMap((crit) => {
      const predicate = renderCriteriaPredicate(crit.body, { agg, voLookup, imports });
      const params = crit.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
      return [
        `    /** criterion ${crit.name} of ${agg.name} */`,
        `    public static Specification<${agg.name}> ${crit.name}(${params}) {`,
        `        return (root, query, cb) -> ${predicate};`,
        `    }`,
        ``,
      ];
    });
    // Tenancy scope — a PRINCIPAL capability filter
    // (`this.tenantId == currentUser.tenantId`) is AND-ed into the @Query reads
    // (see emit/repository.ts), but a reified retrieval reads via
    // JpaSpecificationExecutor.findAll(spec), which bypasses those.  Emit a
    // `tenantScope(User)` Specification factory the repository impl ANDs into
    // the reified findAll so it honours the same row scoping.  Takes the actor
    // as a param (the request principal isn't reachable from a static factory);
    // the predicate renders it null-safe (fail-closed).
    const principalFilters = (agg.contextFilters ?? []).filter(exprUsesCurrentUser);
    const tenantScope =
      principalFilters.length > 0
        ? (() => {
            const preds = principalFilters.map((p) =>
              renderCriteriaPredicate(p, { agg, voLookup, imports }),
            );
            const body = preds.length === 1 ? preds[0]! : `cb.and(${preds.join(", ")})`;
            return [
              `    /** Tenancy scope (principal capability filter) — AND-ed into reified`,
              `     *  retrievals so they honour the same row scoping as the @Query reads. */`,
              `    public static Specification<${agg.name}> tenantScope(User currentUser) {`,
              `        return (root, query, cb) -> ${body};`,
              `    }`,
              ``,
            ];
          })()
        : [];
    const allFactories = [...factories, ...tenantScope];
    while (allFactories[allFactories.length - 1] === "") allFactories.pop();
    const entityPkg = entityPkgOf(agg.name);
    out.push({
      name: `${agg.name}Criteria.java`,
      content: lines(
        `package ${pkg};`,
        ``,
        ...[...imports].sort().map((i) => `import ${i};`),
        imports.size > 0 ? `` : null,
        `import org.springframework.data.jpa.domain.Specification;`,
        ``,
        entityPkg !== pkg ? `import ${entityPkg}.${agg.name};` : null,
        tenantScope.length > 0 ? `import ${basePkg}.auth.User;` : null,
        `import ${basePkg}.domain.enums.*;`,
        `import ${basePkg}.domain.ids.*;`,
        `import ${basePkg}.domain.valueobjects.*;`,
        ``,
        `/** Reified criterion specifications for ${agg.name} — composable via`,
        ` *  and()/or()/Specification.not(); consumed by retrieval bundles. */`,
        `public final class ${agg.name}Criteria {`,
        `    private ${agg.name}Criteria() {`,
        `    }`,
        ``,
        ...allFactories,
        `}`,
        ``,
      ),
    });
  }
  return out;
}
