// ---------------------------------------------------------------------------
// ResourceAdapter — the per-(platform × non-persistence resource kind)
// emitter slot, sibling to `PersistenceAdapter`.
//
// `PersistenceAdapter` is relational/repository/migration-shaped — it
// hosts an aggregate's truth (state / eventLog / cache).  The new
// infrastructure kinds (objectStore / queue / api) are not aggregate
// stores: a backend *consumes* them (puts a blob, enqueues a job, calls
// an API).  They share none of the repository/migration/outbox surface,
// so they get their own thinner contract: declare the client library
// dependency and emit the boot-time client/connection setup for the
// resources of this kind a deployable wires.
//
// Phase 2.4 (foundation): adapters emit the dependency + a connection
// module instantiated at boot.  The *call surface* domain logic uses to
// reach these clients is a workflow-level concern (RFC §Phase 4) and is
// deliberately out of scope here — no method wrappers are emitted.
// ---------------------------------------------------------------------------

import type {
  DataSourceIR,
  DataSourceKind,
  StorageIR,
  StorageKind,
} from "../../ir/types/loom-ir.js";
import type { EmitCtx, Lines } from "./types.js";

export interface ResourceAdapter {
  /** Registry key — the `sourceType` name this adapter realizes
   *  (e.g. `awsS3`, `rabbitmq`, `restApi`).  Lowercase / camelCase to
   *  match the `StorageKind` value. */
  readonly name: string;
  /** Infrastructure kinds this adapter can wire (objectStore / queue /
   *  api).  Mirrors the registry's `supports[kind]` for the sourceType;
   *  the orchestrator uses it to route a resource to its adapter. */
  readonly supportedKinds: readonly DataSourceKind[];
  /** Per-binding capability check — does this adapter realize the
   *  given (sourceType, kind) pair?  Implementations delegate to the
   *  sourceType registry so there is one source of truth. */
  supports(storageType: StorageKind, kind: DataSourceKind): boolean;
  /** Client-library dependencies (name → semver range) merged into the
   *  deployable's manifest.  Returns `{}` when the kind needs no extra
   *  dependency (e.g. `restApi` uses the platform's built-in fetch). */
  emitProjectDeps(ctx: EmitCtx): Record<string, string>;
  /** A self-contained client module for the resources of this adapter's
   *  kind that the deployable wires — imports at the top, then one
   *  exported client handle per resource.  `resources` are the
   *  `(context, kind)` bindings routed to this adapter; `physicalStores`
   *  are the storages they `use:` (carrying `connection` + `config`).
   *  The orchestrator writes the result to `resources/<sourceType>.ts`
   *  and side-effect-imports it from the server entry so the clients
   *  instantiate at boot.  No call-sites are emitted (those are a
   *  workflow-level concern — RFC §Phase 4). */
  emitClientModule(
    resources: readonly DataSourceIR[],
    physicalStores: readonly StorageIR[],
    ctx: EmitCtx,
  ): Lines;
}

/** Capability subset a stub answers at registration time — parallels
 *  `PersistenceCapabilities`. */
export type ResourceCapabilities = Pick<ResourceAdapter, "name" | "supportedKinds" | "supports">;
