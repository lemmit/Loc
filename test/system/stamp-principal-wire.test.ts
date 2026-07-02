import { describe, expect, it } from "vitest";

import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// B17 — the persisted principal stamp keeps the DECLARED claim.
// B18 — stamp-target fields leave the inbound create DTO but stay in reads.
//
// Fixture: a `stamp onCreate { createdByRole := currentUser.role }` paired with
// a read `filter this.createdByRole == currentUser.role`.  For the round-trip
// (create as a role, read it back as that role) to succeed, the PERSISTED value
// must be the role STRING the filter compares — not the actor id.  Hono and
// Java used to collapse any `currentUser.*` stamp onto the actor id (a UUID),
// so the creator could never read their own row back; .NET/Python/Elixir were
// already correct.  This gates all five together.
//
// The same fixture drives B18: `createdByRole` is server-populated, so it must
// NOT be a client-writable create input (mass-assignment), yet it stays visible
// in read responses.  A plain field (`code`) is unaffected on both axes.
// ---------------------------------------------------------------------------

const SRC = `system RoleStamp {
  user { id: guid  role: string }
  capability ownerStamped {
    createdByRole: string
    filter this.createdByRole == currentUser.role
    stamp onCreate { createdByRole := currentUser.role }
  }
  subdomain D { context Shop {
    aggregate Order with crudish, ownerStamped { code: string }
    repository Orders for Order { }
  } }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable hono    { platform: node   contexts: [Shop] dataSources: [st] serves: A port: 8081 auth: required }
  deployable dotnetd { platform: dotnet contexts: [Shop] dataSources: [st] serves: A port: 8082 auth: required }
  deployable javad   { platform: java   contexts: [Shop] dataSources: [st] serves: A port: 8083 auth: required }
  deployable pythond { platform: python contexts: [Shop] dataSources: [st] serves: A port: 8084 auth: required }
  deployable elixird { platform: elixir contexts: [Shop] dataSources: [st] serves: A port: 8085 auth: required }
}
`;

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function find(files: Map<string, string>, re: RegExp): string {
  for (const [k, v] of files) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

describe("B17 — persisted principal stamp keeps the declared claim (role, not actor id)", () => {
  it("Hono renders the role claim, not ctx.actorId", async () => {
    const f = await build();
    const helper = find(f, /audit-stamp\.ts$/);
    expect(helper).toContain("createdByRole: requireCurrentUser().role");
    expect(helper).not.toContain("createdByRole: ctx.actorId");
    expect(helper).toContain('import { requireCurrentUser } from "../auth/middleware";');
  });

  it("Java persists the claim via a @PrePersist hook (not @CreatedBy/AuditorAware id)", async () => {
    const entity = find(await build(), /features\/orders\/Order\.java$/);
    expect(entity).toContain("@PrePersist");
    expect(entity).toContain("this.createdByRole = currentUser.role();");
    expect(entity).toContain("CurrentUserAccessor.current()");
    // The AuditorAware only fills the id — a role stamp must NOT ride @CreatedBy.
    expect(entity).not.toContain("@CreatedBy");
  });

  it(".NET stamps the role in the auditable interceptor (unchanged)", async () => {
    const interceptor = find(await build(), /AuditableInterceptor\.cs$/);
    expect(interceptor).toContain("CreatedByRole).CurrentValue = currentUser.Role");
  });

  it("Python stamps the role in the domain _stamp_on_create (unchanged)", async () => {
    const domain = find(await build(), /app\/domain\/order\.py$/);
    expect(domain).toContain("self._created_by_role = current_user.role");
  });

  it("Elixir stamps the role via changeset put_change (unchanged)", async () => {
    const repo = find(await build(), /shop\/order_repository\.ex$/);
    expect(repo).toContain("put_change(:created_by_role, current_user.role)");
  });
});

describe("B18 — stamp field out of the inbound create DTO, kept in reads", () => {
  it("Hono: create schema drops createdByRole; response keeps it; code unaffected", async () => {
    const routes = find(await build(), /http\/order\.routes\.ts$/);
    const create = routes.slice(routes.indexOf("const CreateOrderRequest"));
    const createBlock = create.slice(0, create.indexOf(".openapi"));
    expect(createBlock).toContain("code:");
    expect(createBlock).not.toContain("createdByRole");
    // Response still exposes the stamped field.
    expect(routes).toMatch(/OrderResponse = z\.object\(\{[^}]*createdByRole/s);
  });

  it(".NET: request record drops CreatedByRole; response keeps it", async () => {
    const req = find(await build(), /Requests\/OrderRequests\.cs$/);
    expect(req).toContain("record CreateOrderRequest");
    expect(req).toContain("Code");
    expect(req).not.toContain("CreatedByRole");
    const resp = find(await build(), /Responses\/OrderResponses\.cs$/);
    expect(resp).toContain("CreatedByRole");
  });

  it("Java: request record drops createdByRole; response record keeps it", async () => {
    const req = find(await build(), /features\/orders\/CreateOrderRequest\.java$/);
    expect(req).toContain("record CreateOrderRequest(String code)");
    expect(req).not.toContain("createdByRole");
    const resp = find(await build(), /features\/orders\/OrderResponse\.java$/);
    expect(resp).toContain("createdByRole");
  });

  it("Python: pydantic create model drops created_by_role; response keeps it", async () => {
    const routes = find(await build(), /app\/http\/order_routes\.py$/);
    const create = routes.slice(routes.indexOf("class CreateOrderRequest"));
    const createBlock = create.slice(0, create.indexOf("\n\n"));
    expect(createBlock).toContain("code:");
    expect(createBlock).not.toContain("created_by_role");
    expect(routes).toMatch(/class OrderResponse\(BaseModel\):[\s\S]*createdByRole/);
  });

  it("Elixir: create cast list drops :created_by_role; read response keeps it", async () => {
    const changeset = find(await build(), /shop\/order_changeset\.ex$/);
    expect(changeset).toContain("@all_fields [:code]");
    expect(changeset).not.toContain("created_by_role");
    const controller = find(await build(), /controllers\/order_controller\.ex$/);
    expect(controller).toContain('"createdByRole" => record.created_by_role');
  });
});
