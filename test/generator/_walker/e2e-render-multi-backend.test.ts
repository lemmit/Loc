// Multi-backend e2e expansion — Phase A Item 2 from
// `docs/old/plans/phase-a-platform-expansion-prereqs.md`.
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
    deployable honoApi { platform: node, contexts: [Banking], port: 3000 }
    deployable dotnetApi { platform: dotnet, contexts: [Banking], port: 3001 }
    deployable elixirApi { platform: elixir, contexts: [Banking], port: 4000 }
    deployable marketingApi { platform: node, contexts: [Promo], port: 3010 }
    ui WebUi { with scaffold(subdomains: [Accounts]) }
    deployable webApp { platform: static, targets: honoApi, ui: WebUi, port: 8080 }

    test e2e "create an account" against honoApi {
      let a = api.accounts.create({ balance: 0 });
      let read = api.accounts.getById(a);
      expect(read.balance).toBe(0);
    }

    test e2e "create a campaign" against marketingApi {
      let c = api.campaigns.create({ name: "Spring" });
      expect(c.name).toBe("Spring");
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

  it("every backend replay carries the /api prefix", async () => {
    const files = await generateSystemFiles(BANK_THREE_BACKEND);
    const e2e = files.get("e2e/Bank.e2e.test.ts")!;
    // Every backend now mounts its domain routes under the shared `/api`
    // base path — match each it()-block's POST URL specifically.
    expect(e2e).toMatch(
      /it\("create an account against elixir_api"[\s\S]*?__post\(`\$\{base\}\/api\/accounts`/,
    );
    expect(e2e).toMatch(
      /it\("create an account against hono_api"[\s\S]*?__post\(`\$\{base\}\/api\/accounts`/,
    );
    expect(e2e).toMatch(
      /it\("create an account against dotnet_api"[\s\S]*?__post\(`\$\{base\}\/api\/accounts`/,
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

const TO_THROW = `
  system Pay {
    subdomain Accounts {
      context Banking {
        aggregate Account {
          balance: int
          invariant balance >= 0
          derived display: string = "acct"
        }
        repository Accounts for Account { }
      }
    }
    deployable honoApi { platform: node, contexts: [Banking], port: 3000 }

    test e2e "negative balance is rejected" against honoApi {
      expect(api.accounts.create({ balance: -1 })).toThrow(400)
    }
    test e2e "missing account is 404" against honoApi {
      expect(api.accounts.getById("nope")).toThrow(404)
    }
    test e2e "bare toThrow keeps an unconstrained throw" against honoApi {
      expect(api.accounts.create({ balance: -1 })).toThrow()
    }
  }
`;

describe("e2e expansion — toThrow status matcher", () => {
  it("lowers expect(call).toThrow(N) into a /→ N\\b/ regex on rejects.toThrow", async () => {
    const files = await generateSystemFiles(TO_THROW);
    const e2e = files.get("e2e/Pay.e2e.test.ts")!;
    expect(e2e, "e2e file missing").toBeDefined();
    // The create rejection pins 400; the missing-getById pins 404.
    expect(e2e).toMatch(/rejects\.toThrow\(\/→ 400\\b\/\)/);
    expect(e2e).toMatch(/rejects\.toThrow\(\/→ 404\\b\/\)/);
  });

  it("renders the inner throwing call (the matcher is peeled, not emitted on the fetch)", async () => {
    const files = await generateSystemFiles(TO_THROW);
    const e2e = files.get("e2e/Pay.e2e.test.ts")!;
    // The throwing call is wrapped in the rejects-assertion lambda; the status
    // never leaks onto the fetch call itself.
    expect(e2e).toMatch(/await expect\(async \(\) => \{ await __post\(`\$\{base\}\/api\/accounts`/);
  });

  it("a bare toThrow() (no status) emits an unconstrained rejects.toThrow()", async () => {
    const files = await generateSystemFiles(TO_THROW);
    const e2e = files.get("e2e/Pay.e2e.test.ts")!;
    expect(e2e).toMatch(/rejects\.toThrow\(\);/);
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

// ---------------------------------------------------------------------------
// Auth: an auth-required system rejects every unauthenticated request 401
// before it reaches the create/validation/not-found path the assertion pins.
// The generated harness forwards a bearer token from E2E_BEARER_TOKEN (set by
// the runner) on BOTH verbs, and sends no Authorization header when the var is
// unset — so an auth-less system's output is unaffected.
// ---------------------------------------------------------------------------
describe("e2e harness — bearer-token forwarding", () => {
  it("threads E2E_BEARER_TOKEN onto POST and GET, without hardcoding a provider", async () => {
    const e2e = (await generateSystemFiles(BANK_THREE_BACKEND)).get("e2e/Bank.e2e.test.ts")!;
    // The token is read from the env and only becomes an Authorization header
    // when present (auth-less runs send nothing).
    expect(e2e).toContain("const token = process.env.E2E_BEARER_TOKEN;");
    expect(e2e).toContain("return token ? { authorization: `Bearer ${token}` } : {};");
    // POST merges the auth header alongside content-type; GET carries it too.
    expect(e2e).toContain('headers: { "content-type": "application/json", ...__authHeaders() }');
    expect(e2e).toContain("await fetch(url, { headers: __authHeaders() });");
  });
});

const SAME_INSTANT = `
  system Log {
    subdomain S {
      context C {
        aggregate Entry with crudish {
          at: datetime
        }
        repository Entries for Entry { }
      }
    }
    deployable honoApi { platform: node, contexts: [C], port: 3000 }

    test e2e "instant round-trips regardless of wire format" against honoApi {
      let e = api.entries.create({ at: "2024-01-01T00:00:00Z" })
      let read = api.entries.getById(e)
      expect(read.at).toBeSameInstant("2024-01-01T00:00:00Z")
      expect(read.at).not.toBeSameInstant("2025-01-01T00:00:00Z")
    }
  }
`;

describe("e2e expansion — toBeSameInstant matcher", () => {
  it("lowers toBeSameInstant to instant-equality on Date.getTime() (format-agnostic)", async () => {
    const files = await generateSystemFiles(SAME_INSTANT);
    const e2e = files.get("e2e/Log.e2e.test.ts")!;
    expect(e2e, "e2e file missing").toBeDefined();
    // The wire value and the expected literal are both parsed to epoch ms, so a
    // `…00.0000000Z` vs `…00Z` format difference cannot fail the assertion.
    expect(e2e).toMatch(
      /expect\(new Date\(read\.at\)\.getTime\(\)\)\.toBe\(new Date\("2024-01-01T00:00:00Z"\)\.getTime\(\)\)/,
    );
    // Negation is preserved through the lowering.
    expect(e2e).toMatch(
      /expect\(new Date\(read\.at\)\.getTime\(\)\)\.not\.toBe\(new Date\("2025-01-01T00:00:00Z"\)\.getTime\(\)\)/,
    );
    // It never emits a bare `toBeSameInstant` (vitest has no such matcher).
    expect(e2e).not.toMatch(/toBeSameInstant/);
  });
});
