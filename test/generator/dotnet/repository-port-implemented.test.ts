// Emitter invariant: every member a .NET repository PORT declares has an
// implementation in the repository IMPL — on BOTH adapters and all four
// persistence shapes (F2-ADP-4).
//
// A missing member is `dotnet build` CS0535, invisible to every generator test
// that only asserts what one shape emits.  The shape matrix is the point: the
// write-scope member (`GetByIdForWriteAsync`, emitted on the port whenever the
// aggregate carries a `writeScopeFilter`) was implemented for relational,
// embedded and document and MISSED for `persistedAs: eventLog` on both
// adapters — byte-for-byte the same CS0535 #2613 closed for the dapper
// document path.  This gate walks the port instead of naming members, so the
// next shape (or the next port member) cannot be missed silently.

import { describe, expect, it } from "vitest";
import { plural } from "../../../src/util/naming.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

// One aggregate per persistence shape, all under a narrowed write ladder
// (`deny write` is the cheapest one) so every port grows the write-scope member.
const SRC = `
  system S {
    subdomain D { context C {
      event Opened { es: Es id, owner: string }
      event Bumped { es: Es id, amount: int }
      aggregate Rel { n: int
        operation bump(by: int) { n := n + by } }
      aggregate Emb shape: embedded { n: int
        operation bump(by: int) { n := n + by } }
      aggregate Doc shape: document { n: int
        operation bump(by: int) { n := n + by } }
      aggregate Es persistedAs: eventLog {
        owner: string
        balance: int
        create open(owner: string) { emit Opened { es: id, owner: owner } }
        operation bump(amount: int) { emit Bumped { es: id, amount: amount } }
        apply(e: Opened) { owner := e.owner  balance := 0 }
        apply(e: Bumped) { balance := balance + e.amount }
      }
      repository Rels for Rel { }
      repository Embs for Emb { }
      repository Docs for Doc { }
      repository Ess for Es { }
      policy { deny write on Rel  deny write on Emb  deny write on Doc  deny write on Es }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    resource cLog { for: C, kind: eventLog, use: primary }
    deployable d { platform: __PLATFORM__  contexts: [C]  dataSources: [cState, cLog]  port: 3000 }
  }
`;

const cache = new Map<string, Map<string, string>>();
async function files(platform: string): Promise<Map<string, string>> {
  let f = cache.get(platform);
  if (!f) {
    f = await generateSystemFiles(SRC.replace("__PLATFORM__", platform));
    cache.set(platform, f);
  }
  return f;
}

function file(f: Map<string, string>, suffix: string): string {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return f.get(key!)!;
}

/** Method names an emitted `interface I<Agg>Repository` declares — every
 *  `… Name(args);` line inside the interface body. */
function portMembers(src: string): string[] {
  const body = src.slice(src.indexOf("public interface"));
  return [...body.matchAll(/^\s{4}[\w<>?,.[\]\s]+?\s(\w+)\([^\n]*\);\s*$/gm)].map((m) => m[1]!);
}

/** Method names the emitted repository CLASS implements. */
function implMembers(src: string): string[] {
  return [...src.matchAll(/^\s{4}public (?:async )?[\w<>?,.[\]\s]+?\s(\w+)\(/gm)].map((m) => m[1]!);
}

describe.each([
  ["efcore", "dotnet"],
  ["dapper", "dotnet { persistence: dapper }"],
])("%s: repository impl covers every port member", (_adapter, platform) => {
  it.each(["Rel", "Emb", "Doc", "Es"])("%s", async (agg) => {
    const f = await files(platform);
    const port = file(f, `Domain/${plural(agg)}/I${agg}Repository.cs`);
    const impl = file(f, `Infrastructure/Repositories/${agg}Repository.cs`);
    const declared = portMembers(port);
    // Sanity: the port really does declare the write-scope member for this
    // shape, so an empty/failed parse can't make the assertion vacuous.
    expect(declared).toContain("GetByIdForWriteAsync");
    const implemented = new Set(implMembers(impl));
    for (const m of declared) expect([...implemented]).toContain(m);
  });
});
