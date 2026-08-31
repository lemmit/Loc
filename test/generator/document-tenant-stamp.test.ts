import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// The `onCreate` lifecycle stamps on the DOCUMENT write path — all backends.
//
// `tenantOwned` declares `tenantId := currentUser.tenantId` /
// `dataKey := currentUser.orgPath` as onCreate stamps.  Every backend lands
// them somewhere on the RELATIONAL path — node in `db/audit-stamp.ts`
// (`stampInsert`), java via a JPA `@PrePersist` hook, .NET via the EF
// `AuditableInterceptor`.  A `shape: document` aggregate reaches NONE of those:
// it is one opaque jsonb column, not an EF-tracked entity with mapped stamp
// columns and not a JPA entity at all.  So the stamps never ran and the row was
// written with an EMPTY tenantId — invisible to every principal INCLUDING ITS
// CREATOR, because the (correct) read filter compares `"" === currentUser
// .tenantId`.  A 201 create, then 404 on every read, update and destroy.
//
// Runtime-proven on the node behavioural leg; this is the unit-tier witness for
// all three.  Python already emitted `_stamp_on_create` and is the reference.
// Elixir refuses this crossing by name (`loom.context-filter-unsupported`).
//
// The gate that could NOT see it: the compile tiers (the emission type-checks
// either way) and `policy-document-inapp.test.ts`, which runs the predicate
// over FABRICATED rows that already carry a tenant.
// ---------------------------------------------------------------------------

const FIXTURE = resolve(import.meta.dirname, "..", "fixtures", "corpus", "policy-document.ddd");

/** The corpus fixture is a `__PLATFORM__`-tokenized TEMPLATE, not a source. */
const sourceFor = (platform: string): string =>
  readFileSync(FIXTURE, "utf8").replaceAll("__PLATFORM__", platform);

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `no emitted file ends with ${suffix}`).toBeDefined();
  return files.get(key as string) as string;
};

describe("document onCreate stamps — node", () => {
  it("stamps the doc payload on the INSERT branch, and only there", async () => {
    const files = await generateSystemFiles(sourceFor("node"));
    const repo = fileEndingWith(files, "db/repositories/thing-repository.ts");
    expect(repo).toContain('import { stampInsert } from "../audit-stamp";');
    expect(repo).toMatch(/\.insert\(schema\.things\)\.values\(\{[^}]*data: stampInsert\(data\)/);
    // `stampUpdate` STRIPS the create-only fields — right for a relational
    // partial `set`, catastrophic here where the whole blob is rewritten.
    expect(repo).not.toContain("stampUpdate");
  });
});

describe("document onCreate stamps — java", () => {
  let files: Map<string, string>;
  const load = async () => (files ??= await generateSystemFiles(sourceFor("java")));

  it("emits the stamp as a PLAIN method (no JPA hook fires on a POJO)", async () => {
    const thing = fileEndingWith(await load(), "features/things/Thing.java");
    expect(thing).toContain("void _stampOnCreate() {");
    expect(thing).toContain("this.tenantId = currentUser.tenantId();");
    expect(thing).toContain("this.dataKey = currentUser.orgPath();");
    // A document root is not a JPA entity — an @PrePersist annotation here
    // would never fire and would drag in a jakarta.persistence import.
    expect(thing).not.toContain("@PrePersist");
    expect(thing).not.toContain("jakarta.persistence");
  });

  it("calls it from the service's create path", async () => {
    const svc = fileEndingWith(await load(), "features/things/ThingService.java");
    expect(svc).toMatch(/Thing\.create\([^)]*\);\s*\n\s*aggregate\._stampOnCreate\(\);/);
  });
});

describe("document onCreate stamps — dotnet", () => {
  let files: Map<string, string>;
  const load = async () => (files ??= await generateSystemFiles(sourceFor("dotnet")));

  it("emits a null-safe stamp method on the aggregate", async () => {
    const thing = fileEndingWith(await load(), "Domain/Things/Thing.cs");
    expect(thing).toContain("internal void _StampOnCreate()");
    expect(thing).toContain("var currentUser = RequestContext.Current?.CurrentUser;");
    expect(thing).toContain("if (currentUser == null) return;");
    expect(thing).toContain("TenantId = currentUser.TenantId;");
  });

  it("calls it on the INSERT branch, BEFORE the snapshot is serialized", async () => {
    const repo = fileEndingWith(await load(), "Infrastructure/Repositories/ThingRepository.cs");
    expect(repo).toContain("if (__existing == null) aggregate._StampOnCreate();");
    // Ordering is load-bearing: serializing first would capture the unstamped
    // snapshot and the stamp would never reach the row.
    const stampAt = repo.indexOf("aggregate._StampOnCreate();");
    const serializeAt = repo.indexOf("JsonSerializer.Serialize(aggregate.ToSnapshot()");
    expect(stampAt).toBeGreaterThan(-1);
    expect(serializeAt).toBeGreaterThan(-1);
    expect(stampAt, "the stamp must precede serialization").toBeLessThan(serializeAt);
  });
});

describe("document onCreate stamps — python is the reference emission", () => {
  it("already stamped, and still does", async () => {
    const files = await generateSystemFiles(sourceFor("python"));
    const thing = fileEndingWith(files, "app/domain/thing.py");
    expect(thing).toContain("def _stamp_on_create(self, current_user: User) -> None:");
    expect(thing).toContain("self._tenant_id = current_user.tenant_id");
  });
});

describe("document onCreate stamps — node/mikroorm (the SIXTH emission site)", () => {
  // `persistence: mikroorm` is a SEPARATE document-repository emitter
  // (emit/mikroorm.ts), not the drizzle builder.  It carried the same bug, and
  // nothing caught it until `policy-document` gained a `test e2e`: that caller
  // runs on EVERY behavioural leg, so `behavioral-mikroorm` went red while
  // drizzle passed.  Five sites had been checked by reading; the sixth was
  // found by running.
  const mikroormSource = (): string =>
    sourceFor("node").replace("platform: node", "platform: node { persistence: mikroorm }");

  it("stamps the doc payload on the INSERT branch, and only there", async () => {
    const files = await generateSystemFiles(mikroormSource());
    const repo = fileEndingWith(files, "db/repositories/thing-repository.ts");
    expect(repo).toContain('import { stampInsert } from "../audit-stamp";');
    expect(repo).toMatch(
      /em\.insert\(ThingRow, \{ id: aggregate\.id as string, data: stampInsert\(data\)/,
    );
    // The whole blob is rewritten on update, so a strip would delete the tenant.
    expect(repo).not.toContain("stampUpdate");
    expect(repo).toMatch(
      /nativeUpdate\(ThingRow, \{ id: aggregate\.id as string, version: expected \}, \{ data,/,
    );
  });
});

describe("document onCreate stamps — dotnet/dapper (the SEVENTH write path)", () => {
  // `persistence: dapper` is a THIRD .NET document emitter (emit/dapper.ts),
  // separate from EF.  Its save is a single `INSERT … ON CONFLICT DO UPDATE`
  // with no insert branch, so the stamp needs an explicit existence probe —
  // emitted ONLY when the aggregate has create claim stamps, so an unstamped
  // document aggregate keeps the single-statement upsert byte-identically.
  //
  // Found by `behavioral-e2e-dapper` going red on this PR while green on main.
  // The full enumeration of document write paths is drizzle, mikroorm, EF,
  // dapper, java, python, elixir — four needed the fix, python and elixir were
  // already correct.
  const dapperSource = (): string =>
    sourceFor("dotnet").replace("platform: dotnet", "platform: dotnet { persistence: dapper }");

  it("probes for existence and stamps a new row BEFORE serializing", async () => {
    const files = await generateSystemFiles(dapperSource());
    const repo = fileEndingWith(files, "Repositories/ThingRepository.cs");
    expect(repo).toContain("aggregate._StampOnCreate();");
    expect(repo).toContain("SELECT 1 FROM things WHERE id = @id");
    // Ordering is load-bearing: serializing first captures the unstamped
    // snapshot and the stamp never reaches the row.
    const stampAt = repo.indexOf("aggregate._StampOnCreate();");
    const serializeAt = repo.indexOf("Serialize(aggregate.ToSnapshot()");
    expect(stampAt).toBeGreaterThan(-1);
    expect(serializeAt).toBeGreaterThan(-1);
    expect(stampAt, "the stamp must precede serialization").toBeLessThan(serializeAt);
  });
});
