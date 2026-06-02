// Multi-backend e2e expansion — Phase A Item 2 from
// `docs/plans/phase-a-platform-expansion-prereqs.md`.
//
// Each `test e2e "..." against <deployable>` block must emit one
// `it("<name> against <slug>")` per BACKEND deployable whose
// `moduleNames` covers every aggregate the test body references.
// This guards the class of bug the retro records (Hono returning
// `{ id }` while .NET returned a full DTO; OpenAPI parity was blind
// to it) by replaying the same assertions against every compatible
// backend.
//
// What this file pins
// -------------------
// 1. A test referencing aggregates served by all 3 backends emits 3
//    `it()` blocks, one per backend, each pointed at the right
//    ENDPOINTS slug and apiBasePath prefix.
// 2. A test referencing an aggregate served by only ONE backend
//    emits exactly that one `it()` — no replay against backends
//    that don't own the module.
// 3. The expansion respects platform — React/static frontends are
//    skipped (no API to call).
// 4. The declared deployable is always included even if its modules
//    don't cover the referenced aggregates; the existing precise
//    `findAggregateBySlug` error surface still surfaces.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const BANK_THREE_BACKEND = `
  system Bank {
    subdomain Accounts {
      context Banking {
        aggregate Account {
          balance: int
          derived display: string = "acct"
          operation deposit(amount: int) { balance := balance + amount }
        }
        repository Accounts for Account { }
      }
    }
    subdomain Marketing {
      context Promo {
        aggregate Campaign {
          name: string
          derived display: string = name
        }
        repository Campaigns for Campaign { }
      }
    }
    deployable honoApi { platform: hono, contexts: [Banking], port: 3000 }
    deployable dotnetApi { platform: dotnet, contexts: [Banking], port: 3001 }
    deployable elixirApi { platform: phoenix, contexts: [Banking], port: 4000 }
    deployable marketingApi { platform: hono, contexts: [Promo], port: 3010 }
    ui WebUi { with scaffold(subdomains: [Accounts]) }
    deployable webApp { platform: static, targets: honoApi, ui: WebUi, port: 8080 }

    test e2e "create an account" against honoApi {
      let a = api.accounts.create({ balance: 0 });
      let read = api.accounts.getById(a);
      expect(read.balance == 0);
    }

    test e2e "create a campaign" against marketingApi {
      let c = api.campaigns.create({ name: "Spring" });
      expect(c.name == "Spring");
    }
  }
`;

describe("e2e expansion — multi-backend replay", () => {
  it("a test referencing an aggregate served by all 3 backends emits 1 it() per backend", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    expect(e2e, "e2e file missing").toBeDefined();
    // Three `it()`s for the account test — one per Accounts-serving backend.
    expect(e2e).toMatch(/it\("create an account against hono_api"/);
    expect(e2e).toMatch(/it\("create an account against dotnet_api"/);
    expect(e2e).toMatch(/it\("create an account against elixir_api"/);
  });

  it("each emitted it() points at the right ENDPOINTS slug", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    // Each replay binds `base` to its own ENDPOINTS entry.
    expect(e2e).toMatch(
      /it\("create an account against hono_api"[\s\S]*?const base = ENDPOINTS\.hono_api;/,
    );
    expect(e2e).toMatch(
      /it\("create an account against dotnet_api"[\s\S]*?const base = ENDPOINTS\.dotnet_api;/,
    );
    expect(e2e).toMatch(
      /it\("create an account against elixir_api"[\s\S]*?const base = ENDPOINTS\.elixir_api;/,
    );
  });

  it("Phoenix replay carries the /api prefix; Hono and .NET don't", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    // Phoenix routes API under `scope "/api"`.  Match the elixir_api
    // it()-block's POST URL specifically.
    expect(e2e).toMatch(
      /it\("create an account against elixir_api"[\s\S]*?__post\(`\$\{base\}\/api\/accounts`/,
    );
    // Hono and .NET serve at root.
    expect(e2e).toMatch(
      /it\("create an account against hono_api"[\s\S]*?__post\(`\$\{base\}\/accounts`/,
    );
    expect(e2e).toMatch(
      /it\("create an account against dotnet_api"[\s\S]*?__post\(`\$\{base\}\/accounts`/,
    );
  });

  it("a test referencing an aggregate served by only ONE backend emits one it()", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    // Only marketingApi serves the Marketing module → only one
    // `it()` for the campaign test.
    expect(e2e).toMatch(/it\("create a campaign against marketing_api"/);
    expect(e2e).not.toMatch(/it\("create a campaign against hono_api"/);
    expect(e2e).not.toMatch(/it\("create a campaign against dotnet_api"/);
    expect(e2e).not.toMatch(/it\("create a campaign against elixir_api"/);
  });

  it("frontend (react/static) deployables are excluded from replay even when modules nominally cover", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    // `webApp` is `platform: static` (targets honoApi).  Through the
    // `targets:` enrichment its `moduleNames` would inherit Accounts —
    // but isBackendPlatform skips frontends, so no `against web_app`
    // it() emits.
    expect(e2e).not.toMatch(/it\("create an account against web_app"/);
  });
});

describe("e2e expansion — count assertion", () => {
  it("Bank emits exactly 4 it()s — three backends for accounts + one for marketing", async () => {
    // Belt-and-suspenders count: anti-drift gate that catches the
    // case where a backend gets accidentally double-emitted, or a
    // referenced-but-uncovered backend silently sneaks in.
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    const itCount = (e2e.match(/^\s*it\(/gm) ?? []).length;
    expect(itCount).toBe(4);
  });
});
