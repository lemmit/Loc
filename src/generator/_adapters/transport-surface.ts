// ---------------------------------------------------------------------------
// TransportAdapter — the per-(platform × HTTP surface) slot.
//
// "Transport" is the request-routing shape the backend exposes: `minimalApi`
// (ASP.NET Minimal APIs), `controllers` (ASP.NET MVC controllers), `hono`
// (the Hono router), `phoenix` (Phoenix Router + controllers).  It is the
// `transport:` realization axis (D-REALIZATION-AXES), promoted from a
// greenfield single-value to a real adapter axis so it is uniform with
// persistence / style / layout (docs/plans/realization-axes-alignment.md).
//
// The contract is intentionally THIN — just the registry name — because no
// backend branches its emit on the transport yet (each platform ships exactly
// one real transport today; dotnet's is `controllers` — the attribute-routed
// `[ApiController]` classes the backend has always emitted — and the
// per-transport request-pipeline emit, e.g. ASP.NET Minimal APIs
// (`app.MapGet/MapPost`) as an alternative, is future work).  Keeping it thin
// lets the axis become adapter-backed (menu / validation /
// `transport: minimalApi` recognized as reserved) without committing to an
// emit decomposition.
// ---------------------------------------------------------------------------

export interface TransportAdapter {
  /** Registry key — `transport: <name>` resolves to this entry. */
  readonly name: string;
}

/** Capability subset a stub still answers at registration time. */
export type TransportCapabilities = Pick<TransportAdapter, "name">;
