// `persistence: dapper` renders hierarchical (deep/global) tenancy — the last
// `loom.dapper-unsupported` boundary, drained.
//
// The `deep`/`global` read level lowers to the materialized-path `authz-filter`
// SENTINEL.  It was never actually outside the Dapper SQL subset — the fragment
// is ordinary SQL.  What the adapter lacked was the PARAM BINDING: the
// sentinel's `currentUser.<claim>` reads live INSIDE its decision, not in an
// expression tree, and `collectFilterPrincipalRefs` did not descend into the
// node — so a rendered fragment would have named `@__cu_orgPath` with nothing
// to bind it.  The validator refused the whole feature instead.
//
// The two halves must therefore move TOGETHER, and that is what this suite
// pins: an emitted SQL fragment naming a parameter the surrounding `new { … }`
// does not supply is a RUNTIME Npgsql error ("parameter … not found"), which
// every compile tier — `dotnet build /warnaserror` included — is blind to.
//
// Runtime agreement (subtree scoping, the delimiter trap, the wildcard trap,
// the NULL-dataKey floor) is gated by the `tenancy-hierarchy` corpus fixture,
// which now reaches the dapper compile leg, and by `tenancy-e2e`.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

/** The shape of `test/fixtures/corpus/tenancy-hierarchy.ddd`: a `deep`
 *  aggregate, a `global` one, a `local` (default) one, and the registry. */
const SRC = `
  system S {
    user { id: guid  role: string  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain D {
      context C {
        aggregate Account with crudish, tenantOwned { label: string }
        aggregate Entry with crudish, tenantOwned { label: string }
        aggregate Memo with crudish, tenantOwned { label: string }
        repository Accounts for Account { }
        repository Entries for Entry { }
        repository Memos for Memo { }
        policy {
          allow deep on Account
          allow global on Entry
        }
      }
      context R {
        aggregate Org with crudish { name: string  implements tenantRegistry }
        repository Orgs for Org { }
      }
    }
    api A from D
    storage primary { type: postgres }
    resource s1 { for: C, kind: state, use: primary }
    resource s2 { for: R, kind: state, use: primary }
    deployable api {
      platform: dotnet { persistence: dapper }
      contexts: [C, R]
      dataSources: [s1, s2]
      serves: A
      port: 3000
      auth: required
    }
  }
`;

let cache: Map<string, string> | undefined;
async function repo(name: string): Promise<string> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  const key = [...cache.keys()].find((k) =>
    k.endsWith(`Infrastructure/Repositories/${name}Repository.cs`),
  );
  expect(key, `${name}Repository.cs not emitted`).toBeDefined();
  return cache.get(key!)!;
}

/** Every `@param` named inside a SQL string literal on this line. */
function paramsNamedInSql(line: string): string[] {
  const sql = line.match(/"([^"]*(?:SELECT|INSERT|UPDATE|DELETE)[^"]*)"/);
  return [...new Set([...(sql?.[1] ?? "").matchAll(/@(__cu_[A-Za-z0-9_]+)/g)].map((m) => m[1]!))];
}

describe("the deep/global subtree sentinel renders as SQL", () => {
  it("`allow deep` anchors at orgPath, descendant-or-self, with the tenant floor", async () => {
    const src = await repo("Account");
    expect(src).toContain(
      "(data_key IS NOT NULL AND (data_key = @__cu_orgPath OR starts_with(data_key, @__cu_orgPath || '.')))",
    );
    // The NULL-dataKey OR-fallback: a legacy row degrades to the flat floor.
    expect(src).toContain("(data_key IS NULL AND tenant_id = @__cu_tenantId)");
  });

  it("`allow global` anchors at rootOrg instead — the ROOT-subtree widening", async () => {
    const src = await repo("Entry");
    expect(src).toContain("starts_with(data_key, @__cu_rootOrg || '.')");
    expect(src).not.toContain("@__cu_orgPath");
  });

  it("`starts_with`, never LIKE — a claim carrying `_` or `%` must not widen", async () => {
    // The wildcard trap (`orgXa.leak` visible from `org_a` because `_` is a LIKE
    // metacharacter) is a CROSS-TENANT LEAK driven by a token value; binding the
    // claim stops injection, not pattern semantics.  `starts_with` has no
    // metacharacters at all.
    for (const agg of ["Account", "Entry"]) {
      const src = await repo(agg);
      expect(src, `${agg}: the subtree test must not be a LIKE pattern`).not.toMatch(
        /LIKE\s+@__cu_/,
      );
    }
  });

  it("the default (`local`) level stays the flat tenant floor — no subtree widening", async () => {
    const src = await repo("Memo");
    expect(src).toContain("tenant_id = @__cu_tenantId");
    expect(src).not.toContain("starts_with(");
  });
});

describe("every principal param the SQL names is bound in the same statement", () => {
  // The half that a compile gate cannot see.  A rendered fragment naming
  // `@__cu_orgPath` with no matching field in the `new { … }` object is a
  // runtime Npgsql error, and it is exactly the failure that kept this feature
  // behind a validator gate.
  it.each(["Account", "Entry", "Memo", "Org"])("%sRepository binds what it names", async (name) => {
    const src = await repo(name);
    const lines = src.split("\n").filter((l) => l.includes("new CommandDefinition("));
    expect(lines.length, `${name}: no Dapper commands emitted`).toBeGreaterThan(0);
    for (const line of lines) {
      for (const param of paramsNamedInSql(line)) {
        expect(
          line,
          `${name}: SQL names @${param} but the parameter object does not bind it`,
        ).toMatch(new RegExp(`\\b${param}\\s*=`));
      }
    }
  });
});

describe("the guid-id registry self-scope binds a parsed uuid, not the raw claim", () => {
  // `this.id == currentUser.tenantId` compares a `uuid` COLUMN to a `string`
  // CLAIM — the one comparison in the language whose two sides differ in SQL
  // type.  Bound as text it produced `42883: operator does not exist: uuid =
  // text` on every registry read (a 500 on the tenancy bootstrap path, and a
  // compile-clean one).  A DISTINCT param carries the parsed value, so the same
  // claim can still bind as text on the tenant floor elsewhere.
  it("uses its own `_uuid` param, parsed fail-closed", async () => {
    const src = await repo("Org");
    expect(src).toContain("id = @__cu_tenantId_uuid");
    expect(src).toContain("Guid.TryParse(RequestContext.Current!.CurrentUser!.TenantId, out _)");
    // Fail-CLOSED: a malformed / absent claim binds NULL, and `id = NULL`
    // matches nothing — the same stance as EF's hoisted self-scope member.
    expect(src).toContain(": null");
    // The raw text param must not be what the uuid column is compared against.
    expect(src).not.toMatch(/\bid = @__cu_tenantId\b(?!_uuid)/);
  });

  it("the tenant-owned aggregates still bind the SAME claim as text", async () => {
    // Both bindings coexist by construction — that is why the parsed one needs
    // its own param name.
    const src = await repo("Memo");
    expect(src).toContain("__cu_tenantId = RequestContext.Current!.CurrentUser!.TenantId");
    expect(src).not.toContain("__cu_tenantId_uuid");
  });
});
