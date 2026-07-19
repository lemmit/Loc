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
