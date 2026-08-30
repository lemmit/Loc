// `policy { deny on X }` outranks an authored `ignoring *` on BOTH .NET
// adapters (F2-ADP-1).
//
// `ignoring` is the escape hatch for CAPABILITY filters (softDelete, the
// tenancy scope — docs/tenancy.md).  The `deny` carve-out is not one of those:
// it is an always-false sentinel appended to `contextFilters` by
// `applyPolicyDenies`, and deny wins.  Before this gate, `ignoring *` dropped
// the WHOLE filter list on both adapters — EF via the parameterless
// `.IgnoreQueryFilters()`, Dapper via `capabilityFilterSqlFor` returning null —
// so one authored `ignoring *` read served every row of a read-denied
// aggregate through a public route.  The other four backends keep the sentinel.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = (persistence: string) => `
  system S {
    capability softDeletable2 { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      criterion AnyCode() of Secret = this.code != ""
      aggregate Secret with softDeletable2 { code: string }
      repository SecretRepo for Secret {
        find allIgnoring(c: string): Secret[] where this.code == c ignoring *
        find normal(c: string): Secret[] where this.code == c
      }
      workflow Sweep {
        create(x: int) {
          let xs = SecretRepo.findAll(AnyCode()) ignoring *
          for o in xs { }
        }
      }
      policy { deny on Secret }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable d { platform: ${persistence}  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

const cache = new Map<string, Map<string, string>>();
async function files(persistence: string): Promise<Map<string, string>> {
  let f = cache.get(persistence);
  if (!f) {
    f = await generateSystemFiles(SRC(persistence));
    cache.set(persistence, f);
  }
  return f;
}

async function repo(persistence: string): Promise<string> {
  const f = await files(persistence);
  const key = [...f.keys()].find((k) =>
    k.endsWith("Infrastructure/Repositories/SecretRepository.cs"),
  );
  expect(key, "SecretRepository.cs not emitted").toBeDefined();
  return f.get(key!)!;
}

/** One emitted repository method, so an assertion about `allIgnoring` can't be
 *  satisfied by SQL/LINQ belonging to `normal`. */
function method(src: string, signatureFragment: string): string {
  const start = src.indexOf(signatureFragment);
  expect(start, `method ${signatureFragment} not emitted`).toBeGreaterThan(-1);
  const end = src.indexOf("\n    public ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("policy deny survives `ignoring *` — dapper", () => {
  const DAPPER = "dotnet { persistence: dapper }";

  it("`find … ignoring *` KEEPS the always-false deny conjunct", async () => {
    const all = method(await repo(DAPPER), "public async Task<List<Secret>> AllIgnoring(");
    expect(all).toContain("1 = 0");
  });

  it("`ignoring *` still drops the bypassable capability predicate", async () => {
    const all = method(await repo(DAPPER), "public async Task<List<Secret>> AllIgnoring(");
    expect(all).not.toContain("is_deleted = FALSE");
    // …while a plain read carries both conjuncts.
    const normal = method(await repo(DAPPER), "public async Task<List<Secret>> Normal(");
    expect(normal).toContain("is_deleted = FALSE");
    expect(normal).toContain("1 = 0");
  });

  it("a retrieval's runtime FilterBypass cannot drop the deny conjunct either", async () => {
    const run = method(
      await repo(DAPPER),
      "public async Task<IReadOnlyList<Secret>> RunFindAllByAnyCodeAsync(",
    );
    // The bypassable capability predicate stays guarded…
    expect(run).toContain(
      'if (!bypass.All && bypass.Capabilities?.Contains("softDeletable2") != true) __caps.Add("(is_deleted = FALSE)")',
    );
    // …the deny sentinel is added unconditionally.
    expect(run).toContain('__caps.Add("1 = 0")');
    expect(run).not.toMatch(/if \(!bypass\.All[^)]*\)[^\n]*__caps\.Add\("1 = 0"\)/);
  });
});

describe("policy deny survives `ignoring *` — efcore", () => {
  const EF = "dotnet";

  it("`ignoring *` never emits the parameterless IgnoreQueryFilters()", async () => {
    const src = await repo(EF);
    expect(src).not.toContain("IgnoreQueryFilters()");
  });

  it("`find … ignoring *` bypasses only the NAMED bypassable filters", async () => {
    const all = method(await repo(EF), "public async Task<List<Secret>> AllIgnoring(");
    expect(all).toContain('IgnoreQueryFilters(["IsDeletedFilter"])');
  });

  it("the deny filter is a query filter, so leaving it out of the list keeps it", async () => {
    const f = await files(EF);
    const key = [...f.keys()].find((k) => k.endsWith("Configurations/SecretConfiguration.cs"));
    expect(key, "SecretConfiguration.cs not emitted").toBeDefined();
    const cfg = f.get(key!)!;
    expect(cfg).toContain("HasQueryFilter");
    // The always-false sentinel is a NAMED filter whose name is NOT the one the
    // find bypasses — that is the whole mechanism.
    expect(cfg).toMatch(/HasQueryFilter\("(?!IsDeletedFilter)[^"]+", x => false\)/);
  });

  it("a retrieval's runtime `bypass.All` enumerates the bypassable filters only", async () => {
    const run = method(
      await repo(EF),
      "public async Task<IReadOnlyList<Secret>> RunFindAllByAnyCodeAsync(",
    );
    expect(run).toContain('if (bypass.All) __q = __q.IgnoreQueryFilters(["IsDeletedFilter"]);');
  });
});
