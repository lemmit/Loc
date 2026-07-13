// ---------------------------------------------------------------------------
// byLayer — the real LayoutAdapter for the hono platform.  Captures the
// path conventions the existing TypeScript/Hono emitter spells out
// inline at every `out.set(...)` call site.  Today the orchestrator
// (`src/platform/hono/v4/emit.ts` + sibling `*-emit.ts` /
// `*-builder.ts`) hard-codes these paths; this adapter exposes them
// as a single pure `pathFor()` so the eventual rewire (later F6 slice)
// can drop the inline strings and dispatch through the adapter.
//
// The byLayer convention for hono groups files by RESPONSIBILITY:
//
//   domain/                — aggregate roots, value objects, events,
//                            ids, errors, per-aggregate tests, extern
//                            handler files
//   db/                    — drizzle schema, per-aggregate repository
//                            modules, migrations
//   http/                  — Hono app shell (index), per-aggregate
//                            routes, views + workflows top-level files
//   obs/                   — observability plumbing (log, als,
//                            request-id)
//   auth/                  — user-types, verifier, middleware
//                            (only when the system declares a `user`
//                            block + the deployable opts in)
//   lib/                   — optional helper modules (e.g. money zod
//                            schema)
//   <root>/                — index.ts, package.json, tsconfig,
//                            tsup.config, drizzle.config, Dockerfile,
//                            .dockerignore, certs/, LICENSE
// ---------------------------------------------------------------------------

import type {
  EmitCtx,
  EmittedArtifact,
  LayoutAdapter,
} from "../../../../generator/_adapters/index.js";
import { lowerFirst } from "../../../../util/naming.js";

/** Categories every hono artifact carries.  Adding a new file kind =
 *  add a new arm here + the matching string at the emit site. */
export type HonoArtifactCategory =
  // domain/
  | "domain-aggregate" // per-aggregate root module (domain/<lowerFirst>.ts)
  | "domain-aggregate-base" // abstract base for an extern aggregate (domain/<lowerFirst>.base.ts)
  | "domain-test" // per-aggregate test file (domain/<lowerFirst>.test.ts)
  | "domain-ids" // pooled domain/ids.ts
  | "domain-value-objects" // pooled domain/value-objects.ts
  | "domain-events" // pooled domain/events.ts
  | "domain-errors" // pooled domain/errors.ts
  | "domain-provenance" // optional domain/provenance.ts
  // db/
  | "drizzle-schema" // db/schema.ts
  | "drizzle-repository" // per-aggregate db/repositories/<lowerFirst>-repository.ts
  | "migration" // per-deployable db/migrations/<name>
  // http/
  | "http-index" // http/index.ts (Hono app shell)
  | "http-routes" // per-aggregate http/<lowerFirst>.routes.ts
  | "http-views" // top-level http/views.ts
  | "http-workflows" // top-level http/workflows.ts
  // auth/
  | "auth-user-types" // auth/user-types.ts
  | "auth-verifier" // auth/verifier.ts
  | "auth-middleware" // auth/middleware.ts
  // obs/
  | "obs-log" // obs/log.ts
  | "obs-als" // obs/als.ts
  | "obs-request-id" // obs/request-id.ts
  // lib/
  | "lib-schemas" // lib/schemas.ts (e.g. money zod schema)
  // <root>/
  | "project-index" // index.ts
  | "package-json" // package.json
  | "tsconfig" // tsconfig.json
  | "tsup-config" // tsup.config.ts
  | "drizzle-config" // drizzle.config.ts
  | "dockerfile" // Dockerfile
  | "dockerignore" // .dockerignore
  | "license" // LICENSE
  | "certs-marker"; // certs/.gitkeep (and other certs/ entries)

/** Extension of the shared EmittedArtifact for hono routing. */
export interface HonoArtifact extends EmittedArtifact {
  category: HonoArtifactCategory;
  /** Aggregate name for per-aggregate categories.  `lowerFirst`
   *  applies at the boundary so `Order` → `order`, `OrderLine` →
   *  `orderLine` (camelCase, NOT kebab — matches today's emit). */
  aggregateName?: string;
}

function pathForCategory(artifact: HonoArtifact): string {
  const cat = artifact.category;
  const name = artifact.name;
  const agg = artifact.aggregateName;
  const slug = (n: string): string => lowerFirst(n);
  switch (cat) {
    // domain/ — per-aggregate
    case "domain-aggregate":
      if (!agg) throw new Error(`byLayer.pathFor: 'domain-aggregate' missing aggregateName`);
      return `domain/${slug(agg)}.ts`;
    case "domain-aggregate-base":
      if (!agg) throw new Error(`byLayer.pathFor: 'domain-aggregate-base' missing aggregateName`);
      return `domain/${slug(agg)}.base.ts`;
    case "domain-test":
      if (!agg) throw new Error(`byLayer.pathFor: 'domain-test' missing aggregateName`);
      return `domain/${slug(agg)}.test.ts`;
    // domain/ — pooled
    case "domain-ids":
      return `domain/ids.ts`;
    case "domain-value-objects":
      return `domain/value-objects.ts`;
    case "domain-events":
      return `domain/events.ts`;
    case "domain-errors":
      return `domain/errors.ts`;
    case "domain-provenance":
      return `domain/provenance.ts`;
    // db/
    case "drizzle-schema":
      return `db/schema.ts`;
    case "drizzle-repository":
      if (!agg) throw new Error(`byLayer.pathFor: 'drizzle-repository' missing aggregateName`);
      return `db/repositories/${slug(agg)}-repository.ts`;
    case "migration":
      // Per-deployable migrations land under `db/migrations/`; caller
      // passes the bare file name.
      return `db/migrations/${name}`;
    // http/
    case "http-index":
      return `http/index.ts`;
    case "http-routes":
      if (!agg) throw new Error(`byLayer.pathFor: 'http-routes' missing aggregateName`);
      return `http/${slug(agg)}.routes.ts`;
    case "http-views":
      return `http/views.ts`;
    case "http-workflows":
      return `http/workflows.ts`;
    // auth/
    case "auth-user-types":
      return `auth/user-types.ts`;
    case "auth-verifier":
      return `auth/verifier.ts`;
    case "auth-middleware":
      return `auth/middleware.ts`;
    // obs/
    case "obs-log":
      return `obs/log.ts`;
    case "obs-als":
      return `obs/als.ts`;
    case "obs-request-id":
      return `obs/request-id.ts`;
    // lib/
    case "lib-schemas":
      return `lib/schemas.ts`;
    // <root>/
    case "project-index":
      return `index.ts`;
    case "package-json":
      return `package.json`;
    case "tsconfig":
      return `tsconfig.json`;
    case "tsup-config":
      return `tsup.config.ts`;
    case "drizzle-config":
      return `drizzle.config.ts`;
    case "dockerfile":
      return `Dockerfile`;
    case "dockerignore":
      return `.dockerignore`;
    case "license":
      return `LICENSE`;
    case "certs-marker":
      return `certs/${name}`;
  }
}

export const byLayerLayoutAdapter: LayoutAdapter = {
  name: "byLayer",

  pathFor(artifact: EmittedArtifact, _ctx: EmitCtx): string {
    if (!(artifact as HonoArtifact).category) {
      throw new Error(
        `byLayer.pathFor: artifact '${artifact.name}' is missing a category (HonoArtifactCategory).  ` +
          `Every hono emit site must tag its artifact with the right category before dispatching through the layout adapter.`,
      );
    }
    return pathForCategory(artifact as HonoArtifact);
  },
};
