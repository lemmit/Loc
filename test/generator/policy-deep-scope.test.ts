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
        aggregate Org ids guid {
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
