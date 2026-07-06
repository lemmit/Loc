// ---------------------------------------------------------------------------
// AdapterNotImplementedError + stubAdapter helper.
//
// A platform's adapter menu (`persistence` / `styles` / `layouts` in the
// registry) carries ONE entry per name the platform claims to support.
// Real adapters do the emit work; stub adapters declare a capability slot
// the platform RESERVES but doesn't ship yet — invoking any `emit*` method
// on a stub throws the user-facing error below.
//
// The split (capability declaration that lives forever vs. emit
// implementation that lands per-stream) is the F3-of-the-micro-plan
// contract.  The validator can already enforce capability rules (e.g.
// `persistence: dapper` requires `stateBased`) against a stub's declared
// `supportedStrategies` / `supports` — and the build still fails at
// emit time with a clean message instead of a half-working artifact.
// ---------------------------------------------------------------------------

/** Adapter category — present in error messages and the registry entry
 *  name, so the user sees which slot they tripped. */
export type AdapterKind = "persistence" | "style" | "layout";

/** Brand stamped on every stub's capability target so a pure lookup can
 *  tell stubs from real adapters WITHOUT invoking an `emit*` method
 *  (which throws).  Read by `availableAdapterNames`
 *  (`src/platform/resolve-adapters.ts`) to derive the validator's menu of
 *  only-implemented adapters — per D-REALIZATION-AXES, selecting a stub
 *  must be rejected at validation, not blow up at generation.  A symbol
 *  key, so it can never collide with a capability/emit field name. */
export const ADAPTER_IS_STUB = Symbol("loom.adapterIsStub");

export class AdapterNotImplementedError extends Error {
  constructor(
    readonly adapterKind: AdapterKind,
    readonly adapterName: string,
    readonly platformName: string,
    readonly availableImplementations: readonly string[],
  ) {
    const available = availableImplementations.length
      ? `Available implementations: ${[...availableImplementations].sort().join(", ")}.`
      : `No implementations of this ${adapterKind} are available yet.`;
    super(
      `${adapterKind} adapter '${adapterName}' is not yet implemented for platform '${platformName}'. ${available}`,
    );
    this.name = "AdapterNotImplementedError";
  }
}

/** Capability declaration fields a stub still answers at registration
 *  time — every `name` / `supportedStrategies` / `supports` / similar
 *  predicate the validator reads BEFORE emission.  Everything starting
 *  with `emit` is the implementation surface and throws when called.
 *
 *  Constructed via `stubAdapter` (below) — see PersistenceAdapter /
 *  StyleAdapter / LayoutAdapter `Partial<T>` capability subsets each
 *  contract's `Capabilities` alias publishes. */
export function stubAdapter<T extends object>(
  adapterKind: AdapterKind,
  adapterName: string,
  platformName: string,
  /** Lazily evaluated — called the FIRST time an `emit*` method
   *  throws.  This lets the registry register every adapter before
   *  `realImplementations()` is queried, so the error message lists
   *  REAL siblings even though stubs and reals are registered in
   *  arbitrary order. */
  realImplementations: () => readonly string[],
  /** Capability declaration — every field the validator reads.  Typed
   *  as a `Partial<T>` here, refined per-contract by each adapter's
   *  exported helper (`stubPersistenceAdapter` etc.) so callers can't
   *  forget a required capability field. */
  capabilities: Partial<T>,
): T {
  // Brand the target so `availableAdapterNames` can tell stubs apart by
  // a pure read (`adapter[ADAPTER_IS_STUB] === true`).  Lives on the
  // target, so the proxy's `prop in target` branch returns it directly.
  (capabilities as Record<symbol, unknown>)[ADAPTER_IS_STUB] = true;
  return new Proxy(capabilities as T, {
    get(target, prop, receiver) {
      // Capability fields answer directly.
      if (prop in (target as Record<string | symbol, unknown>)) {
        return Reflect.get(target, prop, receiver);
      }
      // Symbol accesses (e.g. Symbol.toPrimitive when JS coerces the
      // proxy to a string) fall through silently — only string keys
      // are part of the implementation surface.
      if (typeof prop !== "string") return undefined;
      // Every other string-keyed access is treated as an implementation
      // method (`emit*` on persistence / style, `pathFor` on layout, …).
      // Return a thunk that throws the user-facing error on call —
      // surfaces as a clean `AdapterNotImplementedError` at the call
      // site instead of a `TypeError: x is not a function`.
      return () => {
        throw new AdapterNotImplementedError(
          adapterKind,
          adapterName,
          platformName,
          realImplementations(),
        );
      };
    },
  });
}
