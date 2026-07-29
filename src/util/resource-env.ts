// ---------------------------------------------------------------------------
// Resource connection env-var naming — the seam between what a generated
// backend READS at runtime and what `docker-compose.yml` / the Helm chart
// WRITES for it.
//
// Lives in `src/util/` because its consumers span two layers: the per-backend
// resource-client emitters (`generator/<platform>/adapters/resource-clients.ts`)
// bake `process.env.<VAR>` / `System.getenv("<VAR>")` into the client, and the
// system composer (`src/system/`) injects the matching value.  A drift between
// the two is invisible at compile time and surfaces as a client falling back to
// its baked-in default — so the derivation belongs in exactly one place.
// ---------------------------------------------------------------------------

/** `SALES_FILES`-style SCREAMING_SNAKE env-var base for a resource name. */
export function resourceEnvBase(resourceName: string): string {
  return resourceName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** `SALES_FILES_URL`-style env var name for a resource's connection URL. */
export function resourceEnvUrlVar(resourceName: string): string {
  return `${resourceEnvBase(resourceName)}_URL`;
}
