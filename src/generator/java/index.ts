import { enrichLoomModel } from "../../ir/enrich/enrichments.js";
import { forCreateInput } from "../../ir/enrich/wire-projection.js";
import { lowerModel } from "../../ir/lower/lower.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type {
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { directParentOf } from "../../ir/util/containment-parent.js";
import { isTpcBase, isTphBase, tableOwnerName } from "../../ir/util/inheritance.js";
import {
  aggregateIsEventSourced,
  effectiveSavingShape,
  resolveContextSchema,
  resolveDataSourceConfig,
} from "../../ir/util/resolve-datasource.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import type { Model } from "../../language/generated/ast.js";
import { API_BASE_PATH } from "../../util/api-base.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import type { EmitCtx, LayoutAdapter, StyleAdapter } from "../_adapters/index.js";
import { unionMembers } from "../_payload/union-wire.js";
import { generateReactForContexts } from "../react/index.js";
import { generateSvelteForContexts } from "../svelte/index.js";
import { generateVueForContexts } from "../vue/index.js";
import { byFeatureLayoutAdapter } from "./adapters/by-feature-layout.js";
import type {
  JavaArtifact,
  JavaArtifactCategory,
  JavaLayoutAdapter,
} from "./adapters/by-layer-layout.js";
import { emitJavaResourceFiles } from "./adapters/resource-clients.js";
import { inlineRunBypassesByRetrieval, promotedCapabilities } from "./capability-filter.js";
import { renderApiExceptionAdvice, renderJavaController } from "./emit/api.js";
import {
  contextsHaveAudit,
  emitJavaAuditMigration,
  renderAuditRecordEntity,
  renderAuditRecordRepository,
} from "./emit/audit.js";
import { renderAuthFiles } from "./emit/auth.js";
import {
  renderAggregateNotFoundException,
  renderAuditableInterface,
  renderDisallowedException,
  renderDomainEventInterface,
  renderDomainException,
  renderExternHandlerException,
  renderForbiddenException,
  renderPackageMarker,
  renderPagedRecord,
  renderWireValidationException,
} from "./emit/common.js";
import { criterionEligible, renderJavaCriteriaClasses } from "./emit/criteria.js";
import { renderJavaDispatcher } from "./emit/dispatch.js";
import { renderJavaDocumentRepositoryImpl } from "./emit/document-store.js";
import { renderJavaDomainServices } from "./emit/domain-service.js";
import { renderDtoFiles } from "./emit/dto.js";
import { renderJavaAbstractBaseEntity, renderJavaEntity } from "./emit/entity.js";
import { renderJavaEnum, renderJavaValueObject } from "./emit/enums-vos.js";
import { renderJavaEventSourcedRepositoryImpl } from "./emit/event-store.js";
import { renderJavaEvent } from "./emit/events.js";
import { renderExternHandlerInterface, renderExternHandlerStub } from "./emit/extern.js";
import { renderJavaId } from "./emit/ids.js";
import { renderJpaAuditingConfig } from "./emit/jpa-auditing-config.js";
import { emitJavaMigrations } from "./emit/migrations.js";
import {
  renderCatalogLogger,
  renderLifecycleCatalog,
  renderMigrationCatalogCallback,
  renderRequestCatalogFilter,
} from "./emit/observability.js";
import {
  buildJavaOpenApiContract,
  renderJavaOpenApiCustomizer,
} from "./emit/openapi-customizer.js";
import {
  renderApplication,
  renderApplicationYml,
  renderDockerfile,
  renderDockerignore,
  renderGradleBuild,
  renderGradleSettings,
  renderHealthController,
  renderJsonFormatMapperConfig,
  renderSpaWebConfig,
} from "./emit/program.js";
import {
  contextsHaveProvenance,
  emitJavaProvenanceMigration,
  provenancedFieldsOf,
  renderProvenanceRecordEntity,
  renderProvenanceRecordRepository,
  renderProvInput,
  renderProvLineage,
  renderProvLineageRecord,
} from "./emit/provenance.js";
import {
  type JavaRepoCtx,
  renderJavaRepositoryImpl,
  renderJavaRepositoryInterface,
  renderJavaSpringDataRepository,
  renderOffsetLimitPageRequest,
} from "./emit/repository.js";
import { renderExecutionContextFilter, renderRequestContext } from "./emit/request-context.js";
import { renderJavaSeedRunner } from "./emit/seed.js";
import { renderJavaService } from "./emit/service.js";
import { renderJavaTestsFile } from "./emit/tests.js";
import {
  aggregateReturnUnions,
  renderJavaDomainUnionFiles,
  renderJavaUnionWireFiles,
} from "./emit/unions.js";
import { renderJavaValidators } from "./emit/validator.js";
import { renderJavaViews, viewFindsFor } from "./emit/view.js";
import { referencedValueObjects } from "./emit/wire.js";
import { renderJavaWorkflows } from "./emit/workflow.js";
import {
  esWorkflowStateClass,
  eventSourcedWorkflows,
  renderEsWorkflowFoldClass,
} from "./emit/workflow-eventsourced.js";
import { renderJavaWorkflowInstanceReads } from "./emit/workflow-instances.js";
import {
  correlationWorkflows,
  renderWorkflowStateEntity,
  renderWorkflowStateRepository,
  workflowStateClass,
} from "./emit/workflow-state.js";
import { basePackageFor, javaPackageSegment, mainSourcePath } from "./naming.js";

// ---------------------------------------------------------------------------
// Java backend entry point — Spring Boot 3 / Spring Data JPA / Postgres.
//
// `generateJavaForContexts(...)` returns a Map of relative paths → file
// contents for one deployable's Gradle project:
//
//   build.gradle.kts, settings.gradle.kts    — Gradle (Kotlin DSL) shell
//   src/main/java/<base>/Application.java    — @SpringBootApplication entry
//   src/main/java/<base>/api/...             — controllers (+ health/ready)
//   src/main/java/<base>/domain/...          — ids, enums, VOs, events,
//                                              aggregates + parts
//   src/main/java/<base>/infrastructure/...  — JPA repositories, persistence
//   src/main/resources/application.yml       — config (datasource via env)
//   src/main/resources/db/migration/         — Flyway-style versioned SQL
//   Dockerfile, .dockerignore                — multi-stage Gradle build
//
// `<base>` is `com.loom.<deployable>` (see naming.ts).  Per-aggregate file
// placement routes through the deployable's resolved layout adapter
// (byFeature default / byLayer), which owns BOTH the package and the path
// so they can't drift.  See docs/plans/java-backend-implementation.md.
// ---------------------------------------------------------------------------

interface SystemArgs {
  deployable: DeployableIR;
  sys: SystemIR;
  migrations?: MigrationsIR[];
  styleAdapter?: StyleAdapter;
  layoutAdapter?: LayoutAdapter;
}

/**
 * Legacy / test entry: lowers the whole model and emits one project per
 * top-level bounded context (mirrors `generateDotnet`).
 */
export function generateJava(
  model: Model,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  const loom = enrichLoomModel(lowerModel(model));
  const out = new Map<string, string>();
  for (const ctx of loom.contexts) {
    emitProjectFromContexts([ctx], ctx.name, out, undefined, !!options.emitTrace);
  }
  return out;
}

/**
 * System-mode entry: emits a single Gradle project from a pre-filtered
 * list of contexts under the deployable's name (`ns`).
 */
export function generateJavaForContexts(
  contexts: EnrichedBoundedContextIR[],
  ns: string,
  system?: SystemArgs,
  options: { emitTrace?: boolean } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  emitProjectFromContexts(contexts, ns, out, system, !!options.emitTrace);
  return out;
}

function emitProjectFromContexts(
  contexts: EnrichedBoundedContextIR[],
  ns: string,
  out: Map<string, string>,
  system?: SystemArgs,
  emitTrace = false,
): void {
  const basePkg = basePackageFor(ns);
  const slug = javaPackageSegment(ns);

  // Layout routing (D-REALIZATION-AXES `directoryLayout:`): the resolved
  // adapter when the system orchestrator threaded one in; the platform
  // default (byFeature) otherwise.  Java layout adapters own packageFor
  // alongside pathFor, so emitters resolve `package …;` through the same
  // object that routes the file.
  const layout = (system?.layoutAdapter as JavaLayoutAdapter | undefined) ?? byFeatureLayoutAdapter;
  const emitCtx: EmitCtx = system
    ? {
        deployable: system.deployable,
        contexts,
        sys: system.sys,
        migrations: system.migrations,
        emitTrace,
        styleAdapter: system.styleAdapter,
        layoutAdapter: system.layoutAdapter,
      }
    : ({ deployable: { name: ns } } as EmitCtx);
  const place = (
    name: string,
    category: JavaArtifactCategory,
    content: string,
    aggregateName?: string,
  ): void => {
    const artifact = { name, content, category, aggregateName } as JavaArtifact;
    out.set(layout.pathFor(artifact, emitCtx), content);
  };
  const pkgFor = (category: JavaArtifactCategory, aggregateName?: string): string =>
    layout.packageFor(category, basePkg, aggregateName);

  const authRequired = !!(system?.deployable.auth?.required && system.sys.user);
  // OIDC turnkey auth (D-AUTH-OIDC): the generated verifier + handshake +
  // Nimbus dep land only when an `auth { oidc }` block targets this
  // (auth: required) deployable.
  const oidc = authRequired && !!system?.sys.auth;
  // Resource client classes (objectStore / queue / api) + their Gradle
  // deps (Phase 4c) — empty when the deployable wires no consumable
  // resources, leaving build.gradle.kts byte-identical.
  const resourceEmission = emitJavaResourceFiles(
    system?.sys,
    new Set(system?.deployable.dataSourceNames ?? []),
    pkgFor("resource-client"),
  );
  for (const [name, content] of resourceEmission.files) {
    place(name, "resource-client", content);
  }
  // Fullstack mode (`ui:` on a java deployable): the SPA owns the
  // un-prefixed route space; controllers move under /api (the .NET
  // embedded-SPA shape).
  const hasEmbeddedSpa = !!system?.deployable.uiName;
  // Domain controllers always live under `/api/*` (the shared API base
  // path); `hasEmbeddedSpa` separately drives SPA static-file embedding.
  const routePrefix = API_BASE_PATH;

  // Shared domain types + the package markers that keep the entity files'
  // wildcard imports valid even when a package would otherwise be empty.
  place("DomainException.java", "domain-common", renderDomainException(basePkg));
  place("ForbiddenException.java", "domain-common", renderForbiddenException(basePkg));
  place("DisallowedException.java", "domain-common", renderDisallowedException(basePkg));
  place(
    "AggregateNotFoundException.java",
    "domain-common",
    renderAggregateNotFoundException(basePkg),
  );
  place("WireValidationException.java", "domain-common", renderWireValidationException(basePkg));
  place("ExternHandlerException.java", "domain-common", renderExternHandlerException(basePkg));
  place("Paged.java", "domain-common", renderPagedRecord(basePkg));
  place("DomainEvent.java", "event", renderDomainEventInterface(basePkg));
  place("_Namespace.java", "enum", renderPackageMarker(pkgFor("enum")));
  place("_Namespace.java", "valueobject", renderPackageMarker(pkgFor("valueobject")));
  place("_Namespace.java", "id", renderPackageMarker(pkgFor("id")));
  // 23505 → 409 arm is emitted only when some aggregate declares a `unique (...)`
  // key, so a unique-free project's advice stays byte-identical (strict additivity).
  const hasUniqueKeys = contexts.some((c) =>
    c.aggregates.some((a) => (a.uniqueKeys?.length ?? 0) > 0),
  );
  // The optimistic-lock → 409 arm is emitted when some aggregate is `versioned`
  // OR event-sourced: the `versioned` service raises
  // ObjectOptimisticLockingFailureException on a stale write, and an
  // event-sourced append rethrows the SAME exception on a `(stream_id, version)`
  // 23505 collision.  A project with neither stays byte-identical.
  const hasConcurrency = contexts.some((c) =>
    c.aggregates.some((a) => aggregateIsVersioned(a) || aggregateIsEventSourced(a)),
  );
  place(
    "ApiExceptionAdvice.java",
    "api-common",
    renderApiExceptionAdvice(basePkg, hasUniqueKeys, hasConcurrency),
  );
  // Observability catalog — always-on, like dotnet's request log +
  // Hono's pino lines (the obs e2e suites assert this envelope).
  place("CatalogLog.java", "config", renderCatalogLogger(basePkg));
  place("LifecycleCatalog.java", "config", renderLifecycleCatalog(basePkg));
  place("RequestCatalogFilter.java", "config", renderRequestCatalogFilter(basePkg));
  // Ambient execution-context carrier (correlation_id / scope_id / actor_id in
  // MDC) — always-on, the cross-backend RequestContext (docs/architecture/
  // request-context.md).  The principal's actor_id is stamped by UserFilter.
  place("RequestContext.java", "config", renderRequestContext(basePkg));
  place("ExecutionContextFilter.java", "config", renderExecutionContextFilter(basePkg));

  // Provenance runtime (provenance.md) — the shared lineage SDK + the
  // append-only history table.  Emitted only when a context declares a
  // `provenanced` field (gated on the field, not a backend allowlist).  The
  // co-located column + per-write capture + flush are wired per aggregate
  // (entity.ts / render-stmt.ts / repository.ts); the late migration lands in
  // the migrations block below.  The lineage records ride a jsonb column, so
  // the Hibernate JSON FormatMapper config is forced on too.
  const hasProvenance = contextsHaveProvenance(contexts);
  if (hasProvenance) {
    place("ProvTarget.java", "domain-common", renderProvLineage(basePkg));
    place("ProvInput.java", "domain-common", renderProvInput(basePkg));
    place("ProvLineage.java", "domain-common", renderProvLineageRecord(basePkg));
    place("ProvenanceRecord.java", "infra-persistence", renderProvenanceRecordEntity(basePkg));
    place(
      "ProvenanceRecordRepository.java",
      "infra-persistence",
      renderProvenanceRecordRepository(basePkg),
    );
    place("LoomJsonFormatMapperConfig.java", "config", renderJsonFormatMapperConfig(basePkg));
  }

  // Per-operation audit runtime (audit-and-logging.md) — the append-only
  // `audit_records` JPA entity + its Spring Data port.  Emitted only when a
  // served context declares an `audited` public operation (gated on the op,
  // not a backend allowlist).  The per-op capture + the AuditRecord persist
  // are wired by service.ts; the late DDL lands in the migrations block below.
  // The actor / before / after blobs ride jsonb columns, so the Hibernate JSON
  // FormatMapper config is forced on too (idempotent with provenance).
  const hasAudit = contextsHaveAudit(contexts);
  if (hasAudit) {
    place("AuditRecord.java", "infra-persistence", renderAuditRecordEntity(basePkg));
    place("AuditRecordRepository.java", "infra-persistence", renderAuditRecordRepository(basePkg));
    if (!hasProvenance) {
      place("LoomJsonFormatMapperConfig.java", "config", renderJsonFormatMapperConfig(basePkg));
    }
  }

  // Lifecycle-stamp auditing (capability-stamp-dedup-simulation.md §5): any
  // aggregate carrying `contextStamps` (`with auditable` / a context `stamp`)
  // is auditable — its stamp fields are filled at persist time by the Spring
  // Data AuditingEntityListener, so once per app we emit the pure `Auditable`
  // marker interface (§5a) and the `JpaAuditingConfig` (§5d: @EnableJpaAuditing
  // + an AuditorAware<UUID> over the request-scoped principal for the
  // @CreatedBy / @LastModifiedBy fields).  The auditor provider is wired only
  // when a stamp references currentUser AND the deployable is authed (else
  // CurrentUserAccessor doesn't exist); a purely `now()`-stamped system still
  // gets @EnableJpaAuditing so @CreatedDate / @LastModifiedDate fire.
  const auditableAggregates = contexts.flatMap((c) =>
    c.aggregates.filter((a) => (a.contextStamps ?? []).length > 0),
  );
  const hasAuditable = auditableAggregates.length > 0;
  if (hasAuditable) {
    place("Auditable.java", "domain-common", renderAuditableInterface(basePkg));
    const stampsUsePrincipal = auditableAggregates.some((a) =>
      (a.contextStamps ?? []).some((r) => r.assignments.some((x) => exprUsesCurrentUser(x.value))),
    );
    place(
      "JpaAuditingConfig.java",
      "config",
      renderJpaAuditingConfig(
        basePkg,
        system?.sys.user?.fields ?? [],
        stampsUsePrincipal && authRequired,
      ),
    );
  }

  for (const ctx of contexts) {
    // This context's Postgres schema — the workflow saga tables (JPA `@Table`
    // + native-SQL ES stream) land here to match the migration DDL.
    const ctxSchema = system?.sys ? resolveContextSchema(ctx, system.sys) : undefined;
    // Ids — an abstract TPC base keeps no identity (each concrete owns a
    // typed id); a TPH base owns the shared single-table key.
    for (const agg of ctx.aggregates) {
      if (agg.isAbstract && !isTphBase(agg, ctx.aggregates)) continue;
      place(`${agg.name}Id.java`, "id", renderJavaId(agg.name, agg.idValueType, basePkg));
      for (const part of agg.parts) {
        place(`${part.name}Id.java`, "id", renderJavaId(part.name, agg.idValueType, basePkg));
      }
    }
    for (const e of ctx.enums) {
      place(`${e.name}.java`, "enum", renderJavaEnum(e, basePkg));
    }
    for (const vo of ctx.valueObjects) {
      place(`${vo.name}.java`, "valueobject", renderJavaValueObject(vo, basePkg));
    }
    for (const ev of ctx.events) {
      place(`${ev.name}.java`, "event", renderJavaEvent(ev, basePkg));
    }
    for (const agg of ctx.aggregates) {
      emitAggregate(
        agg,
        ctx,
        basePkg,
        place,
        pkgFor,
        emitTrace,
        system?.sys,
        authRequired,
        routePrefix,
      );
    }
    // Workflows + views — per-context controllers under /workflows and
    // /views, services in the shared application packages.
    //
    // VO → application-package map: a `<Vo>Request` record is emitted into
    // the service package of every aggregate that references the VO (see
    // `emitAggregate` → `renderDtoFiles`).  A VO-typed workflow param needs
    // that record imported, so map each referenced VO to one such package
    // (any works — the record content is identical across aggregates).
    const voRequestPkg = new Map<string, string>();
    for (const agg of ctx.aggregates) {
      const voNames = new Set<string>();
      referencedValueObjects(
        forCreateInput(agg.fields).map((f) => f.type),
        voNames,
      );
      for (const op of agg.operations) {
        referencedValueObjects(
          op.params.map((p) => p.type),
          voNames,
        );
      }
      for (const vo of voNames) {
        if (!voRequestPkg.has(vo)) voRequestPkg.set(vo, pkgFor("service", agg.name));
      }
    }
    const workflowFiles = renderJavaWorkflows(
      ctx,
      {
        basePkg,
        pkg: pkgFor("workflow-service"),
        routePrefix,
        resourceClasses: resourceEmission.classes,
        resourcesPkg: pkgFor("resource-client"),
        entityPkgOf: (a) => pkgFor("entity", a),
        repoPkgOf: (a) => pkgFor("repository-interface", a),
        domainServicePkg: pkgFor("domain-service"),
        voRequestPkgOf: (vo) => voRequestPkg.get(vo) ?? null,
      },
      authRequired,
      system?.sys,
    );
    if (workflowFiles) {
      for (const [name, f] of workflowFiles) {
        place(name, f.category === "controller" ? "api-common" : "workflow-service", f.content);
      }
    }
    // Saga-state persistence (workflow-debt-backend-parity.md, Java saga slice
    // 1): a correlation-bearing workflow gets a JPA `@Entity` bound to the
    // Flyway-owned saga table + a Spring Data repository over it — the
    // foundation the in-process dispatcher and instance reads build on.
    for (const wf of correlationWorkflows(ctx.workflows)) {
      // An `eventSourced` workflow persists as an append-only `<wf>_events`
      // stream (the saga analogue of a `persistedAs(eventLog)` aggregate), not a
      // mutable JPA state row — emit the in-memory fold class instead, into the
      // dispatcher's package so the handler body reaches its package-private
      // state fields (workflow-and-applier.md A2-S5b).
      if (wf.eventSourced) continue;
      place(
        `${workflowStateClass(wf)}.java`,
        "infra-persistence",
        renderWorkflowStateEntity(wf, ctx, basePkg, pkgFor("infra-persistence"), ctxSchema),
      );
      place(
        `${workflowStateClass(wf)}Repository.java`,
        "spring-data-repository",
        renderWorkflowStateRepository(
          wf,
          basePkg,
          pkgFor("spring-data-repository"),
          pkgFor("infra-persistence"),
        ),
      );
    }
    for (const wf of eventSourcedWorkflows(ctx.workflows)) {
      place(
        `${esWorkflowStateClass(wf)}.java`,
        "workflow-service",
        renderEsWorkflowFoldClass(wf, ctx, basePkg, pkgFor("workflow-service")),
      );
    }
    // In-process saga dispatcher (workflow-debt-backend-parity.md, Java saga
    // slice 2): a @Component whose @EventListener handlers react to
    // channel-carried events — load-or-allocate / route-or-drop the saga row,
    // run the handler body, re-publish so choreography chains re-enter.
    const dispatcher = renderJavaDispatcher(ctx, {
      basePkg,
      pkg: pkgFor("workflow-service"),
      entityPkgOf: (a) => pkgFor("entity", a),
      repoPkgOf: (a) => pkgFor("repository-interface", a),
      statePkg: pkgFor("infra-persistence"),
      stateRepoPkg: pkgFor("spring-data-repository"),
      contextSchema: ctxSchema,
    });
    if (dispatcher) place(dispatcher.name, "workflow-service", dispatcher.content);
    // Read-only instance endpoints (workflow-debt-backend-parity.md, Java saga
    // slice 3): every observable (correlation-bearing) saga gets
    // GET /workflows/<wf>/instances[/{id}] over its persisted state row.
    const instanceReads = renderJavaWorkflowInstanceReads(ctx, {
      basePkg,
      pkg: pkgFor("workflow-service"),
      routePrefix,
      stateRepoPkg: pkgFor("spring-data-repository"),
      contextSchema: ctxSchema,
    });
    if (instanceReads) {
      for (const [name, f] of instanceReads) place(name, f.category, f.content);
    }
    const viewFiles = renderJavaViews(ctx, {
      basePkg,
      pkg: pkgFor("view-service"),
      routePrefix,
      applicationPkgOf: (a) => pkgFor("service", a),
      entityPkgOf: (a) => pkgFor("entity", a),
      repoPkgOf: (a) => pkgFor("repository-interface", a),
      stateRepoPkg: pkgFor("spring-data-repository"),
      workflowPkg: pkgFor("workflow-service"),
      contextSchema: ctxSchema,
    });
    if (viewFiles) {
      for (const [name, f] of viewFiles) place(name, f.category, f.content);
    }
    // Reified criteria → Specification<T> factories (java consumes the
    // CriterionIR directly — the proposal's headline differentiator).
    const voLookupCtx = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
    for (const file of renderJavaCriteriaClasses(
      ctx,
      voLookupCtx,
      pkgFor("criteria"),
      basePkg,
      (a) => pkgFor("entity", a),
    )) {
      place(file.name, "criteria", file.content);
    }
    // Stateless pure-calculator domain services → a `public final class`
    // of `public static` methods in `<base>.domain.services` (the
    // `<Agg>Criteria` envelope); `or`-union returns reuse the shipped
    // exception-less sealed-union machinery.
    for (const file of renderJavaDomainServices(
      ctx,
      pkgFor("domain-service"),
      basePkg,
      (a) => pkgFor("entity", a),
      (a) => pkgFor("repository-interface", a),
    )) {
      place(file.name, "domain-service", file.content);
    }
    // Offset/limit Pageable behind the call-site `page:` on `Repo.run`.
    if ((ctx.retrievals ?? []).length > 0) {
      place(
        "OffsetLimitPageRequest.java",
        "infra-persistence",
        renderOffsetLimitPageRequest(pkgFor("infra-persistence")),
      );
    }
    // `shape(embedded)` anywhere → the field-visibility Hibernate JSON
    // FormatMapper (once per project; the second place() is a no-op).
    if (
      ctx.aggregates.some(
        (a) =>
          effectiveSavingShape(
            a,
            system?.sys ? resolveDataSourceConfig(a, ctx, system.sys) : undefined,
          ) === "embedded" && a.persistedAs !== "eventLog",
      )
    ) {
      place("LoomJsonFormatMapperConfig.java", "config", renderJsonFormatMapperConfig(basePkg));
    }
    // First-boot seed datasets → an ApplicationRunner per seeded context.
    const seedRunner = renderJavaSeedRunner(ctx, {
      basePkg,
      pkg: pkgFor("infra-persistence"),
      entityPkgOf: (a) => pkgFor("entity", a),
      repoPkgOf: (a) => pkgFor("repository-interface", a),
      schemaOf: (a) => {
        const agg = ctx.aggregates.find((x) => x.name === a);
        return agg && system?.sys
          ? resolveDataSourceConfig(agg, ctx, system.sys)?.schema
          : undefined;
      },
    });
    if (seedRunner) place(`${ctx.name}SeedRunner.java`, "infra-persistence", seedRunner);
  }

  // Auth surface — only when the deployable opts in via auth: required
  // and the system declares a user block.
  if (authRequired && system?.sys) {
    for (const [name, content] of renderAuthFiles(system.sys, basePkg, routePrefix)) {
      out.set(mainSourcePath(`${basePkg}.auth`, name), content);
    }
  }

  // Per-module Flyway migrations — empty (non-system entry points) → no-op.
  // The flyway deps stay as long as ANY migration history exists (a regen
  // with an unchanged schema emits no new steps, but the previously
  // emitted V*.sql files still need Flyway to run).
  const allMigrations = system?.migrations ?? [];
  emitJavaMigrations(allMigrations, out);
  // Provenance DDL (provenance.md) ships as one extra late Flyway migration
  // sorting after every module migration (the aggregate tables must exist for
  // the co-located-column ALTERs).  Feature-local — not part of MigrationsIR.
  // Gated on a `provenanced` field, not a backend allowlist.
  emitJavaProvenanceMigration(contexts, system?.sys, out);
  // Per-operation audit DDL (audit-and-logging.md): one extra late Flyway
  // migration creating `audit_records`, sorting after every module migration.
  // Feature-local — not part of MigrationsIR.  Gated on an `audited` op.
  emitJavaAuditMigration(contexts, out);
  const hasMigrations =
    allMigrations.some((m) => m.steps.length > 0 || m.baseline !== null) ||
    hasProvenance ||
    hasAudit;

  // Migration-lifecycle catalog (observability.md) — hangs a Flyway Callback
  // off the in-process boot run so migrations_starting / migration_applied /
  // migrations_complete / migration_failed surface through CatalogLog, sharing
  // the cross-backend envelope.  Emitted only when the project ships migrations
  // (Flyway is wired) — otherwise the FlywayConfigurationCustomizer bean would
  // reference an auto-config type that isn't on the classpath.
  if (hasMigrations) {
    place("MigrationCatalogConfig.java", "config", renderMigrationCatalogCallback(basePkg));
  }

  // Project shell — stable from S1 on.
  out.set(
    "build.gradle.kts",
    renderGradleBuild({ flyway: hasMigrations, oidc, extraDeps: resourceEmission.deps }),
  );
  out.set("settings.gradle.kts", renderGradleSettings(slug));
  out.set("src/main/resources/application.yml", renderApplicationYml(slug));
  out.set(mainSourcePath(basePkg, "Application.java"), renderApplication(basePkg));
  out.set(
    mainSourcePath(`${basePkg}.api`, "HealthController.java"),
    renderHealthController(basePkg),
  );
  // springdoc OpenApiCustomizer — align the emitted /openapi.json with the
  // other backends' contract (success bodies under application/json + named
  // <Agg>ListResponse array wrappers; RFC 7807 ProblemDetails error responses
  // under application/problem+json).  Skipped when there's no API surface.
  const openApiContract = buildJavaOpenApiContract(contexts, routePrefix);
  const openApiCustomizer = renderJavaOpenApiCustomizer(basePkg, openApiContract);
  if (openApiCustomizer) {
    place("OpenApiContractCustomizer.java", "config", openApiCustomizer);
  }
  // SvelteKit's adapter-static writes `build/`; Vite SPAs write `dist/`.
  const spaOutDir = system?.deployable.uiFramework === "svelte" ? "build" : "dist";
  out.set("Dockerfile", renderDockerfile({ embeddedSpa: hasEmbeddedSpa, spaOutDir }));
  // Proxy-CA escape hatch (see renderDockerfile) — always present so the
  // Dockerfile's `COPY certs/` never fails and CA injection has a target.
  out.set("certs/.gitkeep", "");
  out.set(".dockerignore", renderDockerignore({ embeddedSpa: hasEmbeddedSpa, spaOutDir }));
  // Proxy-CA escape hatch (see the Dockerfile's COPY certs/) — mirrors
  // every other backend so the dir always exists for the docker build.
  out.set("certs/.gitkeep", "");

  // Fullstack: the same-origin SPA host (resource handler + index.html
  // fallback) and the embedded React project under ClientApp/.
  if (hasEmbeddedSpa && system) {
    out.set(mainSourcePath(`${basePkg}.config`, "SpaWebConfig.java"), renderSpaWebConfig(basePkg));
    // Dispatch on the hosted ui's framework — every static-bundle
    // frontend (react / svelte / vue) embeds under ClientApp/; only the
    // SPA build output dir differs (svelte `build/`, vite `dist/` — see
    // renderDockerfile's spaOutDir).
    const uiFw = system.deployable.uiFramework;
    const spaFiles =
      uiFw === "svelte"
        ? generateSvelteForContexts(contexts, system.sys, system.deployable, {
            apiBaseUrl: "/api",
            pathPrefix: "ClientApp/",
          })
        : uiFw === "vue"
          ? generateVueForContexts(contexts, system.sys, system.deployable, {
              apiBaseUrl: "/api",
              pathPrefix: "ClientApp/",
            })
          : generateReactForContexts(contexts, system.sys, system.deployable, {
              apiBaseUrl: "/api",
              pathPrefix: "ClientApp/",
            });
    for (const [path, content] of spaFiles) {
      // The React generator also ships project-root files (Dockerfile,
      // .dockerignore, certs, e2e) — the java project owns those
      // surfaces in fullstack mode (the multi-stage Dockerfile builds
      // the SPA), so skip them.
      if (
        path === "ClientApp/Dockerfile" ||
        path === "ClientApp/.dockerignore" ||
        path === "ClientApp/certs/.gitkeep" ||
        path.startsWith("ClientApp/e2e/")
      )
        continue;
      out.set(path, content);
    }
    out.set(
      "ClientApp/.gitignore",
      uiFw === "svelte" ? "node_modules\nbuild\n.svelte-kit\n" : "node_modules\ndist\n",
    );
  }
}

function emitAggregate(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  basePkg: string,
  place: (
    name: string,
    category: JavaArtifactCategory,
    content: string,
    aggregateName?: string,
  ) => void,
  pkgFor: (category: JavaArtifactCategory, aggregateName?: string) => string,
  emitTrace: boolean,
  sys?: SystemIR,
  authRequired = false,
  routePrefix?: string,
): void {
  const eventFields = new Map(ctx.events.map((e) => [e.name, e.fields.map((f) => f.name)]));
  // The JPA mapping mirrors `schemaFromModule`: binding-resolved schema +
  // flattened-VO column names (voLookup covers ambient VOs — enrichment
  // folds them into every context).
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  const schema = sys ? resolveDataSourceConfig(agg, ctx, sys)?.schema : undefined;
  // Effective saving shape (D-DOCUMENT-AXIS): document aggregates are
  // plain domain classes round-tripping one jsonb column.
  const shape = effectiveSavingShape(agg, sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined);
  const isDocument = shape === "document" && agg.persistedAs !== "eventLog";
  const isEmbedded = shape === "embedded" && agg.persistedAs !== "eventLog";
  // §11.6 triage: the non-principal capabilities some read of `agg` `ignoring`s.
  // These leave the always-on @SQLRestriction (which is unbypassable by design)
  // for a bypassable Hibernate named @Filter on the entity; the repository impl
  // wraps a bypassing read with disableFilter/enableFilter.  Derived per
  // aggregate from the context's read-decls — never stamped (capability-filter.ts).
  const promotedCaps = new Set(promotedCapabilities(agg, ctx));

  // Abstract bases: TPC (`ownTable`) emits a @MappedSuperclass (columns
  // flatten into each concrete's table); a TPH (`sharedTable`) base owns
  // the hierarchy's table — its mapping lands with the inheritance slice.
  if (agg.isAbstract) {
    place(
      `${agg.name}.java`,
      "entity",
      renderJavaAbstractBaseEntity(agg, basePkg, pkgFor("entity", agg.name), {
        tph: isTphBase(agg, ctx.aggregates),
        persistence: { schema, voLookup },
      }),
      agg.name,
    );
    return;
  }

  const tpcBase = agg.extendsAggregate
    ? ctx.aggregates.find((a) => a.name === agg.extendsAggregate && isTpcBase(a, ctx.aggregates))
    : undefined;
  const tphBase = agg.extendsAggregate
    ? ctx.aggregates.find((a) => a.name === agg.extendsAggregate && isTphBase(a, ctx.aggregates))
    : undefined;
  const inheritedBase = tpcBase ?? tphBase;
  const superType = inheritedBase
    ? {
        name: inheritedBase.name,
        fieldNames: new Set(inheritedBase.fields.map((f) => f.name)),
        derivedNames: new Set(inheritedBase.derived.map((d) => d.name)),
        sharesIdentity: !!tphBase,
        idValueType: tphBase?.idValueType,
        pkg: pkgFor("entity", inheritedBase.name),
      }
    : undefined;

  // Exception-less operation returns: opName → domain union + member
  // order, so tagged returns construct the right variant record.
  const operationReturnUnions = new Map<
    string,
    { name: string; members: ReturnType<typeof unionMembers> }
  >();
  for (const op of agg.operations) {
    if (op.returnType?.kind !== "union") continue;
    operationReturnUnions.set(op.name, {
      name: unionInstanceName(op.returnType.variants),
      members: unionMembers(op.returnType.variants, ctx),
    });
  }

  // The aggregate that physically owns the parent table (the TPH base
  // for shared-table concretes) names containment / part FK columns.
  const ownerName = tableOwnerName(agg, ctx.aggregates);
  for (const part of agg.parts) {
    // A nested part (declared inside a sibling part) FKs to that sibling's
    // table; a root-level part keeps the root / TPH-base owner.  Shared source
    // of truth with `migrations-builder.ts` so the JPA join column and the
    // Flyway DDL agree.
    const dp = directParentOf(agg, part.name);
    const fkOwner = dp?.nested ? dp.name : ownerName;
    place(
      `${part.name}.java`,
      "entity",
      renderJavaEntity(part, false, basePkg, pkgFor("entity", agg.name), agg.name, {
        emitTrace,
        eventFields,
        // Document / embedded aggregates fold their parts into jsonb —
        // the part is a plain class (no part table, no JPA bindings).
        persistence:
          isDocument || isEmbedded
            ? undefined
            : {
                tableName: plural(snake(part.name)),
                schema,
                // `_parent` @OneToOne (single only) + the `parentId` mirror both
                // reference the DIRECT parent, so JPA navigates the real
                // hierarchy and the join column matches the Flyway DDL.
                parentFkColumn: `${snake(fkOwner)}_id`,
                parentEntityName: dp?.nested ? dp.name : undefined,
                oneToOneParentOf: dp?.single ? dp.name : undefined,
                voLookup,
              },
      }),
      agg.name,
    );
  }
  place(
    `${agg.name}.java`,
    "entity",
    renderJavaEntity(agg, true, basePkg, pkgFor("entity", agg.name), agg.name, {
      emitTrace,
      superType,
      operationReturnUnions,
      eventFields,
      promotedCaps,
      // Event-sourced / document aggregates have no normalised state
      // tables — the entity is a plain domain class (no JPA bindings;
      // ES folds the stream, document round-trips one jsonb column).
      persistence:
        agg.persistedAs === "eventLog" || isDocument
          ? undefined
          : {
              tableName: plural(snake(agg.name)),
              schema,
              containmentOwnerName: ownerName,
              embedded: isEmbedded,
              voLookup,
            },
    }),
    agg.name,
  );

  // Repository triple: domain port + Spring Data JPA interface + impl.
  // Views sourced from this aggregate ride synthesized parameterless
  // finds (the mergeViewsAsFinds analog) — repository-level only; the
  // aggregate controller doesn't route them (the views controller does).
  const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
  // Retrievals targeting this aggregate; a retrieval whose `where` is
  // exactly an eligible criterion reference consumes the reified
  // Specification factory instead of a JPQL query.
  const aggRetrievals = (ctx.retrievals ?? []).filter(
    (r) => r.targetType.kind === "entity" && r.targetType.name === agg.name,
  );
  const isReified = (r: (typeof aggRetrievals)[number]): boolean => {
    if (!r.criterionRef) return false;
    const crit = ctx.criteria.find((c) => c.name === r.criterionRef?.name);
    return !!crit && criterionEligible(crit, ctx)?.name === agg.name;
  };
  const viewFinds = viewFindsFor(agg.name, ctx) as unknown as RepositoryIR["finds"];
  const repoWithViews: RepositoryIR =
    viewFinds.length > 0
      ? repo
        ? { ...repo, finds: [...repo.finds, ...viewFinds] }
        : { name: `${agg.name}Repository`, aggregateName: agg.name, finds: viewFinds }
      : (repo ?? { name: `${agg.name}Repository`, aggregateName: agg.name, finds: [] });
  const idClass = `${ownerName}Id`;
  const repoCtx: JavaRepoCtx = {
    basePkg,
    domainPkg: pkgFor("repository-interface", agg.name),
    infraPkg: pkgFor("repository-impl", agg.name),
    entityPkg: pkgFor("entity", agg.name),
    criteriaPkg: pkgFor("criteria"),
    persistencePkg: pkgFor("infra-persistence"),
    retrievals: aggRetrievals,
    isReified,
    provenance: provenancedFieldsOf(agg).length > 0,
    promotedCaps,
    bypassByRetrieval: inlineRunBypassesByRetrieval(ctx, agg.name),
  };
  place(
    `${agg.name}Repository.java`,
    "repository-interface",
    renderJavaRepositoryInterface(agg, repoWithViews, repoCtx, idClass),
    agg.name,
  );
  if (agg.persistedAs === "eventLog") {
    // Event-sourced: no Spring Data interface — the impl reads/appends
    // the <agg>_events stream via JdbcTemplate and folds via appliers.
    place(
      `${agg.name}RepositoryImpl.java`,
      "repository-impl",
      renderJavaEventSourcedRepositoryImpl(agg, repoWithViews, repoCtx, idClass, schema),
      agg.name,
    );
  } else if (isDocument) {
    // Document shape: no Spring Data interface — the impl round-trips
    // the whole aggregate through one jsonb column via JdbcTemplate.
    place(
      `${agg.name}RepositoryImpl.java`,
      "repository-impl",
      renderJavaDocumentRepositoryImpl(agg, repoWithViews, repoCtx, idClass, schema),
      agg.name,
    );
  } else {
    place(
      `${agg.name}JpaRepository.java`,
      "spring-data-repository",
      renderJavaSpringDataRepository(agg, repoWithViews, repoCtx, idClass),
      agg.name,
    );
    place(
      `${agg.name}RepositoryImpl.java`,
      "repository-impl",
      renderJavaRepositoryImpl(agg, repoWithViews, repoCtx, idClass),
      agg.name,
    );
  }

  // API layer: DTO records, wire validators, the layered service, and
  // the controller.
  const applicationPkg = pkgFor("service", agg.name);
  const esCreateParams = agg.persistedAs === "eventLog" ? agg.creates?.[0]?.params : undefined;
  for (const dto of renderDtoFiles(
    agg,
    voLookup,
    applicationPkg,
    basePkg,
    pkgFor("entity", agg.name),
    esCreateParams,
  )) {
    place(dto.name, dto.category, dto.content, agg.name);
  }
  const validators = renderJavaValidators(agg, applicationPkg, basePkg);
  if (validators) {
    place(`${agg.name}Validators.java`, "service", validators, agg.name);
  }
  place(
    `${agg.name}Service.java`,
    "service",
    renderJavaService(agg, repo, voLookup, {
      basePkg,
      pkg: applicationPkg,
      entityPkg: pkgFor("entity", agg.name),
      domainRepoPkg: pkgFor("repository-interface", agg.name),
      authed: authRequired,
      boundedContext: ctx,
      idClass,
      esCreateParams,
    }),
    agg.name,
  );
  // Exception-less operation returns: the domain union (sealed interface
  // + variant records, entity package) and its Jackson-polymorphic wire
  // twin (response-dto package).
  const emittedUnionNames = new Set<string>();
  for (const spec of aggregateReturnUnions(agg, ctx).values()) {
    emittedUnionNames.add(spec.name);
    for (const f of renderJavaDomainUnionFiles(spec, pkgFor("entity", agg.name), basePkg)) {
      place(f.name, "entity", f.content, agg.name);
    }
    for (const f of renderJavaUnionWireFiles(spec, pkgFor("response-dto", agg.name), basePkg)) {
      place(f.name, "response-dto", f.content, agg.name);
    }
  }
  // Single-success union finds (`Order or NotFound` / `Order option`) emit no
  // tagged wire DTO: the service returns the success variant's `<Agg>Response`
  // and the controller returns it directly at 200, with the error/absent
  // variant at its own status (exception-less.md §4).  A tagged union DTO is
  // needed only for a genuine multi-success union, which IR validation rejects
  // for finds.
  for (const op of agg.operations.filter((o) => o.extern)) {
    place(
      `${upperFirst(op.name)}${agg.name}Handler.java`,
      "extern-handler-interface",
      renderExternHandlerInterface(agg, op, applicationPkg, basePkg, pkgFor("entity", agg.name)),
      agg.name,
    );
    place(
      `DevStub${upperFirst(op.name)}${agg.name}Handler.java`,
      "extern-handler-stub",
      renderExternHandlerStub(agg, op, applicationPkg, basePkg, pkgFor("entity", agg.name)),
      agg.name,
    );
  }
  place(
    `${plural(agg.name)}Controller.java`,
    "controller",
    renderJavaController(agg, repo, {
      basePkg,
      pkg: pkgFor("controller", agg.name),
      applicationPkg,
      entityPkg: pkgFor("entity", agg.name),
      boundedContext: ctx,
      idClass,
      routePrefix,
      esConstructible: !!esCreateParams,
    }),
    agg.name,
  );

  // `test "name"` blocks → JUnit classes (pure domain, `mvn test`).
  const testsFile = renderJavaTestsFile(
    agg,
    ctx,
    basePkg,
    pkgFor("test-class", agg.name),
    sys?.user?.fields,
  );
  if (testsFile) {
    place(`${agg.name}Tests.java`, "test-class", testsFile, agg.name);
  }
}
