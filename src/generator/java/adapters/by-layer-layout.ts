// ---------------------------------------------------------------------------
// byLayer — a real LayoutAdapter for the java platform.  Java files must
// live in the directory matching their package, so the layout adapter is
// the single source of truth for BOTH: `packageFor(...)` answers the
// package an emitter should declare, `pathFor(...)` derives the
// deployable-relative file path from it.
//
// The byLayer convention groups packages by ARCHITECTURAL LAYER first:
//
//   <base>.domain.ids / .enums / .valueobjects / .events / .common
//   <base>.domain.<plural>         — aggregate root + parts + repo interface
//   <base>.application.<plural>    — DTOs + services (layered style)
//   <base>.application.views / .workflows
//   <base>.infrastructure.repositories / .persistence
//   <base>.api                     — controllers + exception advice
//   <base>.config                  — Jackson / Spring configuration
//   <base>                         — Application.java
//
// `byFeature` (./by-feature-layout.ts) rehomes the per-aggregate
// categories under `<base>.features.<plural>`; shared categories stay
// put, so the two adapters differ only in the per-aggregate arm.
// ---------------------------------------------------------------------------

import { plural } from "../../../util/naming.js";
import type { EmitCtx, EmittedArtifact, LayoutAdapter } from "../../_adapters/index.js";
import { basePackageFor, javaPackageSegment, mainSourcePath, testSourcePath } from "../naming.js";

/** Categories every java artifact carries.  Emit sites tag artifacts so
 *  layout adapters can route consistently; new file kinds add an arm. */
export type JavaArtifactCategory =
  // domain
  | "id"
  | "enum"
  | "valueobject"
  | "event"
  | "domain-common"
  | "entity" // aggregate root + parts
  | "repository-interface"
  | "criteria" // reified criterion Specification factories
  | "domain-service" // stateless pure-calculator domain services
  // application
  | "request-dto"
  | "response-dto"
  | "service" // layered-style application service
  | "view-service"
  | "workflow-service"
  // infrastructure
  | "repository-impl"
  | "spring-data-repository"
  | "join-entity"
  | "infra-persistence"
  | "resource-client" // objectStore / queue / api client classes
  // api
  | "controller"
  | "api-common" // exception advice, wrappers
  // shell
  | "config"
  | "application-root"
  | "test-class";

/** Typed extension of the shared EmittedArtifact for java routing. */
export interface JavaArtifact extends EmittedArtifact {
  category: JavaArtifactCategory;
  /** Aggregate the artifact belongs to — required for per-aggregate
   *  categories so the package picks up the plural segment. */
  aggregateName?: string;
}

/** Per-aggregate package segment: `Order` → `orders`. */
export const aggSegment = (name: string): string => javaPackageSegment(plural(name));

/** Categories that live under a per-aggregate package — the set the
 *  byFeature adapter rehomes under `<base>.features.<plural>`. */
const PER_AGGREGATE = new Set<JavaArtifactCategory>([
  "entity",
  "repository-interface",
  "request-dto",
  "response-dto",
  "service",
  "controller",
  "repository-impl",
  "spring-data-repository",
  "test-class",
]);

export function isPerAggregateCategory(cat: JavaArtifactCategory): boolean {
  return PER_AGGREGATE.has(cat);
}

/** The byLayer package for one artifact category. */
export function byLayerPackage(
  category: JavaArtifactCategory,
  basePkg: string,
  aggregateName?: string,
): string {
  const agg = (): string => {
    if (!aggregateName) {
      throw new Error(`java byLayer: '${category}' artifact is missing aggregateName`);
    }
    return aggSegment(aggregateName);
  };
  switch (category) {
    case "id":
      return `${basePkg}.domain.ids`;
    case "enum":
      return `${basePkg}.domain.enums`;
    case "valueobject":
      return `${basePkg}.domain.valueobjects`;
    case "event":
      return `${basePkg}.domain.events`;
    case "domain-common":
      return `${basePkg}.domain.common`;
    case "criteria":
      return `${basePkg}.domain.criteria`;
    case "domain-service":
      return `${basePkg}.domain.services`;
    case "entity":
    case "repository-interface":
      return `${basePkg}.domain.${agg()}`;
    case "request-dto":
    case "response-dto":
    case "service":
      return `${basePkg}.application.${agg()}`;
    case "view-service":
      return `${basePkg}.application.views`;
    case "workflow-service":
      return `${basePkg}.application.workflows`;
    case "repository-impl":
    case "spring-data-repository":
      return `${basePkg}.infrastructure.repositories`;
    case "join-entity":
    case "infra-persistence":
      return `${basePkg}.infrastructure.persistence`;
    case "resource-client":
      return `${basePkg}.resources`;
    case "controller":
    case "api-common":
      return `${basePkg}.api`;
    case "config":
      return `${basePkg}.config`;
    case "application-root":
      return basePkg;
    case "test-class":
      return `${basePkg}.domain.${agg()}`;
  }
}

/** Build a LayoutAdapter from a category→package router.  `pathFor`
 *  derives `src/main/java/<pkg-path>/<Name>.java` (test classes land
 *  under `src/test/java/...`). */
export function makeJavaLayoutAdapter(
  name: string,
  packageFor: (category: JavaArtifactCategory, basePkg: string, aggregateName?: string) => string,
  basePkgOf: (ctx: EmitCtx) => string,
): JavaLayoutAdapter {
  return {
    name,
    packageFor,
    pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string {
      const a = artifact as JavaArtifact;
      if (!a.category) {
        throw new Error(
          `java ${name}.pathFor: artifact '${artifact.name}' is missing a category (JavaArtifactCategory).`,
        );
      }
      const pkg = packageFor(a.category, basePkgOf(ctx), a.aggregateName);
      return a.category === "test-class"
        ? testSourcePath(pkg, a.name)
        : mainSourcePath(pkg, a.name);
    },
  };
}

/** Java layout adapters carry the package router alongside `pathFor` —
 *  emitters resolve the `package …;` declaration through the SAME
 *  adapter that routes the file, so package and path can't drift. */
export interface JavaLayoutAdapter extends LayoutAdapter {
  packageFor(category: JavaArtifactCategory, basePkg: string, aggregateName?: string): string;
}

const basePkgOfCtx = (ctx: EmitCtx): string => basePackageFor(ctx.deployable?.name ?? "app");

export const byLayerLayoutAdapter: JavaLayoutAdapter = makeJavaLayoutAdapter(
  "byLayer",
  byLayerPackage,
  basePkgOfCtx,
);
