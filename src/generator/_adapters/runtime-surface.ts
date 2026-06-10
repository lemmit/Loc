// ---------------------------------------------------------------------------
// RuntimeAdapter — the per-(platform × aggregate-execution model) slot.
//
// "Runtime" is the aggregate execution / concurrency model: `transactional`
// (repository-loaded, DB-transaction consistency — the contrast to actor
// mailbox serialization), `genserver` (a BEAM process per aggregate),
// `orleans` / `akka` (.NET virtual-actor / actor runtimes).  It is the
// `runtime:` realization axis (D-REALIZATION-AXES), promoted from a greenfield
// single-value to a real adapter axis so it is uniform with persistence /
// style / layout / transport (docs/plans/realization-axes-alignment.md).
//
// Thin contract — just the registry `name` — because no backend branches its
// emit on the runtime yet (every backend ships `transactional`; the actor
// runtimes are registered as reserved stubs).  Keeping it thin lets the axis
// become adapter-backed (menu / validation / `runtime: orleans` recognized as
// reserved) without committing to an actor-runtime emit.
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
  /** Registry key — `runtime: <name>` resolves to this entry. */
  readonly name: string;
}

/** Capability subset a stub still answers at registration time. */
export type RuntimeCapabilities = Pick<RuntimeAdapter, "name">;
