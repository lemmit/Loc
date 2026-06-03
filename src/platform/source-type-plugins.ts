// Out-of-tree sourceType plugins.  A package under `packages/*` may
// contribute a custom `sourceType` to the registry by declaring it
// *declaratively* in its `package.json` `loom` manifest:
//
//   "loom": {
//     "kind": "sourceType",
//     "sourceType": {
//       "name": "clickhouseCloud",
//       "supports": { "database": { "capabilities": ["query"], "interfaces": ["sql"] } },
//       "configKeys": [{ "name": "endpoint", "type": "string", "required": true }]
//     }
//   }
//
// The neutral descriptor half of the registry (RFC §3.4) is pure data,
// so it ships as JSON — no plugin code is executed to register a
// sourceType.  The *vendor realization* half (compose image, client
// emission) rides the separate out-of-tree backend rail.  Trust model
// matches an out-of-tree backend: the package is installed code.
//
// Validation is hand-rolled (mirrors `fs-discovery.ts:asBackendManifest`)
// so the toolchain takes no extra runtime dependency.
//
// Boot-time inversion: `bootSourceTypePlugins(packagesDir)` runs once at
// CLI startup (next to the backend discovery) and pushes each discovered
// descriptor into `registerSourceType`.  The browser build and unit
// tests leave it unwired (no fs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
  type ConfigKeySchema,
  type ConfigKeyType,
  type InfraKind,
  type LoomInterface,
  registerSourceType,
  type SourceTypeDescriptor,
} from "../util/source-types.js";

const INFRA_KINDS = new Set<string>([
  "database",
  "eventLog",
  "cache",
  "objectStore",
  "queue",
  "api",
]);
const INTERFACES = new Set<string>(["sql", "rest", "graphql", "webSocket", "amqp", "sdk"]);
const CONFIG_TYPES = new Set<string>(["string", "number", "boolean", "enum", "secret"]);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Coerce a `loom` manifest field into a `SourceTypeDescriptor`, or
 *  `null` if it isn't a well-formed sourceType plugin. */
function parseSourceTypePlugin(loom: unknown): SourceTypeDescriptor | null {
  if (typeof loom !== "object" || loom === null) return null;
  const m = loom as Record<string, unknown>;
  if (m.kind !== "sourceType") return null;
  if (typeof m.sourceType !== "object" || m.sourceType === null) return null;
  const s = m.sourceType as Record<string, unknown>;
  if (typeof s.name !== "string" || s.name.length === 0) return null;
  if (typeof s.supports !== "object" || s.supports === null) return null;

  const supports: SourceTypeDescriptor["supports"] = {};
  for (const [kind, raw] of Object.entries(s.supports as Record<string, unknown>)) {
    if (!INFRA_KINDS.has(kind)) return null;
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (!isStringArray(r.capabilities)) return null;
    if (!isStringArray(r.interfaces) || !r.interfaces.every((i) => INTERFACES.has(i))) return null;
    supports[kind as InfraKind] = {
      capabilities: new Set(r.capabilities),
      interfaces: new Set(r.interfaces as LoomInterface[]),
    };
  }

  let configKeys: ConfigKeySchema[] | undefined;
  if (s.configKeys !== undefined) {
    if (!Array.isArray(s.configKeys)) return null;
    configKeys = [];
    for (const raw of s.configKeys) {
      if (typeof raw !== "object" || raw === null) return null;
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string" || typeof c.type !== "string" || !CONFIG_TYPES.has(c.type)) {
        return null;
      }
      configKeys.push({
        name: c.name,
        type: c.type as ConfigKeyType,
        ...(typeof c.required === "boolean" ? { required: c.required } : {}),
        ...(isStringArray(c.values) ? { values: c.values } : {}),
      });
    }
  }

  return { name: s.name, supports, ...(configKeys ? { configKeys } : {}) };
}

/** Scan `packagesDir` one level deep for sourceType plugins, register
 *  each into the registry, and return the registered sourceType names. */
export function discoverSourceTypePlugins(packagesDir: string): string[] {
  if (!existsSync(packagesDir)) return [];
  const registered: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const descriptor = parseSourceTypePlugin((parsed as Record<string, unknown>).loom);
    if (!descriptor) continue; // not a sourceType plugin (or malformed) — skip
    registerSourceType(descriptor);
    registered.push(descriptor.name);
  }
  return registered;
}

/** Boot-time wiring — registers every `packagesDir/*` sourceType plugin. */
export function bootSourceTypePlugins(packagesDir: string): void {
  discoverSourceTypePlugins(packagesDir);
}
