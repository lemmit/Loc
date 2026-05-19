// npm registry client (Phase B3).
//
// Public registry only — registry.npmjs.org serves permissive CORS
// for both packuments and tarballs (B1 confirmed: no proxy needed).
// Private registries go through the declared RegistryResolver seam
// (future), never here.

export const NPM_REGISTRY = "https://registry.npmjs.org";

export interface VersionMeta {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  dist: { tarball: string };
  exports?: unknown;
  main?: string;
  module?: string;
}

export interface Packument {
  name: string;
  versions: Record<string, VersionMeta>;
  "dist-tags"?: Record<string, string>;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      // The abbreviated packument is ~10x smaller and carries
      // everything we need (versions + deps + dist).
      accept: "application/vnd.npm.install-v1+json, application/json",
    },
  });
  if (!r.ok) throw new Error(`registry ${r.status} for ${url}`);
  return (await r.json()) as T;
}

export function fetchPackument(name: string): Promise<Packument> {
  return getJson<Packument>(`${NPM_REGISTRY}/${name}`);
}

export async function fetchTarball(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`tarball ${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
