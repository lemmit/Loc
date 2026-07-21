// node/Hono emission of the query-time projection `requires` gate — a
// 403-before-query check (`ForbiddenError`) mapped to HTTP 403, the read-side
// twin of the find gate.  A gated projection reads `currentUser` and throws
// before the repo call; an ungated sibling has no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    user { id: string role: string }
    subdomain D { context C {
      aggregate Order { status: string }
      repository Orders for Order { }
      projection AdminOrders {
        status: string
        from Order as o requires currentUser.role == "admin"
        select status = o.status
      }
      projection LiveOrders {
        status: string
        from Order as o where o.status == "open"
        select status = o.status
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    api Api from D
    deployable api { platform: node  contexts: [C]  dataSources: [cState]  serves: Api  port: 3000  auth: required }
  }
`;

let cache: Map<string, string> | undefined;
async function routes(): Promise<string> {
  cache ??= (await generateSystems(await parseValid(SRC))).files;
  const k = [...cache.keys()].find((key) => key.endsWith("http/query-projections.ts"));
  expect(k, "query-projections.ts not emitted").toBeDefined();
  return cache.get(k!)!;
}

function handlerBody(src: string, projName: string): string {
  // Each route is `app.openapi(createRoute({ … operationId: "projection<Name>" …`.
  const marker = `operationId: "projection${projName}"`;
  const start = src.indexOf(marker);
  expect(start, `route ${projName} not found`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("app.openapi(", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("node/Hono projection `requires` gate emission", () => {
  it("a gated projection reads currentUser and throws 403 before the query", async () => {
    const r = await routes();
    const body = handlerBody(r, "AdminOrders");
    expect(body).toContain('.get("currentUser")');
    expect(body).toMatch(
      /if \(!\(currentUser\.role === "admin"\)\) throw new ForbiddenError\("Forbidden"\);/,
    );
    // The gate precedes the repo read.
    expect(body.indexOf("ForbiddenError")).toBeLessThan(body.indexOf("new OrderRepository"));
  });

  it("only the gated projection emits a `throw new ForbiddenError` (LiveOrders is ungated)", async () => {
    const r = await routes();
    // The shared onError block references `err instanceof ForbiddenError`; the
    // GATE is the only `throw new ForbiddenError`, and there is exactly one.
    const throws = r.match(/throw new ForbiddenError\("Forbidden"\)/g) ?? [];
    expect(throws.length).toBe(1);
    // LiveOrders' handler (up to its repo read) carries no gate.
    const live = handlerBody(r, "LiveOrders");
    const liveGate = live.slice(0, live.indexOf("new OrderRepository"));
    expect(liveGate).not.toContain("ForbiddenError");
  });

  it("ForbiddenError maps to a 403 problem response", async () => {
    const r = await routes();
    expect(r).toContain(
      'if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);',
    );
  });
});
