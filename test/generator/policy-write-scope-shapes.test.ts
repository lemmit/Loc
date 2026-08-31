// F2-ADP-8 — the P3.1 WRITE-scope guard on the NON-RELATIONAL saving shapes.
//
// The relational (and, on python, the embedded) shape pushes the write scope
// into a SQL/JPQL pre-guard: a row the caller may READ but not WRITE reads as
// empty → 404.  The blob shapes (`shape: document`, `persistedAs: eventLog`)
// have no queryable columns to build that query over, and until this test they
// had NO guard at all:
//
//   - python emitted `get_by_id_for_write` as a documented ALIAS of the
//     read-scoped `get_by_id` ("the non-relational command load falls back to
//     the read-scoped load"), so `deny write on X` returned 200;
//   - java emitted no write-scoped load whatsoever on those two shapes —
//     `getById` (which IS the command load there: the read route calls
//     `findById`, every mutation calls `getById`) loaded read-scoped.
//
// Both now check the scope IN-APP over the loaded aggregate, the same place
// those shapes already evaluate their capability READ filters.  This is an
// authorization control, so each case asserts the REFUSAL is emitted, not
// merely that some method exists.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** All four saving shapes side by side under `policy { deny write on … }` —
 *  the sentinel case, where the in-app predicate collapses to `false` and the
 *  command load must refuse without loading. */
const denySystem = (platform: string) => `
  system WriteScopeShapes {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Rel with tenantOwned, crudish { balance: int }
        aggregate Doc shape: document, with tenantOwned, crudish { balance: int }
        aggregate Emb shape: embedded, with tenantOwned, crudish { balance: int }
        event EsOpened { es: Es id, balance: int }
        aggregate Es persistedAs: eventLog, crossTenant {
          balance: int
          create open(balance: int) { emit EsOpened { es: id, balance: balance } }
          destroy { }
          apply(e: EsOpened) { balance := e.balance }
        }
        aggregate Org with crudish { name: string }
        repository Rels for Rel { }
        repository Docs for Doc { }
        repository Embs for Emb { }
        repository Eses for Es { }
        repository Orgs for Org { }
        policy {
          deny write on Rel
          deny write on Doc
          deny write on Emb
          deny write on Es
        }
      }
    }
    api ShapesApi from S
    storage primarySql { type: postgres }
    resource shapesState { for: C, kind: state, use: primarySql }
    resource shapesLog { for: C, kind: eventLog, use: primarySql }
    deployable d {
      platform: ${platform}
      contexts: [C]
      dataSources: [shapesState, shapesLog]
      serves: ShapesApi
      port: 4000
      auth: required
    }
  }
`;

/** A NARROWING (non-sentinel) write scope on a document root: read `deep`
 *  (orgPath subtree) with the fail-closed `local` write floor, so the guard is
 *  a real predicate over the rehydrated aggregate rather than the `false`
 *  constant. */
const narrowSystem = (platform: string) => `
  system WriteScopeNarrow {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Doc shape: document, with tenantOwned, crudish { balance: int }
        aggregate Org with tenantRegistry, crudish { name: string }
        repository Docs for Doc { }
        repository Orgs for Org { }
        policy {
          allow deep on Doc
        }
      }
    }
    api NarrowApi from S
    storage primarySql { type: postgres }
    resource narrowState { for: C, kind: state, use: primarySql }
    deployable d {
      platform: ${platform}
      contexts: [C]
      dataSources: [narrowState]
      serves: NarrowApi
      port: 4000
      auth: required
    }
  }
`;

async function fileEndingWith(source: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) {
    throw new Error(
      `no generated file ends with ${suffix}; got:\n${[...files.keys()].sort().join("\n")}`,
    );
  }
  return hit[1];
}

describe("F2-ADP-8 — python write-scope guard on the non-relational shapes", () => {
  it("document: the command load refuses instead of aliasing the read load", async () => {
    const text = await fileEndingWith(
      denySystem("python"),
      "app/db/repositories/doc_repository.py",
    );
    expect(text).toContain("async def get_by_id_for_write");
    // The refusal itself — the whole point of the row.
    expect(text).toContain("# policy { deny write on Doc } — no row is in write scope.");
    // …and NOT the old documented fallback, which returned the readable row.
    expect(text).not.toContain("the non-relational command load falls back");
  });

  it("event-sourced: same refusal on the folded stream", async () => {
    const text = await fileEndingWith(denySystem("python"), "app/db/repositories/es_repository.py");
    expect(text).toContain("async def get_by_id_for_write");
    expect(text).toContain("# policy { deny write on Es } — no row is in write scope.");
    expect(text).not.toContain("the non-relational command load falls back");
  });

  it("embedded: the queryable root gets the same SQL pre-guard the relational root has", async () => {
    const text = await fileEndingWith(
      denySystem("python"),
      "app/db/repositories/emb_repository.py",
    );
    expect(text).toContain("async def get_by_id_for_write");
    expect(text).toContain("__ok = (await self._session.execute(select(EmbRow.id)");
    expect(text).not.toContain("the non-relational command load falls back");
  });

  it("a NARROWING document write scope checks the predicate in-app over the loaded aggregate", async () => {
    const text = await fileEndingWith(
      narrowSystem("python"),
      "app/db/repositories/doc_repository.py",
    );
    expect(text).toContain("async def get_by_id_for_write");
    expect(text).toContain("current_user = require_current_user()");
    expect(text).toContain("if not (found.tenant_id == current_user.tenant_id):");
    expect(text).toContain('raise AggregateNotFoundError(f"Doc {id} not found")');
  });

  it("no write-scope narrowing leaves the blob command loads byte-identical (no guard)", async () => {
    const files = await generateSystemFiles(narrowSystem("python"));
    const orgRepo = [...files.entries()].find(([p]) =>
      p.endsWith("app/db/repositories/org_repository.py"),
    );
    expect(orgRepo).toBeDefined();
    expect(orgRepo?.[1]).not.toContain("get_by_id_for_write");
  });
});

describe("F2-ADP-8 — java write-scope guard on the non-relational shapes", () => {
  it("document: getById (the command load) refuses instead of loading read-scoped", async () => {
    const text = await fileEndingWith(denySystem("java"), "features/docs/DocRepositoryImpl.java");
    expect(text).toContain("public Doc getById(DocId id) {");
    expect(text).toContain("// policy { deny write on Doc } — no row is in write scope.");
    // The read path is untouched — deny WRITE must not hide the row from reads.
    expect(text).toContain("public Optional<Doc> findById(DocId id) {");
  });

  it("event-sourced: same refusal on the folded stream", async () => {
    const text = await fileEndingWith(denySystem("java"), "features/eses/EsRepositoryImpl.java");
    expect(text).toContain("public Es getById(EsId id) {");
    expect(text).toContain("// policy { deny write on Es } — no row is in write scope.");
    expect(text).toContain("public Optional<Es> findById(EsId id) {");
  });

  it("a NARROWING document write scope checks the predicate in-app, fail-closed on a null principal", async () => {
    const text = await fileEndingWith(narrowSystem("java"), "features/docs/DocRepositoryImpl.java");
    expect(text).toContain("public Doc getById(DocId id) {");
    expect(text).toContain("var currentUser = currentUserAccessor.user();");
    expect(text).toContain(
      "if (currentUser == null || !(Objects.equals(rec.tenantId(), currentUser.tenantId())))",
    );
    // The in-app predicate renders `Objects.equals`, so the import must be
    // collected from the DESUGARED tree — a sentinel carries no expression
    // nodes, so collecting from the raw filter emitted uncompilable java.
    expect(text).toContain("import java.util.Objects;");
    // …and the accessor bean is injected even though no READ filter is the
    // reason for it here.
    expect(text).toContain("private final CurrentUserAccessor currentUserAccessor;");
  });

  it("no write-scope narrowing leaves the blob command load byte-identical (no guard)", async () => {
    const files = await generateSystemFiles(narrowSystem("java"));
    const orgRepo = [...files.entries()].find(([p]) =>
      p.endsWith("features/orgs/OrgRepositoryImpl.java"),
    );
    expect(orgRepo).toBeDefined();
    expect(orgRepo?.[1]).not.toContain("no row is in write scope");
  });
});
