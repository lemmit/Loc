import { enrichLoomModel } from "../../ir/enrich/enrichments.js";
import { lowerModel } from "../../ir/lower/lower.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type {
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  RepositoryIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { isTpcBase, isTphBase, tableOwnerName } from "../../ir/util/inheritance.js";
import { resolveDataSourceConfig } from "../../ir/util/resolve-datasource.js";
import type { Model } from "../../language/generated/ast.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import type { EmitCtx, LayoutAdapter, StyleAdapter } from "../_adapters/index.js";
import { unionMembers } from "../_payload/union-wire.js";
import { byFeatureLayoutAdapter } from "./adapters/by-feature-layout.js";
import type {
  JavaArtifact,
  JavaArtifactCategory,
  JavaLayoutAdapter,
} from "./adapters/by-layer-layout.js";
import { renderApiExceptionAdvice, renderJavaController } from "./emit/api.js";
import { renderAuthFiles } from "./emit/auth.js";
import {
  renderAggregateNotFoundException,
  renderDomainEventInterface,
  renderDomainException,
  renderForbiddenException,
  renderPackageMarker,
  renderPagedRecord,
  renderWireValidationException,
} from "./emit/common.js";
import { criterionEligible, renderJavaCriteriaClasses } from "./emit/criteria.js";
import { renderDtoFiles } from "./emit/dto.js";
import { renderJavaAbstractBaseEntity, renderJavaEntity } from "./emit/entity.js";
import { renderJavaEnum, renderJavaValueObject } from "./emit/enums-vos.js";
import { renderJavaEvent } from "./emit/events.js";
import { renderExternHandlerInterface, renderExternHandlerStub } from "./emit/extern.js";
import { renderJavaId } from "./emit/ids.js";
import { emitJavaMigrations } from "./emit/migrations.js";
import {
  renderCatalogLogger,
  renderLifecycleCatalog,
  renderRequestCatalogFilter,
} from "./emit/observability.js";
import {
  renderApplication,
  renderApplicationYml,
  renderDockerfile,
  renderDockerignore,
  renderGradleBuild,
  renderGradleSettings,
  renderHealthController,
} from "./emit/program.js";
import {
  type JavaRepoCtx,
  renderJavaRepositoryImpl,
  renderJavaRepositoryInterface,
  renderJavaSpringDataRepository,
  renderOffsetLimitPageRequest,
} from "./emit/repository.js";
import { renderJavaSeedRunner } from "./emit/seed.js";
import { renderJavaService } from "./emit/service.js";
import { renderJavaTestsFile } from "./emit/tests.js";
import { renderJavaValidators } from "./emit/validator.js";
import { renderJavaViews, viewFindsFor } from "./emit/view.js";
import { renderJavaWorkflows } from "./emit/workflow.js";
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

  // Shared domain types + the package markers that keep the entity files'
  // wildcard imports valid even when a package would otherwise be empty.
  place("DomainException.java", "domain-common", renderDomainException(basePkg));
  place("ForbiddenException.java", "domain-common", renderForbiddenException(basePkg));
  place(
    "AggregateNotFoundException.java",
    "domain-common",
    renderAggregateNotFoundException(basePkg),
  );
  place("WireValidationException.java", "domain-common", renderWireValidationException(basePkg));
  place("Paged.java", "domain-common", renderPagedRecord(basePkg));
  place("DomainEvent.java", "event", renderDomainEventInterface(basePkg));
  place("_Namespace.java", "enum", renderPackageMarker(pkgFor("enum")));
  place("_Namespace.java", "valueobject", renderPackageMarker(pkgFor("valueobject")));
  place("_Namespace.java", "id", renderPackageMarker(pkgFor("id")));
  place("ApiExceptionAdvice.java", "api-common", renderApiExceptionAdvice(basePkg));
  // Observability catalog — always-on, like dotnet's request log +
  // Hono's pino lines (the obs e2e suites assert this envelope).
  place("CatalogLog.java", "config", renderCatalogLogger(basePkg));
  place("LifecycleCatalog.java", "config", renderLifecycleCatalog(basePkg));
  place("RequestCatalogFilter.java", "config", renderRequestCatalogFilter(basePkg));

  for (const ctx of contexts) {
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
      emitAggregate(agg, ctx, basePkg, place, pkgFor, emitTrace, system?.sys, authRequired);
    }
    // Workflows + views — per-context controllers under /workflows and
    // /views, services in the shared application packages.
    const workflowFiles = renderJavaWorkflows(
      ctx,
      {
        basePkg,
        pkg: pkgFor("workflow-service"),
        entityPkgOf: (a) => pkgFor("entity", a),
        repoPkgOf: (a) => pkgFor("repository-interface", a),
      },
      authRequired,
    );
    if (workflowFiles) {
      for (const [name, f] of workflowFiles) {
        place(name, f.category === "controller" ? "api-common" : "workflow-service", f.content);
      }
    }
    const viewFiles = renderJavaViews(ctx, {
      basePkg,
      pkg: pkgFor("view-service"),
      applicationPkgOf: (a) => pkgFor("service", a),
      entityPkgOf: (a) => pkgFor("entity", a),
      repoPkgOf: (a) => pkgFor("repository-interface", a),
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
    // Offset/limit Pageable behind the call-site `page:` on `Repo.run`.
    if ((ctx.retrievals ?? []).length > 0) {
      place(
        "OffsetLimitPageRequest.java",
        "infra-persistence",
        renderOffsetLimitPageRequest(pkgFor("infra-persistence")),
      );
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
    for (const [name, content] of renderAuthFiles(system.sys, basePkg)) {
      out.set(mainSourcePath(`${basePkg}.auth`, name), content);
    }
  }

  // Per-module Flyway migrations — empty (non-system entry points) → no-op.
  // The flyway deps stay as long as ANY migration history exists (a regen
  // with an unchanged schema emits no new steps, but the previously
  // emitted V*.sql files still need Flyway to run).
  const allMigrations = system?.migrations ?? [];
  emitJavaMigrations(allMigrations, out);
  const hasMigrations = allMigrations.some((m) => m.steps.length > 0 || m.baseline !== null);

  // Project shell — stable from S1 on.
  out.set("build.gradle.kts", renderGradleBuild({ flyway: hasMigrations }));
  out.set("settings.gradle.kts", renderGradleSettings(slug));
  out.set("src/main/resources/application.yml", renderApplicationYml(slug));
  out.set(mainSourcePath(basePkg, "Application.java"), renderApplication(basePkg));
  out.set(
    mainSourcePath(`${basePkg}.api`, "HealthController.java"),
    renderHealthController(basePkg),
  );
  out.set("Dockerfile", renderDockerfile());
  out.set(".dockerignore", renderDockerignore());
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
): void {
  const eventFields = new Map(ctx.events.map((e) => [e.name, e.fields.map((f) => f.name)]));
  // The JPA mapping mirrors `schemaFromModule`: binding-resolved schema +
  // flattened-VO column names (voLookup covers ambient VOs — enrichment
  // folds them into every context).
  const voLookup = new Map(ctx.valueObjects.map((v) => [v.name, v.fields] as const));
  const schema = sys ? resolveDataSourceConfig(agg, ctx, sys)?.schema : undefined;

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
    place(
      `${part.name}.java`,
      "entity",
      renderJavaEntity(part, false, basePkg, pkgFor("entity", agg.name), agg.name, {
        emitTrace,
        eventFields,
        persistence: {
          tableName: plural(snake(part.name)),
          schema,
          parentFkColumn: `${snake(ownerName)}_id`,
          oneToOneParentOf: agg.contains.some((c) => !c.collection && c.partName === part.name)
            ? agg.name
            : undefined,
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
      persistence: {
        tableName: plural(snake(agg.name)),
        schema,
        containmentOwnerName: ownerName,
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
  };
  place(
    `${agg.name}Repository.java`,
    "repository-interface",
    renderJavaRepositoryInterface(agg, repoWithViews, repoCtx, idClass),
    agg.name,
  );
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

  // API layer: DTO records, wire validators, the layered service, and
  // the controller.
  const applicationPkg = pkgFor("service", agg.name);
  for (const dto of renderDtoFiles(
    agg,
    voLookup,
    applicationPkg,
    basePkg,
    pkgFor("entity", agg.name),
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
    }),
    agg.name,
  );
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
