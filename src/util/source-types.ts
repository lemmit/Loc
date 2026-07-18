// The platform-internal sourceType registry — the single source of
// truth for what each technology family can do.  See
// `docs/old/proposals/resource-model-and-source-types.md` §3.4.
//
// A `sourceType` is built-in platform knowledge, never authored in
// `.ddd`.  For each infrastructure `kind` it supports, it declares the
// `capabilities` it offers and the `interfaces` through which that kind
// is reached.  This file is the *neutral descriptor* half of the
// registry; the *vendor realization* half (compose images, client
// libraries, migration dialects, connection wiring) stays in the
// platform adapters keyed by sourceType name.
//
// Layering: a foundational vocabulary module (`util/` altitude) — it
// type-imports only the IR vocabulary (`DataSourceKind`/`StorageKind`/
// `LoomInterface`) and is read across the pipeline: the language
// validators (`datasource.ts`), IR enrichment + validation, system
// composition, and the platform/generator resource-client adapters.
// Because `language/` consumes it, it cannot live under `ir/` without a
// backward `language → ir` value edge — hence its home here.  It must
// still NOT import any runtime value from `language/`, `generator/`, or
// `platform/`.
//
// Phase 1 note: the user-facing `kind:` keyword keeps its fine-grained
// values (`state`/`snapshot`/`replica`/`eventLog`/`cache`); those map to
// the coarse infra `kind` + a refining `capability` via
// `SURFACE_KIND_MAP`.  The registry is seeded to reproduce the previous
// hardcoded compatibility matrix exactly (relational stores back
// state/snapshot/replica; kv stores back cache; append stores back
// eventLog), so swapping it in for the old `KIND_STORAGE` tables is a
// behaviour-preserving change.

import type { DataSourceKind, LoomInterface, StorageKind } from "../ir/types/loom-ir.js";

export type { LoomInterface } from "../ir/types/loom-ir.js";

/** The coarse, infrastructure-level semantic role a source plays.
 *  This is the registry's primary key axis (RFC §3.5). */
export type InfraKind = "database" | "eventLog" | "cache" | "objectStore" | "queue" | "api";

/** What a sourceType offers for one infra kind. */
export interface KindSupport {
  /** Refining behaviours offered within the kind (RFC §3.5 capabilities). */
  readonly capabilities: ReadonlySet<string>;
  /** Valid access modes for this kind on this sourceType. */
  readonly interfaces: ReadonlySet<LoomInterface>;
}

/** Type vocabulary for a sourceType's `config` keys (RFC §8). */
export type ConfigKeyType = "string" | "number" | "boolean" | "enum" | "secret";

/** Schema for one generic `config` key a sourceType understands. */
export interface ConfigKeySchema {
  readonly name: string;
  readonly type: ConfigKeyType;
  readonly required?: boolean;
  /** Allowed values when `type` is `"enum"`. */
  readonly values?: readonly string[];
}

/** A built-in technology descriptor.  `name` matches a `StorageKind`
 *  (the `storage { type: … }` value). */
export interface SourceTypeDescriptor {
  readonly name: string;
  /** Per-infra-kind capabilities + interfaces.  A sourceType may
   *  support multiple kinds; interfaces are declared per kind, not
   *  globally (RFC §3.5). */
  readonly supports: Partial<Record<InfraKind, KindSupport>>;
  /** Allowed/required generic `config` keys (used from Phase 2). */
  readonly configKeys?: readonly ConfigKeySchema[];
}

/** Maps each user-facing `kind:` value to the coarse infra kind plus
 *  the refining capability (if any) it implies.  Keeping the surface
 *  keyword fine-grained while the registry reasons in infra kinds is
 *  the Phase-1 decision (RFC §3.5; plan "keep fine-grained kinds"). */
export const SURFACE_KIND_MAP: Record<
  DataSourceKind,
  { infraKind: InfraKind; capability?: string }
> = {
  state: { infraKind: "database", capability: "state" },
  snapshot: { infraKind: "database", capability: "snapshot" },
  replica: { infraKind: "database", capability: "replica" },
  eventLog: { infraKind: "eventLog" },
  cache: { infraKind: "cache" },
  objectStore: { infraKind: "objectStore" },
  queue: { infraKind: "queue" },
  api: { infraKind: "api" },
};

const set = <T>(...xs: T[]): ReadonlySet<T> => new Set(xs);

// ── Built-in registry ────────────────────────────────────────────────
//
// Seeded to reproduce the prior `validators/datasource.ts` matrix:
//   state/snapshot → postgres, mysql, sqlite, inMemory
//   replica        → postgres, mysql, sqlite       (NOT inMemory)
//   cache          → redis, inMemory
//   eventLog       → postgres, mysql, sqlite, inMemory, kafka
// elastic / meilisearch / clickhouse / bigquery parse + validate as
// storage types but bind to no kind today (empty `supports`), matching
// the old behaviour where no `KIND_STORAGE` row admitted them.

const RELATIONAL_DB: KindSupport = {
  capabilities: set("state", "snapshot", "replica", "crud", "query", "transactions"),
  interfaces: set<LoomInterface>("sql"),
};
const RELATIONAL_EVENTLOG: KindSupport = {
  capabilities: set("append", "read", "replay"),
  interfaces: set<LoomInterface>("sql"),
};

const REGISTRY = new Map<string, SourceTypeDescriptor>();

/** Register (or override) a sourceType descriptor.  The boot-time
 *  registration seam for out-of-tree sourceType plugins (RFC §8,
 *  Phase 3) pushes through here. */
export function registerSourceType(descriptor: SourceTypeDescriptor): void {
  REGISTRY.set(descriptor.name, descriptor);
}

/** Look up a sourceType descriptor by name (= `StorageKind`). */
export function sourceTypeFor(name: string): SourceTypeDescriptor | undefined {
  return REGISTRY.get(name);
}

/** All registered sourceType names, sorted. */
export function registeredSourceTypes(): string[] {
  return [...REGISTRY.keys()].sort();
}

function seedBuiltins(): void {
  registerSourceType({
    name: "postgres",
    supports: { database: RELATIONAL_DB, eventLog: RELATIONAL_EVENTLOG },
  });
  registerSourceType({
    name: "mysql",
    supports: { database: RELATIONAL_DB, eventLog: RELATIONAL_EVENTLOG },
  });
  registerSourceType({
    name: "sqlite",
    supports: { database: RELATIONAL_DB, eventLog: RELATIONAL_EVENTLOG },
  });
  registerSourceType({
    name: "inMemory",
    supports: {
      // inMemory backs state/snapshot but NOT replica (matches the old
      // matrix: replica → postgres/mysql/sqlite only).
      database: {
        capabilities: set("state", "snapshot", "crud", "query", "transactions"),
        interfaces: set<LoomInterface>("sql"),
      },
      eventLog: RELATIONAL_EVENTLOG,
      cache: { capabilities: set("get", "set", "ttl"), interfaces: set<LoomInterface>() },
    },
  });
  registerSourceType({
    name: "redis",
    supports: {
      cache: { capabilities: set("get", "set", "ttl"), interfaces: set<LoomInterface>() },
    },
  });
  registerSourceType({
    name: "kafka",
    supports: {
      eventLog: { capabilities: set("append", "read", "replay"), interfaces: set<LoomInterface>() },
    },
  });
  // Phase 2 kinds: object store, queue, external API.
  registerSourceType({
    name: "s3",
    supports: {
      objectStore: {
        capabilities: set("blob", "list", "signedUrl", "versioning"),
        interfaces: set<LoomInterface>("rest", "sdk"),
      },
    },
    configKeys: [
      { name: "region", type: "string" },
      { name: "bucket", type: "string", required: true },
      { name: "endpoint", type: "string" },
    ],
  });
  registerSourceType({
    name: "localDisk",
    supports: {
      objectStore: {
        // Dependency-free local-directory object store.  Stores raw bytes
        // keyed by object key; no signed URLs or versioning (those are
        // cloud-object-store features).  No required `bucket` config — the
        // store is a local data directory, not a remote bucket.
        capabilities: set("blob", "list"),
        interfaces: set<LoomInterface>("sdk"),
      },
    },
  });
  registerSourceType({
    name: "rabbitmq",
    supports: {
      queue: {
        capabilities: set("enqueue", "dequeue", "ack", "publish", "consume"),
        interfaces: set<LoomInterface>("amqp"),
      },
    },
    configKeys: [
      { name: "vhost", type: "string" },
      { name: "exchange", type: "string" },
    ],
  });
  registerSourceType({
    name: "restApi",
    supports: {
      api: { capabilities: set("request"), interfaces: set<LoomInterface>("rest") },
    },
    configKeys: [{ name: "baseUrl", type: "string", required: true }],
  });
  // Declared storage types with no kind binding today.
  for (const name of ["elastic", "meilisearch", "clickhouse", "bigquery"]) {
    registerSourceType({ name, supports: {} });
  }
}

seedBuiltins();

// ── Lookups ──────────────────────────────────────────────────────────

/** Does a storage of `sourceType` support the user-facing `kind`? */
export function supportsSurfaceKind(sourceType: string, kind: DataSourceKind): boolean {
  const descriptor = REGISTRY.get(sourceType);
  if (!descriptor) return false;
  const { infraKind, capability } = SURFACE_KIND_MAP[kind];
  const support = descriptor.supports[infraKind];
  if (!support) return false;
  return capability ? support.capabilities.has(capability) : true;
}

/** The sorted list of registered sourceTypes that support `kind` —
 *  used to render the "kind X requires a storage of type …" diagnostic. */
export function sourceTypesForSurfaceKind(kind: DataSourceKind): string[] {
  return [...REGISTRY.keys()].filter((name) => supportsSurfaceKind(name, kind)).sort();
}

/** A relational store is one offering the `database` kind over the
 *  `sql` interface — the set the `schema` / `tablePrefix` /
 *  `isolationLevel` knobs apply to. */
export function isRelational(sourceType: string): boolean {
  return REGISTRY.get(sourceType)?.supports.database?.interfaces.has("sql") ?? false;
}

/** A cache store is one offering the `cache` kind — the set the
 *  `keyPrefix` / `ttl` knobs apply to. */
export function isCacheStore(sourceType: string): boolean {
  return REGISTRY.get(sourceType)?.supports.cache != null;
}

/** The valid interfaces for `kind` on `sourceType` (empty when
 *  unsupported). */
export function interfacesFor(
  sourceType: string,
  kind: DataSourceKind,
): ReadonlySet<LoomInterface> {
  const descriptor = REGISTRY.get(sourceType);
  if (!descriptor) return new Set();
  return descriptor.supports[SURFACE_KIND_MAP[kind].infraKind]?.interfaces ?? new Set();
}

// Preference order when a (sourceType, kind) exposes more than one
// interface (RFC §3.5).  Native / operational transports rank first
// (sql for relational, amqp for queues), then SDK over raw REST for
// backend consumers (e.g. S3 prefers `sdk` over `rest`).  A consuming
// operation may override this once the workflow-level consumption
// surface exists (Phase 4); until then this is the resolved default.
const INTERFACE_PREFERENCE: readonly LoomInterface[] = [
  "sql",
  "amqp",
  "sdk",
  "rest",
  "graphql",
  "webSocket",
];

/** The default interface for `kind` on `sourceType` — the highest-
 *  ranked valid interface per {@link INTERFACE_PREFERENCE}, or
 *  `undefined` when the kind is unsupported. */
export function defaultInterfaceFor(
  sourceType: string,
  kind: DataSourceKind,
): LoomInterface | undefined {
  const valid = interfacesFor(sourceType, kind);
  return INTERFACE_PREFERENCE.find((i) => valid.has(i));
}

/** The capabilities a `sourceType` offers for `kind` (empty when
 *  unsupported) — the set a need's required capabilities must be a
 *  subset of (RFC §5). */
export function capabilitiesFor(sourceType: string, kind: DataSourceKind): ReadonlySet<string> {
  const descriptor = REGISTRY.get(sourceType);
  if (!descriptor) return new Set();
  return descriptor.supports[SURFACE_KIND_MAP[kind].infraKind]?.capabilities ?? new Set();
}

/** The config-key schema a sourceType understands (empty when none). */
export function configSchemaFor(sourceType: string): readonly ConfigKeySchema[] {
  return REGISTRY.get(sourceType)?.configKeys ?? [];
}

/** Narrowing helper: is `name` a known `StorageKind`?  (Kept here so
 *  callers can validate registry membership against the IR enum.) */
export function isKnownStorageKind(name: string): name is StorageKind {
  return REGISTRY.has(name);
}
