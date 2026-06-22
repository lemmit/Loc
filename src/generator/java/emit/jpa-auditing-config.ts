import type { FieldIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { renderJavaType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// JpaAuditingConfig — the once-per-app Spring Data JPA auditing wiring
// (§5d).  Emitted only when a served context hosts an auditable aggregate
// (a `with auditable` / context `stamp` that references currentUser).
//
//   @EnableJpaAuditing(auditorAwareRef = "auditorProvider")
//   @Bean AuditorAware<UUID> auditorProvider(CurrentUserAccessor accessor)
//       returns () -> Optional.ofNullable(accessor.user()).map(u -> u.id());
//
// The AuditorAware's type parameter is the principal's id scalar (the
// `user { id: ... }` field type — UUID for `guid`), matching the
// @CreatedBy / @LastModifiedBy field types on the entity.  Filled at
// persist/flush time by the AuditingEntityListener.  Depends on
// `spring-boot-starter-data-jpa` (already on the generated classpath).
// ---------------------------------------------------------------------------

/** The principal id field of the system user block — the field named `id`,
 *  else the first declared field (mirrors `auth.ts`'s actorIdField). */
function principalIdField(userFields: readonly FieldIR[]): FieldIR | undefined {
  return userFields.find((f) => f.name === "id") ?? userFields[0];
}

export function renderJpaAuditingConfig(
  basePkg: string,
  userFields: readonly FieldIR[],
  /** True when a stamp references currentUser AND the deployable is authed —
   *  only then is the AuditorAware (+ CurrentUserAccessor dependency) wired.
   *  A purely `now()`-stamped system still gets @EnableJpaAuditing (so
   *  @CreatedDate / @LastModifiedDate fire) but no auditor provider. */
  withAuditor: boolean,
): string {
  const idField = principalIdField(userFields);
  // The principal id scalar (UUID for `guid`); the AuditorAware<T> type
  // parameter matches the @CreatedBy / @LastModifiedBy field types.
  const idType = idField ? renderJavaType(idField.type) : "UUID";
  const idAccessor = idField ? idField.name : "id";
  const needsUuid = withAuditor && idType === "UUID";
  return lines(
    `package ${basePkg}.config;`,
    ``,
    withAuditor ? `import java.util.Optional;` : null,
    needsUuid ? `import java.util.UUID;` : null,
    withAuditor ? `` : null,
    withAuditor ? `import org.springframework.context.annotation.Bean;` : null,
    `import org.springframework.context.annotation.Configuration;`,
    withAuditor ? `import org.springframework.data.domain.AuditorAware;` : null,
    `import org.springframework.data.jpa.repository.config.EnableJpaAuditing;`,
    withAuditor ? `` : null,
    withAuditor ? `import ${basePkg}.auth.CurrentUserAccessor;` : null,
    ``,
    `/** Spring Data JPA auditing wiring (§5d).  @CreatedDate / @LastModifiedDate`,
    withAuditor
      ? ` *  fill from the framework clock; @CreatedBy / @LastModifiedBy resolve`
      : ` *  fill from the framework clock. */`,
    ...(withAuditor
      ? [` *  through the auditor provider over the request-scoped principal. */`]
      : []),
    `@Configuration`,
    withAuditor ? `@EnableJpaAuditing(auditorAwareRef = "auditorProvider")` : `@EnableJpaAuditing`,
    `public class JpaAuditingConfig {`,
    ...(withAuditor
      ? [
          `    @Bean`,
          `    public AuditorAware<${idType}> auditorProvider(CurrentUserAccessor accessor) {`,
          `        return () -> Optional.ofNullable(accessor.user()).map(u -> u.${idAccessor}());`,
          `    }`,
        ]
      : []),
    `}`,
    ``,
  );
}
