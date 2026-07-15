// ---------------------------------------------------------------------------
// Hono / Drizzle backend — the `versioned` capability turns the unconditional
// upsert into an optimistic-lock guarded write: an UPDATE conditioned on the
// client's expected `version` (threaded from the `If-Match` header, think-time
// CAS), 0 rows affected → `ConcurrencyError` → 409 Conflict with a distinct
// `conflict` catalog event.  As of M-T3.4 versioning is DEFAULT-ON: every plain
// (non-event-sourced) aggregate gains this guarded write with no `with
// versioned` in source, so the feature is present whether or not the capability
// is spelled out.
//
// Sibling of test/system/unique-index.test.ts (the 23505 → 409 mapping); this
// is the version-token → 409 mapping.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const nodeSystem = (cap: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer ${cap} {
          email: string
          name: string
          operation update(newName: string) { name := newName }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
    }
  }
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const entry = [...files.entries()].find(([p]) => p.endsWith(suffix));
  expect(entry, `${suffix} missing`).toBeDefined();
  return entry![1];
};

describe("hono/drizzle generator — versioned optimistic-concurrency", () => {
  it("repository save() guards the UPDATE on the expected version", async () => {
    const files = await generateSystemFiles(nodeSystem("with versioned"));
    const repo = fileEndingWith(files, "customer-repository.ts");

    // save() accepts the client's expected version (threaded from If-Match).
    expect(repo).toContain(
      "async save(aggregate: Customer, expectedVersion?: number): Promise<void> {",
    );
    expect(repo).toContain("const expected = expectedVersion ?? aggregate.version;");

    // Fresh row: plain insert seeding version: 1.
    expect(repo).toContain(
      "await tx.insert(schema.customers).values({ id: aggregate.id as string, email: aggregate.email, name: aggregate.name, version: 1 });",
    );

    // Existing row: UPDATE conditioned on id AND version, bumping to expected + 1.
    expect(repo).toContain("version: expected + 1");
    expect(repo).toContain(
      "eq(schema.customers.id, aggregate.id), eq(schema.customers.version, expected)",
    );
    expect(repo).toContain(".returning({ id: schema.customers.id })");

    // 0 rows → the CAS lost the race.
    expect(repo).toContain(
      'if (updated.length === 0) throw new ConcurrencyError("Customer", aggregate.id as string);',
    );
  });

  it("update route reads If-Match and threads it as the expected version", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(nodeSystem("with versioned")),
      "customer.routes.ts",
    );
    expect(routes).toContain('const ifMatch = c.req.header("if-match");');
    expect(routes).toContain(
      "const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : aggregate.version;",
    );
    expect(routes).toContain("await repo.save(aggregate, expectedVersion);");
  });

  it("onError maps ConcurrencyError to 409 Conflict with a distinct `conflict` event", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(nodeSystem("with versioned")),
      "customer.routes.ts",
    );
    expect(routes).toContain("ConcurrencyError");
    expect(routes).toContain("if (err instanceof ConcurrencyError) {");
    expect(routes).toContain('event: "conflict", aggregate: "Customer"');
    expect(routes).toContain('return problem(409, "Conflict", err.message);');
  });

  it("routes the version token onto reads but off create/update bodies", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(nodeSystem("with versioned")),
      "customer.routes.ts",
    );
    // Read response carries the version token.
    expect(routes).toMatch(
      /CustomerResponse = z\.object\(\{[\s\S]*?version: z\.number\(\)\.int\(\)/,
    );
    // Create/update inputs drop it (token access).
    const createReq =
      routes.match(/CreateCustomerRequest = z\.object\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
    const updateReq =
      routes.match(/UpdateCustomerRequest = z\.object\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(createReq).not.toContain("version");
    expect(updateReq).not.toContain("version");
  });

  it("an aggregate without `with versioned` still gets the guarded write — default-on (M-T3.4)", async () => {
    const files = await generateSystemFiles(nodeSystem(""));
    const repo = fileEndingWith(files, "customer-repository.ts");
    const routes = fileEndingWith(files, "customer.routes.ts");
    // Versioning is default-on: the guarded write + 409 arm appear without the
    // capability spelled out in source.
    expect(repo).toContain("ConcurrencyError");
    expect(repo).toContain("expectedVersion");
    expect(repo).toContain("version");
    expect(routes).toContain("ConcurrencyError");
    expect(routes).toContain("if-match");
    expect(routes).toContain('event: "conflict"');
  });
});
