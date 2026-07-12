// `policy { allow deep on <Agg> }` — the `deep` read level (multi-tenancy
// Phase 2 P2.4) lowers the tenant-owned aggregate's floor to a materialized-
// path descendant-or-self scope (with the NULL-dataKey fallback to the flat
// tenant floor).  Pins that every one of the five domain-logic backends emits
// the widened filter into its query seam, and that `local` leaves the flat
// `tenantId ==` floor untouched.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const system = (platform: string, level: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Account with tenantOwned {
          balance: int
        }
        aggregate Org {
          name: string
          implements tenantRegistry
        }
        repository Accounts for Account { }
        repository Orgs for Org { }
        policy { allow ${level} on Account }
      }
    }
    api ShopApi from S
    storage primarySql { type: postgres }
    resource shopState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [C]
      dataSources: [shopState]
      serves: ShopApi
      port: 3001
      auth: required
    }
  }
`;

/** All emitted file contents joined — robust to per-backend path layout. */
async function allText(platform: string, level: string): Promise<string> {
  const files = await generateSystemFiles(system(platform, level));
  return [...files.values()].join("\n\n");
}

describe("policy deep — node (Hono/Drizzle)", () => {
  it("emits the descendant-or-self prefix + NULL fallback into the repository", async () => {
    const text = await allText("node", "deep");
    expect(text).toContain('.orgPath + ".%"');
    expect(text).toContain("isNotNull(");
    expect(text).toContain("isNull(");
  });

  it("`local` keeps the flat tenantId floor (no path prefix)", async () => {
    const text = await allText("node", "local");
    expect(text).not.toContain('.orgPath + ".%"');
  });
});

describe("policy deep — .NET (EF Core)", () => {
  it("emits a static-expressible StartsWith prefix + NULL fallback", async () => {
    const text = await allText("dotnet", "deep");
    expect(text).toContain(".StartsWith(");
    expect(text).toContain('.OrgPath + "."');
    expect(text).toContain(".DataKey == null");
  });
});

describe("policy deep — Python (FastAPI/SQLAlchemy)", () => {
  it("emits a startswith prefix + is_/isnot NULL fallback", async () => {
    const text = await allText("python", "deep");
    expect(text).toContain(".startswith(");
    expect(text).toContain(".org_path");
    expect(text).toContain(".isnot(None)");
  });
});

describe("policy deep — Java (Spring/JPA)", () => {
  it("emits the JPQL prefix (like concat) with the NULL fallback", async () => {
    const text = await allText("java", "deep");
    expect(text).toContain("like concat(");
    expect(text).toContain("dataKey is not null");
  });
});

describe("policy deep — Elixir (plain Ecto/Phoenix)", () => {
  it("emits the fail-closed LIKE fragment with the NULL fallback", async () => {
    const text = await allText("elixir", "deep");
    expect(text).toContain("fragment(");
    expect(text).toContain("LIKE ? || '.%'");
  });
});

// `policy { allow global on <Agg> }` (multi-tenancy Phase 2 P2.5) widens to the
// caller's ROOT-org SUBTREE: the same descendant-or-self prefix scan as `deep`,
// but anchored at `currentUser.rootOrg` (the first `orgPath` segment) instead of
// `orgPath`.  Structurally identical shape; only the anchor claim differs.

describe("policy global — node (Hono/Drizzle)", () => {
  it("emits the root-subtree prefix anchored at rootOrg (not orgPath)", async () => {
    const text = await allText("node", "global");
    expect(text).toContain('.rootOrg + ".%"');
    expect(text).not.toContain('.orgPath + ".%"');
    expect(text).toContain("isNotNull(");
    expect(text).toContain("isNull(");
  });
});

describe("policy global — .NET (EF Core)", () => {
  it("emits the StartsWith prefix anchored at RootOrg + NULL fallback", async () => {
    const text = await allText("dotnet", "global");
    expect(text).toContain(".StartsWith(");
    expect(text).toContain('.RootOrg + "."');
    expect(text).toContain(".DataKey == null");
  });
});

describe("policy global — Python (FastAPI/SQLAlchemy)", () => {
  it("emits the startswith prefix anchored at root_org + is_/isnot NULL fallback", async () => {
    const text = await allText("python", "global");
    expect(text).toContain(".startswith(");
    expect(text).toContain(".root_org");
    expect(text).toContain(".isnot(None)");
  });
});

describe("policy global — Java (Spring/JPA)", () => {
  it("emits the JPQL prefix anchored at rootOrg() with the NULL fallback", async () => {
    const text = await allText("java", "global");
    expect(text).toContain("like concat(");
    expect(text).toContain("rootOrg()");
    expect(text).toContain("dataKey is not null");
  });
});

describe("policy global — Elixir (plain Ecto/Phoenix)", () => {
  it("emits the fail-closed LIKE fragment anchored at root_org", async () => {
    const text = await allText("elixir", "global");
    expect(text).toContain("fragment(");
    expect(text).toContain("LIKE ? || '.%'");
    expect(text).toContain("current_user.root_org");
  });
});
