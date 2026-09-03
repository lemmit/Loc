// F2-ADP-5 — the WRITE-scope guard on ALL FOUR node saving shapes, on BOTH
// node adapters.
//
// The ledger row was filed against a probe in which only the RELATIONAL drizzle
// shape carried the guard: `shape: embedded`, `shape: document` and
// `persistedAs: eventLog` emitted a bare `findById` + not-found throw, so
// `policy { deny write on X }` was silently unenforced on the DEFAULT node
// adapter while MikroORM (the second adapter) enforced all four.  The emitters
// were brought to parity, but nothing on the node side pinned it: the
// shape-by-shape coverage that exists (`policy-write-scope-shapes.test.ts`)
// asserts python and java, and `policy-write-scope.test.ts` asserts only node's
// relational shape.  A regression on any blob shape here is an authorization
// hole that type-checks, so each shape is asserted on its own — and the
// REFUSAL is asserted, not merely that a `getById` exists.
//
// Two write scopes per adapter:
//   * the SENTINEL (`deny write`) — the predicate collapses to `false`, so the
//     command load must refuse without loading;
//   * a NARROWING scope (`allow deep` read over the fail-closed `local` write
//     floor) — a real predicate, pushed into a `where`/`count` pre-guard on the
//     queryable shapes and checked in-app over the rehydrated aggregate on the
//     blob ones.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const DRIZZLE = "node";
const MIKRO = "node { persistence: mikroorm }";

/** All four saving shapes under `policy { deny write on … }`. */
const denySystem = (platform: string) => `
  system WriteScopeShapesNode {
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

/** A NARROWING (non-sentinel) write scope: read `deep` (the orgPath subtree)
 *  over the fail-closed `local` write floor, on one blob shape and one
 *  queryable shape. */
const narrowSystem = (platform: string) => `
  system WriteScopeNarrowNode {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Doc shape: document, with tenantOwned, crudish { balance: int }
        aggregate Emb shape: embedded, with tenantOwned, crudish { balance: int }
        aggregate Org with tenantRegistry, crudish { name: string }
        repository Docs for Doc { }
        repository Embs for Emb { }
        repository Orgs for Org { }
        policy {
          allow deep on Doc
          allow deep on Emb
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

async function repoFile(source: string, agg: string): Promise<string> {
  const files = await generateSystemFiles(source);
  const suffix = `db/repositories/${agg}-repository.ts`;
  const hit = [...files.entries()].find(([p]) => p.endsWith(suffix));
  if (!hit) {
    throw new Error(
      `no generated file ends with ${suffix}; got:\n${[...files.keys()].sort().join("\n")}`,
    );
  }
  return hit[1];
}

/** The `async getById(...)` body — the command load every mutation route goes
 *  through.  Sliced so an assertion cannot be satisfied by the read path
 *  (`findById`, `findManyByIds`) further down the file. */
function getByIdBody(text: string): string {
  const start = text.indexOf("  async getById(");
  expect(start, "the repository emits no getById (the command load)").toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n  }", start);
  return text.slice(start, end + 4);
}

for (const [adapter, platform] of [
  ["drizzle", DRIZZLE],
  ["mikroorm", MIKRO],
] as const) {
  describe(`F2-ADP-5 — node/${adapter}: deny write is enforced on every saving shape`, () => {
    it("relational: the command load probes the write scope before hydrating", async () => {
      const body = getByIdBody(await repoFile(denySystem(platform), "rel"));
      // `deny` lowers to the unsatisfiable id IS NULL AND id IS NOT NULL pair,
      // so the pre-guard can never match and the load answers not-found.
      expect(body).toContain(adapter === "drizzle" ? "const inScope = await this.db" : "em.count(");
      expect(body).toContain("if (inScope");
      expect(body).toContain("throw new AggregateNotFoundError(`Rel ${id} not found`)");
    });

    it("embedded: the queryable root gets the same pre-guard the relational root has", async () => {
      const body = getByIdBody(await repoFile(denySystem(platform), "emb"));
      expect(body).toContain(adapter === "drizzle" ? "const inScope = await this.db" : "em.count(");
      expect(body).toContain("if (inScope");
      expect(body).toContain("throw new AggregateNotFoundError(`Emb ${id} not found`)");
    });

    it("document: the blob command load refuses without loading", async () => {
      const body = getByIdBody(await repoFile(denySystem(platform), "doc"));
      expect(body).toContain("// policy { deny write on Doc } — no row is in write scope.");
      expect(body).toContain("throw new AggregateNotFoundError(`Doc ${id} not found`)");
      // The refusal is unconditional — no path returns the row.
      expect(body).not.toContain("return found;");
    });

    it("event-sourced: same refusal on the folded stream", async () => {
      const body = getByIdBody(await repoFile(denySystem(platform), "es"));
      expect(body).toContain("// policy { deny write on Es } — no row is in write scope.");
      expect(body).toContain("throw new AggregateNotFoundError(`Es ${id} not found`)");
      expect(body).not.toContain("return found;");
    });

    it("deny WRITE leaves the READ path alone", async () => {
      // The read routes must still serve the row: this is a write-ladder
      // guard, not a read filter.
      const doc = await repoFile(denySystem(platform), "doc");
      expect(doc).toContain("async findById(");
    });
  });

  describe(`F2-ADP-5 — node/${adapter}: a NARROWING write scope`, () => {
    it("document: the predicate is checked in-app over the rehydrated aggregate", async () => {
      const body = getByIdBody(await repoFile(narrowSystem(platform), "doc"));
      expect(body).toContain("const currentUser = requireCurrentUser();");
      expect(body).toContain(
        "if (!(found.tenantId === currentUser.tenantId)) throw new AggregateNotFoundError(`Doc ${id} not found`);",
      );
    });

    it("embedded: the predicate is pushed into the pre-guard query", async () => {
      const body = getByIdBody(await repoFile(narrowSystem(platform), "emb"));
      expect(body).toContain("requireCurrentUser().tenantId");
      expect(body).toContain("if (inScope");
      expect(body).toContain("throw new AggregateNotFoundError(`Emb ${id} not found`)");
    });

    it("no write narrowing leaves the command load byte-identical (no guard)", async () => {
      const body = getByIdBody(await repoFile(narrowSystem(platform), "org"));
      expect(body).not.toContain("inScope");
      expect(body).not.toContain("no row is in write scope");
      expect(body).toContain("return found;");
    });
  });
}
