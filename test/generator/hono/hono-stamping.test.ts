// ---------------------------------------------------------------------------
// Hono (node) backend — lifecycle stamps (`stamp onCreate`/`onUpdate`, the
// audit / softDelete capability stamps).  node-persist-time-auditing relocated
// stamping out of the domain method + handler into the drizzle persistence
// layer: a per-project `db/audit-stamp.ts` helper exposes `stampInsert` /
// `stampUpdate`, and the aggregate's `save()` wraps the write
// (`.values(stampInsert(...))` on the insert branch, `.set(stampUpdate(...))`
// on the update branch).  M-T3.4 — versioning is default-on, so the save is a
// guarded insert/update (not `.onConflictDoUpdate`); the stamps wrap each
// branch's row object all the same.  The principal comes from the ambient
// request context (`requestContext().actorId`); the domain entity is pure (no
// `_stampOn*`) and the route handler never stamps.  Principal-referencing
// stamps on a deployable WITHOUT auth and stamps on an event-sourced aggregate
// stay fail-fast gated (loom.node-stamp-unsupported), mirroring java / dotnet.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

// now()-only stamps (no principal) — no auth needed.
const SRC = `system AcmeStamp {
  subdomain D {
    context Shop {
      stamp onCreate { createdAt := now() }
      stamp onUpdate { updatedAt := now() }
      aggregate Order with crudish {
        code: string
        createdAt: datetime
        updatedAt: datetime
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 {
    platform: node
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;

// A `currentUser` stamp — requires auth (a request-scoped principal).
const PRINCIPAL_SRC = `system PrincipalStamp {
  user { id: guid  name: string }
  subdomain D {
    context Shop {
      stamp onCreate { createdBy := currentUser }
      aggregate Order with crudish {
        code: string
        createdBy: guid
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 {
    platform: node
    contexts: [Shop]
    dataSources: [st]
    serves: A
    port: 8081
    auth: required
  }
}
`;

// A CLAIM-valued principal stamp (`tenantId := currentUser.tenantId`) — the
// tenancy write side.  Must stamp the CLAIM read off the ambient principal;
// collapsing it to the actor id (`ctx.actorId`, a guid) would stamp a value
// the tenancy read filter (`requireCurrentUser().tenantId`) never matches.
const CLAIM_SRC = `system TenantStamp {
  user { id: guid  tenantId: string }
  subdomain D {
    context Ledger {
      stamp onCreate { tenantId := currentUser.tenantId }
      aggregate Account {
        tenantId: string internal
        balance: int
        filter this.tenantId == currentUser.tenantId
      }
      repository Accounts for Account { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Ledger, kind: state, use: primary }
  deployable api1 {
    platform: node
    contexts: [Ledger]
    dataSources: [st]
    serves: A
    port: 8081
    auth: required
  }
}
`;

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("Hono (node) generator — lifecycle stamps", () => {
  it("the domain entity is pure — no _stampOn* methods", async () => {
    const entity = find(await build(SRC), /domain\/order\.ts$/);
    expect(entity).not.toContain("_stampOnCreate");
    expect(entity).not.toContain("_stampOnUpdate");
    // The audit fields + getters remain (only the stamp methods are gone).
    expect(entity).toContain("get createdAt(): Date");
    expect(entity).toContain("get updatedAt(): Date");
  });

  it("emits a per-project audit-stamp helper that stamps insert (all) + update (mutable only)", async () => {
    const helper = find(await build(SRC), /db\/audit-stamp\.ts$/);
    expect(helper).toContain('import { requestContext } from "../obs/als";');
    // Request-scoped only — a non-request save (seed/system) returns the row
    // unstamped.
    expect(helper).toContain("if (!ctx) return row;");
    // now()-only stamps → `new Date()` on both branches; no actor (no auth).
    expect(helper).toContain("export function stampInsert");
    expect(helper).toContain("createdAt: new Date()");
    expect(helper).toContain("export function stampUpdate");
    // createdAt is stripped from the update result so the upsert `set` leaves
    // it immutable.
    expect(helper).toContain("const { createdAt: _createdAt, ...rest } = row;");
  });

  it("the save() guarded write stamps via stampInsert (values) + stampUpdate (set) — default-on (M-T3.4)", async () => {
    const repo = find(await build(SRC), /repositories\/order-repository\.ts$/);
    expect(repo).toContain('import { stampInsert, stampUpdate } from "../audit-stamp";');
    // Insert branch: the seeded row (version: 1) is wrapped by stampInsert.
    expect(repo).toMatch(
      /\.values\(stampInsert\(\{ id: aggregate\.id as string,[\s\S]*?version: 1 \}\)\)/,
    );
    // Update branch: the version-bumped row (version: expected + 1) is wrapped
    // by stampUpdate, and the write is guarded on the expected version.
    expect(repo).toMatch(
      /\.set\(stampUpdate\(\{ id: aggregate\.id as string,[\s\S]*?version: expected \+ 1 \}\)\)/,
    );
    expect(repo).toContain("eq(schema.orders.version, expected)");
  });

  it("neither the create route nor the update route stamps", async () => {
    const routes = find(await build(SRC), /order\.routes\.ts$/);
    expect(routes).not.toContain("_stampOnCreate");
    expect(routes).not.toContain("_stampOnUpdate");
    // The handler is just create → save.
    expect(routes).toMatch(
      /const created = Order\.create\(\{[^}]*\}\);\s*\n\s*await repo\.save\(created\);/,
    );
  });

  it("a currentUser stamp on an auth deployable reads the ambient actor in the helper", async () => {
    const files = await build(PRINCIPAL_SRC);
    // Entity stays pure even with a principal stamp — no User import for stamps.
    const entity = find(files, /domain\/order\.ts$/);
    expect(entity).not.toContain("_stampOnCreate");
    // The helper reads the principal from the ambient request context, not a
    // threaded currentUser param.
    const helper = find(files, /db\/audit-stamp\.ts$/);
    expect(helper).toContain("createdBy: ctx.actorId");
    // The route no longer reads currentUser for stamping (op body doesn't use it).
    const routes = find(files, /order\.routes\.ts$/);
    expect(routes).not.toContain("_stampOnCreate");
    expect(routes).not.toContain('.get("currentUser")');
  });

  it("a CLAIM-valued principal stamp reads the claim off the ambient principal, not the actor id", async () => {
    const helper = find(await build(CLAIM_SRC), /db\/audit-stamp\.ts$/);
    // The full principal is bound from the ambient context (typed via the
    // auth user shape) and a principal-less save stays unstamped.
    expect(helper).toContain('import type { User } from "../auth/user-types";');
    expect(helper).toContain("const currentUser = ctx.currentUser as User | null;");
    expect(helper).toContain("if (!currentUser) return row;");
    // The stamp is the CLAIM, not the actor id.
    expect(helper).toContain("tenantId: currentUser.tenantId");
    expect(helper).not.toContain("tenantId: ctx.actorId");
  });

  it("a BARE currentUser stamp keeps the actor-id shape (no principal binding)", async () => {
    const helper = find(await build(PRINCIPAL_SRC), /db\/audit-stamp\.ts$/);
    // Byte-identical to the pre-claim-fix output: actor id only, no full
    // principal bind, no User import.
    expect(helper).toContain("createdBy: ctx.actorId");
    expect(helper).not.toContain("ctx.currentUser");
    expect(helper).not.toContain("user-types");
  });

  it("gates a currentUser stamp on a deployable WITHOUT auth fail-fast", async () => {
    // Drop `auth: required` — a currentUser stamp then has no request-scoped
    // principal to thread.
    const noAuth = PRINCIPAL_SRC.replace("\n    auth: required", "");
    const loom = await buildLoomModel(noAuth);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.node-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });

  it("gates a lifecycle stamp on an event-sourced aggregate fail-fast", async () => {
    const es = `system EsStamp {
      subdomain D {
        context Shop {
          stamp onCreate { createdAt := now() }
          event OrderPlaced { code: string }
          aggregate Order persistedAs(eventLog) {
            code: string
            createdAt: datetime
            create place(code: string) {
              emit OrderPlaced { code: code }
            }
            apply(e: OrderPlaced) {
              code := e.code
            }
          }
          repository Orders for Order { }
        }
      }
      api A from D
      storage primary { type: postgres }
      resource el { for: Shop, kind: eventLog, use: primary }
      deployable api1 {
        platform: node
        contexts: [Shop]
        dataSources: [el]
        serves: A
        port: 8081
      }
    }`;
    const loom = await buildLoomModel(es);
    const errors = validateLoomModel(loom).filter((d) => d.code === "loom.node-stamp-unsupported");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("event-sourced");
  });
});
