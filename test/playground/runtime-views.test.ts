import { describe, expect, it } from "vitest";
import {
  firstRowsSql,
  LIST_USER_TABLES_SQL,
  quoteIdent,
  readUserTables,
  tableLabel,
} from "../../web/src/backend/tables-query.js";
import { overrideIdentity, parseDevStubIdentity, usersState } from "../../web/src/backend/users.js";
import {
  DISPATCH_FAILED,
  interpretBootError,
  interpretStatus,
  MIGRATIONS,
  TEST_DISCOVERY,
  VERDICT_LEGEND,
} from "../../web/src/layout/vocabulary.js";

// The Runtime tab's read-only Tables view + Users strip and the
// interpretation lines above every raw runtime error (M-T8.22 slices 2–3,
// audit M19).  Pure halves only — the React shells ride these.

describe("tables-query", () => {
  it("lists user tables across every non-system schema, base tables only", () => {
    expect(LIST_USER_TABLES_SQL).toContain("information_schema.tables");
    expect(LIST_USER_TABLES_SQL).toContain("table_type = 'BASE TABLE'");
    expect(LIST_USER_TABLES_SQL).toContain("'pg_catalog'");
    expect(LIST_USER_TABLES_SQL).toContain("'__loom'");
    // Not `public` only — system-mode backends put tables under `sales.` etc.
    expect(LIST_USER_TABLES_SQL).not.toMatch(/table_schema = 'public'/);
  });

  it("quotes identifiers so a hostile table name cannot escape the query", () => {
    expect(quoteIdent("products")).toBe('"products"');
    expect(quoteIdent('or"ders')).toBe('"or""ders"');
    expect(firstRowsSql("sales", "products")).toBe('SELECT * FROM "sales"."products" LIMIT 50;');
    expect(firstRowsSql("s", 't"; DROP TABLE x; --', 10)).toBe(
      'SELECT * FROM "s"."t""; DROP TABLE x; --" LIMIT 10;',
    );
    // A non-integer / non-positive limit falls back to the default.
    expect(firstRowsSql("s", "t", -1)).toContain("LIMIT 50");
    expect(firstRowsSql("s", "t", 2.5)).toContain("LIMIT 50");
  });

  it("reads the result rows and labels public tables bare", () => {
    const rows = readUserTables([
      { table_schema: "sales", table_name: "products" },
      { table_schema: "public", table_name: "notes" },
      { table_schema: 1, table_name: "bad" },
    ]);
    expect(rows).toEqual([
      { schema: "sales", name: "products" },
      { schema: "public", name: "notes" },
    ]);
    expect(tableLabel(rows[0]!)).toBe("sales.products");
    expect(tableLabel(rows[1]!)).toBe("notes");
  });
});

const DEV_STUB = `// Auto-generated.
import { registerUserVerifier } from "./verifier";

export function registerDevStubVerifier(): void {
  registerUserVerifier((req) => {
    const base = {
      sub: "admin",
      role: "admin",
      permissions: [],
      joinedAt: new Date(0),
      nickname: null,
    };
    const injected = req.headers.get("x-loom-dev-claims");
    if (!injected) return base;
    return base;
  });
}
`;

describe("users", () => {
  it("parses the generated dev stub's built-in identity", () => {
    expect(parseDevStubIdentity(DEV_STUB)).toEqual({
      sub: "admin",
      role: "admin",
      permissions: "[]",
      joinedAt: "new Date(0)",
      nickname: "null",
    });
    expect(parseDevStubIdentity("nothing here")).toBeNull();
  });

  it("reads the Auth-tab override exactly as the header would carry it", () => {
    expect(overrideIdentity({ enabled: false, claimsJson: '{"role":"agent"}' })).toBeNull();
    expect(overrideIdentity({ enabled: true, claimsJson: "not json" })).toBeNull();
    expect(overrideIdentity({ enabled: true, claimsJson: "[1]" })).toBeNull();
    expect(
      overrideIdentity({ enabled: true, claimsJson: '{"role":"agent","permissions":["a"]}' }),
    ).toEqual({
      role: "agent",
      permissions: '["a"]',
    });
  });

  it("reports stub identities, an OIDC verifier, or no identity at all", () => {
    const files = [
      { path: "api/src/auth/dev-stub.ts", content: DEV_STUB },
      { path: "api/src/index.ts", content: "" },
    ];
    const off = usersState(files, { enabled: false, claimsJson: "{}" });
    expect(off.kind).toBe("stub");
    expect(off.kind === "stub" && off.identities.map((i) => i.kind)).toEqual(["builtIn"]);

    const on = usersState(files, { enabled: true, claimsJson: '{"role":"agent"}' });
    expect(on.kind === "stub" && on.identities.map((i) => i.kind)).toEqual(["builtIn", "override"]);

    expect(
      usersState([{ path: "api/src/auth/oidc.ts", content: "" }], {
        enabled: true,
        claimsJson: "{}",
      }),
    ).toEqual({
      kind: "oidc",
    });
    expect(
      usersState([{ path: "api/src/index.ts", content: "" }], { enabled: true, claimsJson: "{}" }),
    ).toEqual({
      kind: "none",
    });
  });
});

describe("interpretation lines (audit M19)", () => {
  it("says what a status class means, in one sentence, and nothing for success", () => {
    expect(interpretStatus(200)).toBe("");
    expect(interpretStatus(201)).toBe("");
    expect(interpretStatus(500)).toMatch(/threw.*runtime logs/);
    expect(interpretStatus(503)).toMatch(/threw/);
    expect(interpretStatus(404)).toMatch(/No route matches/);
    expect(interpretStatus(401)).toMatch(/auth gate/);
    expect(interpretStatus(403)).toMatch(/auth gate/);
    expect(interpretStatus(400)).toMatch(/rejected the request body/);
    expect(interpretStatus(422)).toMatch(/rejected the request body/);
    expect(interpretStatus(409)).toMatch(/refused the request/);
    expect(DISPATCH_FAILED).toMatch(/never produced a response/);
  });

  it("classifies a boot failure by the phase its message names", () => {
    expect(interpretBootError("failed to fetch pglite.wasm")).toMatch(/WASM download failed/);
    expect(interpretBootError("OPFS data island is stale")).toMatch(/persisted rows/);
    expect(interpretBootError("RangeError: out of memory")).toMatch(/memory/);
    expect(interpretBootError("TypeError: x is not a function")).toMatch(
      /^Boot failed before the API came up/,
    );
  });

  it("the M8 / M9 / M19 copy is the vocabulary's, not a panel literal", () => {
    expect(MIGRATIONS.compareWith).toBe("Compare with");
    expect(MIGRATIONS.comparing("Last save")).toBe("Comparing the live source with Last save…");
    expect(MIGRATIONS.refresh).toBe("Refresh");
    expect(MIGRATIONS.destructiveFlag).toBe("--allow-destructive");
    expect(VERDICT_LEGEND).toContain("Untested = no test case covers it");
    expect(VERDICT_LEGEND).toContain("Unverified = covered, not yet run");
    expect(TEST_DISCOVERY.errorHint(true)).toMatch(/dependencies — Generate, then Bundle first/);
    expect(TEST_DISCOVERY.errorHint(false)).toMatch(/dependencies — Tap Run first/);
  });
});
