// Hono reified criteria: a `retrieval` whose `where` is exactly a named
// `criterion` emits a module-level predicate function (`<name>Criterion`) —
// the functional analog of .NET's `Criterion<T>` — that the generated
// `run<Name>` method calls instead of inlining the predicate.  Behaviour is
// identical to the inline form (same Drizzle `where`), so cross-backend
// conformance parity is unaffected; only the code organisation differs.

import { describe, expect, it } from "vitest";
import { generateHono, generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer { active: bool  region: string  name: string }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name asc] }
  }
`;

describe("typescript generator — reified criteria (retrieval)", () => {
  it("emits a module-level criterion fn the run method calls", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/customer-repository.ts")!;
    // The predicate is reified once, outside the class.
    expect(repo).toMatch(
      /const inRegionCriterion = \(rgn: string\) => eq\(schema\.customers\.region, rgn\);/,
    );
    // run<Name> calls it instead of inlining the `where`.
    expect(repo).toMatch(/\.where\(inRegionCriterion\(rgn\)\)/);
    // The reified call is the only `where` form for this retrieval — no inline
    // duplicate of the predicate leaked through.
    expect(repo).not.toMatch(/\.where\(eq\(schema\.customers\.region, rgn\)\)/);
  });
});

// DEBT-24 — a criterion whose body references the principal (`currentUser`)
// reifies into the SAME module-level fn, but the fn is module-scoped and has no
// `currentUser` parameter, so binding it to the bare name emits an unbound
// reference that fails `tsc`.  The fn must resolve the principal through the
// ambient `requireCurrentUser()` accessor (the same one the capability-`filter`
// query-face uses).  Full system: the `user { }` shape makes `currentUser`
// lower to a `current-user` ref.
const PRINCIPAL_SYS = `
system Tenancy {
  user { id: guid  tenantId: string }
  subdomain Core {
    context Ledger {
      aggregate Account {
        tenantId: string
        balance: int
      }
      repository Accounts for Account { }
      criterion MyTenant of Account = tenantId == currentUser.tenantId
      retrieval MineRich(min: int) of Account { where: MyTenant sort: [balance desc] }
    }
  }
  api LedgerApi from Core
  storage primary { type: postgres }
  resource ledgerState { for: Ledger, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Ledger]
    dataSources: [ledgerState]
    serves: LedgerApi
    port: 4000
    auth: required
  }
}`;

describe("typescript generator — reified criteria principal binding (DEBT-24)", () => {
  it("binds currentUser through requireCurrentUser() in the criterion fn", async () => {
    const files = await generateSystemFiles(PRINCIPAL_SYS);
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("/db/repositories/account-repository.ts"),
    )?.[1];
    expect(repo).toBeDefined();
    // The module-level fn binds the ambient principal — no unbound `currentUser`.
    expect(repo!).toMatch(
      /const myTenantCriterion = \(\) => eq\(schema\.accounts\.tenantId, requireCurrentUser\(\)\.tenantId\);/,
    );
    expect(repo!).not.toMatch(/eq\(schema\.accounts\.tenantId, currentUser\.tenantId\)/);
    // The accessor is imported, and both the find and the retrieval consume the fn.
    expect(repo!).toMatch(/import \{ requireCurrentUser \} from "\.\.\/\.\.\/auth\/middleware";/);
    expect(repo!).toMatch(/\.where\(myTenantCriterion\(\)\)/);
  });
});
