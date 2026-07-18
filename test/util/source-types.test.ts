// Unit tests for the platform-internal sourceType registry.
//
// These pin the registry's equivalence with the prior hardcoded
// compatibility matrix in `validators/datasource.ts` (the matrix
// Step 1.5 replaces), so the swap-in is provably behaviour-preserving.

import { describe, expect, it } from "vitest";
import type { DataSourceKind } from "../../src/ir/types/loom-ir.js";
import {
  configSchemaFor,
  interfacesFor,
  isCacheStore,
  isRelational,
  registeredSourceTypes,
  registerSourceType,
  sourceTypeFor,
  sourceTypesForSurfaceKind,
  supportsSurfaceKind,
} from "../../src/util/source-types.js";

// The legacy matrix, transcribed verbatim from the pre-registry
// `validators/datasource.ts` for the equivalence assertions below.
const LEGACY: Record<DataSourceKind, string[]> = {
  state: ["postgres", "mysql", "sqlite", "inMemory"],
  snapshot: ["postgres", "mysql", "sqlite", "inMemory"],
  replica: ["postgres", "mysql", "sqlite"],
  cache: ["redis", "inMemory"],
  eventLog: ["postgres", "mysql", "sqlite", "inMemory", "kafka"],
};

describe("sourceType registry — matrix equivalence", () => {
  for (const kind of Object.keys(LEGACY) as DataSourceKind[]) {
    it(`sourceTypesForSurfaceKind('${kind}') matches the legacy matrix`, () => {
      expect(sourceTypesForSurfaceKind(kind)).toEqual([...LEGACY[kind]].sort());
    });
  }

  it("supportsSurfaceKind agrees with the legacy matrix across all known stores", () => {
    for (const sourceType of registeredSourceTypes()) {
      for (const kind of Object.keys(LEGACY) as DataSourceKind[]) {
        expect(supportsSurfaceKind(sourceType, kind)).toBe(LEGACY[kind].includes(sourceType));
      }
    }
  });

  it("inMemory backs state/snapshot but not replica", () => {
    expect(supportsSurfaceKind("inMemory", "state")).toBe(true);
    expect(supportsSurfaceKind("inMemory", "snapshot")).toBe(true);
    expect(supportsSurfaceKind("inMemory", "replica")).toBe(false);
  });

  it("search/analytics stores bind to no kind today", () => {
    for (const sourceType of ["elastic", "meilisearch", "clickhouse", "bigquery"]) {
      for (const kind of Object.keys(LEGACY) as DataSourceKind[]) {
        expect(supportsSurfaceKind(sourceType, kind)).toBe(false);
      }
    }
  });
});

describe("sourceType registry — knob classification", () => {
  it("isRelational matches the legacy RELATIONAL set", () => {
    const relational = registeredSourceTypes().filter(isRelational).sort();
    expect(relational).toEqual(["inMemory", "mysql", "postgres", "sqlite"]);
  });

  it("isCacheStore matches the legacy CACHE_STORES set", () => {
    const cache = registeredSourceTypes().filter(isCacheStore).sort();
    expect(cache).toEqual(["inMemory", "redis"]);
  });
});

describe("sourceType registry — descriptors & lookups", () => {
  it("relational stores reach database/eventLog over sql", () => {
    expect([...interfacesFor("postgres", "state")]).toEqual(["sql"]);
    expect([...interfacesFor("postgres", "eventLog")]).toEqual(["sql"]);
  });

  it("unknown sourceTypes support nothing", () => {
    expect(sourceTypeFor("nope")).toBeUndefined();
    expect(supportsSurfaceKind("nope", "state")).toBe(false);
    expect([...interfacesFor("nope", "state")]).toEqual([]);
  });

  it("built-ins carry no config schema yet", () => {
    expect(configSchemaFor("postgres")).toEqual([]);
  });

  it("seeds the Phase-2 kinds (objectStore/queue/api) on their sourceTypes", () => {
    expect(supportsSurfaceKind("s3", "objectStore")).toBe(true);
    expect(supportsSurfaceKind("rabbitmq", "queue")).toBe(true);
    expect(supportsSurfaceKind("restApi", "api")).toBe(true);
    // and not cross-wired
    expect(supportsSurfaceKind("s3", "queue")).toBe(false);
    expect(supportsSurfaceKind("postgres", "objectStore")).toBe(false);
    expect([...interfacesFor("s3", "objectStore")].sort()).toEqual(["rest", "sdk"]);
    expect(sourceTypeFor("s3")?.configKeys?.some((k) => k.name === "bucket" && k.required)).toBe(
      true,
    );
  });

  it("seeds the mailer kind (email) on smtp/ses/sendgrid", () => {
    for (const st of ["smtp", "ses", "sendgrid"]) {
      expect(supportsSurfaceKind(st, "mailer")).toBe(true);
      expect([...interfacesFor(st, "mailer")]).toEqual(["sdk"]);
      expect(sourceTypeFor(st)?.supports.email?.capabilities.has("send")).toBe(true);
      // `from` is a required config key on every mailer sourceType.
      expect(configSchemaFor(st).some((k) => k.name === "from" && k.required)).toBe(true);
    }
    // ses additionally accepts a region.
    expect(configSchemaFor("ses").some((k) => k.name === "region")).toBe(true);
    // not cross-wired: a mailer store backs no other kind, and a relational
    // store does not back mailer.
    expect(supportsSurfaceKind("smtp", "objectStore")).toBe(false);
    expect(supportsSurfaceKind("postgres", "mailer")).toBe(false);
    expect(sourceTypesForSurfaceKind("mailer")).toEqual(["sendgrid", "ses", "smtp"]);
  });

  it("registerSourceType adds a descriptor that resolves through the lookups", () => {
    registerSourceType({
      name: "__test_objstore",
      supports: {
        objectStore: { capabilities: new Set(["blob"]), interfaces: new Set(["rest", "sdk"]) },
      },
      configKeys: [{ name: "bucket", type: "string", required: true }],
    });
    expect(sourceTypeFor("__test_objstore")?.supports.objectStore?.capabilities.has("blob")).toBe(
      true,
    );
    expect(configSchemaFor("__test_objstore")).toEqual([
      { name: "bucket", type: "string", required: true },
    ]);
  });
});
