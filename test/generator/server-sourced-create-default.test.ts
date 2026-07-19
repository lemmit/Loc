// Server-sourced create-path defaults — the BACKEND half of `now()` /
// `currentUser.*` field defaults (the sibling of the frontend `/prepare` tier
// in `server-sourced-default.test.ts`).
//
// A non-constant default can't ride the wire as a serializer `.default(...)`:
// a Zod default literal is evaluated ONCE at schema build (module load), so
// `.default(new Date())` freezes every omitted row to the server's boot time.
// Instead the field is wire-OPTIONAL and the create handler applies the
// per-request value (`body.X ?? now()` / `?? currentUser.*`) — authoritative
// server-side, so a raw client that omits the field still gets the real value.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const HONO = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: node contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
  }
`;

function routesOf(files: Map<string, string>): string {
  const hit = [...files.entries()].find(([k]) => k.endsWith("order.routes.ts"));
  if (!hit) throw new Error("no order.routes.ts");
  return hit[1];
}

describe("server-sourced create-path defaults — Hono", () => {
  it("a now() default is wire-optional and coalesced per-request (not a frozen wire default)", async () => {
    const routes = routesOf(await generateSystemFiles(HONO("createdAt: datetime = now()")));
    // Wire field is optional — NOT a boot-frozen `.default(new Date())`.
    expect(routes).toMatch(/createdAt:\s*z\.coerce\.date\(\)\.optional\(\)/);
    expect(routes).not.toMatch(/createdAt:[^\n]*\.default\(new Date\(\)\)/);
    // The factory coalesces the per-request value: omitted → a fresh `new Date()`.
    expect(routes).toMatch(
      /Order\.create\(\{[^}]*createdAt: body\.createdAt !== undefined \? body\.createdAt : new Date\(\)[^}]*\}\)/,
    );
  });

  it("a currentUser.* default binds the ambient principal and coalesces", async () => {
    const routes = routesOf(
      await generateSystemFiles(
        HONO("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
      ),
    );
    expect(routes).toMatch(/ownerId:\s*z\.string\(\)\.optional\(\)/);
    // The create handler binds the principal (same accessor the /prepare route uses).
    expect(routes).toMatch(/const currentUser = .*get\("currentUser"\)/);
    expect(routes).toMatch(
      /Order\.create\(\{[^}]*ownerId: body\.ownerId !== undefined \? body\.ownerId : currentUser\.tenantId[^}]*\}\)/,
    );
  });

  it("a CONSTANT default is unchanged — still a wire `.default(...)`", async () => {
    const routes = routesOf(await generateSystemFiles(HONO(`status: string = "draft"`)));
    expect(routes).toMatch(/status:\s*z\.string\(\)\.default\("draft"\)/);
    expect(routes).not.toMatch(/status:[^\n]*\.optional\(\)/);
  });
});

const DOTNET = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: dotnet contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
  }
`;

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files.entries()].find(([k]) => k.endsWith(suffix));
  if (!hit) throw new Error(`no file ending in ${suffix}`);
  return hit[1];
}

describe("server-sourced create-path defaults — .NET", () => {
  it("a now() default is a nullable optional request param, coalesced in the command", async () => {
    const files = await generateSystemFiles(DOTNET("createdAt: datetime = now()"));
    const dto = fileEndingWith(files, "Requests/OrderRequests.cs");
    // Nullable optional param (`= null`) — NOT a non-constant record default.
    expect(dto).toMatch(/record CreateOrderRequest\([\s\S]*string\? CreatedAt = null[\s\S]*\)/);
    const ctrl = fileEndingWith(files, "OrdersController.cs");
    // Per-request coalesce at the create command construction.
    expect(ctrl).toMatch(/request\.CreatedAt is null \? DateTime\.UtcNow : DateTime\.Parse\(request\.CreatedAt/);
  });

  it("a currentUser.* default coalesces to the ambient principal", async () => {
    const files = await generateSystemFiles(
      DOTNET("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
    );
    const dto = fileEndingWith(files, "Requests/OrderRequests.cs");
    expect(dto).toMatch(/string\? OwnerId = null/);
    const ctrl = fileEndingWith(files, "OrdersController.cs");
    expect(ctrl).toMatch(
      /request\.OwnerId is null \? RequestContext\.Current!\.CurrentUser!\.TenantId : request\.OwnerId/,
    );
  });

  it("a CONSTANT default is unchanged — still a C# record default", async () => {
    const files = await generateSystemFiles(DOTNET(`status: string = "draft"`));
    const dto = fileEndingWith(files, "Requests/OrderRequests.cs");
    expect(dto).toMatch(/string Status = "draft"/);
  });
});

const PYTHON = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: python contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
  }
`;

describe("server-sourced create-path defaults — Python", () => {
  it("a now() default is optional and coalesced per-request (not frozen at import)", async () => {
    const files = await generateSystemFiles(PYTHON("createdAt: datetime = now()"));
    const routes = fileEndingWith(files, "http/order_routes.py");
    // Optional model field — NOT a class-def-frozen `= datetime.now(UTC)`.
    expect(routes).toMatch(/createdAt:\s*datetime \| None = None/);
    expect(routes).not.toMatch(/createdAt:\s*datetime = datetime\.now/);
    // Per-request coalesce in the handler.
    expect(routes).toMatch(
      /created_at=body\.createdAt if body\.createdAt is not None else datetime\.now\(UTC\)/,
    );
    // The route imports UTC for the coalesce.
    expect(routes).toMatch(/from datetime import UTC, datetime/);
  });

  it("a currentUser.* default binds the request principal (no import-time NameError)", async () => {
    const files = await generateSystemFiles(
      PYTHON("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
    );
    const routes = fileEndingWith(files, "http/order_routes.py");
    // NOT `ownerId: str = current_user.tenant_id` (that AttributeErrors at import).
    expect(routes).toMatch(/ownerId:\s*str \| None = None/);
    expect(routes).toMatch(/current_user: User = request\.state\.current_user/);
    expect(routes).toMatch(
      /owner_id=body\.ownerId if body\.ownerId is not None else current_user\.tenant_id/,
    );
  });

  it("a CONSTANT default is unchanged — still a Pydantic field default", async () => {
    const files = await generateSystemFiles(PYTHON(`status: string = "draft"`));
    const routes = fileEndingWith(files, "http/order_routes.py");
    expect(routes).toMatch(/status:\s*str = "draft"/);
  });
});

const JAVA = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: java contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
  }
`;

describe("server-sourced create-path defaults — Java", () => {
  it("a now() default coalesces to Instant.now() in the create service", async () => {
    const files = await generateSystemFiles(JAVA("createdAt: datetime = now()"));
    const svc = fileEndingWith(files, "orders/OrderService.java");
    expect(svc).toMatch(
      /var createdAt = request\.createdAt\(\) != null \? Instant\.parse\(request\.createdAt\(\)\) : Instant\.now\(\)/,
    );
  });

  it("a currentUser.* default binds the accessor and coalesces", async () => {
    const files = await generateSystemFiles(
      JAVA("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
    );
    const svc = fileEndingWith(files, "orders/OrderService.java");
    // The accessor is injected and bound in the create method (was undefined before).
    expect(svc).toMatch(/private final CurrentUserAccessor currentUserAccessor;/);
    expect(svc).toMatch(/var currentUser = currentUserAccessor\.user\(\);/);
    expect(svc).toMatch(
      /var ownerId = request\.ownerId\(\) != null \? request\.ownerId\(\) : currentUser\.tenantId\(\)/,
    );
  });

  it("a now()-only default does NOT inject the user accessor", async () => {
    const files = await generateSystemFiles(JAVA("createdAt: datetime = now()"));
    const svc = fileEndingWith(files, "orders/OrderService.java");
    expect(svc).not.toMatch(/CurrentUserAccessor/);
  });
});

const ELIXIR = (field: string, extra = "") => `
  system S {
    ${extra}
    subdomain Sales {
      context Sales {
        aggregate Order with crudish {
          customerId: string
          ${field}
        }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    storage db { type: postgres }
    resource st { for: Sales, kind: state, use: db }
    deployable api { platform: elixir contexts: [Sales] dataSources: [st] serves: SalesApi port: 3000${extra ? " auth: required" : ""} }
  }
`;

describe("server-sourced create-path defaults — Elixir (Phoenix)", () => {
  it("a now() default coalesces into the wire params before the changeset", async () => {
    const files = await generateSystemFiles(ELIXIR("createdAt: datetime = now()"));
    const ctrl = fileEndingWith(files, "controllers/order_controller.ex");
    expect(ctrl).toMatch(
      /\|> Map\.put\("createdAt", params\["createdAt"\] \|\| DateTime\.utc_now\(\)\)/,
    );
    // A now()-only default needs no principal bind in the create action.
    expect(ctrl).not.toMatch(/def create\(conn, params\) do\n\s*current_user =/);
  });

  it("a currentUser.* default binds current_user and coalesces", async () => {
    const files = await generateSystemFiles(
      ELIXIR("ownerId: string = currentUser.tenantId", "user { tenantId: string }"),
    );
    const ctrl = fileEndingWith(files, "controllers/order_controller.ex");
    expect(ctrl).toMatch(/current_user = Map\.get\(conn\.assigns, :current_user\)/);
    expect(ctrl).toMatch(
      /\|> Map\.put\("ownerId", params\["ownerId"\] \|\| current_user\.tenant_id\)/,
    );
  });
});
