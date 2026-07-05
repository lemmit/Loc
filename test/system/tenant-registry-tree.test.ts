// The `tenantRegistry` hierarchy capability (multi-tenancy Phase 2, plan P2.2)
// provides the registry tree fields — `parent: Self id?` (immutable self-FK,
// null = root) and the managed `dataKey` materialized path — and they flow
// through the shared MigrationsIR + wire projection with no bespoke code:
//   - `parent` → a nullable self-referential FK column + FK index,
//   - `dataKey` → a nullable text column,
//   - `parent` settable on create (immutable) but not update,
//   - `dataKey` off create/update inputs (managed) yet present on reads.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SRC = `
  system Billder {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Platform {
      context Accounts {
        aggregate Organization ids guid {
          name: string
          implements tenantRegistry
        }
        repository Organizations for Organization { }
      }
    }
    api PlatformApi from Platform
    storage primary { type: postgres }
    resource accountsState { for: Accounts, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Accounts]
      dataSources: [accountsState]
      serves: PlatformApi
      port: 3001
      auth: required
    }
  }
`;

describe("tenantRegistry — registry tree columns flow through migrations + wire", () => {
  it("emits a nullable self-FK `parent` column + FK constraint + index and a `data_key` text column", async () => {
    const files = await generateSystemFiles(SRC);
    const sql = [...files.entries()].find(
      ([p]) => p.endsWith(".sql") && p.includes("migrations"),
    )?.[1];
    expect(sql).toBeDefined();
    expect(sql!).toContain(`"parent" UUID NULL`);
    expect(sql!).toContain(`"data_key" TEXT NULL`);
    // Self-referential FK: parent → the organizations table itself.
    expect(sql!).toMatch(/FOREIGN KEY \("parent"\) REFERENCES "accounts"\."organizations"/);
    expect(sql!).toContain(`"organizations_parent_idx"`);
  });

  it("drizzle schema carries both columns", async () => {
    const files = await generateSystemFiles(SRC);
    const schema = files.get("api/db/schema.ts")!;
    expect(schema).toContain(`parent: uuid("parent")`);
    expect(schema).toContain(`dataKey: text("data_key")`);
  });

  it("`parent` is settable on create (immutable) but `dataKey` is not (managed)", async () => {
    const files = await generateSystemFiles(SRC);
    const domain = files.get("api/domain/organization.ts")!;
    // The public create factory takes `parent` but never `dataKey`.
    expect(domain).toMatch(/static create\(input: \{ name: string; parent\?/);
    expect(domain).not.toMatch(/static create\(input:[^)]*dataKey/);
  });

  it("`dataKey` is present on the read wire (managed = client read-only)", async () => {
    const files = await generateSystemFiles(SRC);
    const routes = files.get("api/http/organization.routes.ts")!;
    // The response schema exposes the managed path as a nullable string.
    expect(routes).toMatch(/dataKey: z\.string\(\)\.nullish\(\)/);
  });
});

// The registry's own `dataKey` is built in the author-written `signUp` create
// factory via the workflow-tier `repo-let` on the parent — the mechanism the
// P2.2 plan rides ("a mechanism that already exists").  The capability only
// PROVIDES the fields; the child-path computation (`dataKey := parent.dataKey +
// "." + <segment>`) is ordinary domain logic: load the parent, create the child
// with the immutable `parent` FK, set the managed `dataKey` off the parent's.
const SIGNUP_SRC = `
  system Billder {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Platform {
      context Accounts {
        aggregate Organization ids guid {
          name: string
          implements tenantRegistry
          operation setPath(seg: string) { dataKey := seg }
        }
        repository Organizations for Organization { }
        workflow signUpChild {
          create(nm: string, par: Organization id) {
            let loaded = Organizations.getById(par)
            let org = Organization.create({ name: nm, parent: par })
            org.setPath(loaded.dataKey + "." + nm)
          }
        }
      }
    }
    api PlatformApi from Platform
    storage primary { type: postgres }
    resource accountsState { for: Accounts, kind: state, use: primary }
    deployable api {
      platform: node
      contexts: [Accounts]
      dataSources: [accountsState]
      serves: PlatformApi
      port: 3001
      auth: required
    }
  }
`;

describe("tenantRegistry — dataKey built at signUp via workflow repo-let on the parent", () => {
  it("loads the parent, sets the immutable `parent` FK, and computes the managed `dataKey`", async () => {
    const files = await generateSystemFiles(SIGNUP_SRC);
    const wf = [...files.entries()].find(([p]) => p.includes("workflow"))?.[1];
    expect(wf).toBeDefined();
    // repo-let load of the parent row.
    expect(wf!).toMatch(/getById\(par\)/);
    // factory-let: the child carries the immutable self-FK from the create input.
    expect(wf!).toMatch(/Organization\.create\(\{ name: nm, parent: par \}\)/);
    // the managed dataKey is computed off the parent's path (materialized path).
    expect(wf!).toMatch(/setPath\(loaded\.dataKey \+ "\." \+ nm\)/);
  });
});
