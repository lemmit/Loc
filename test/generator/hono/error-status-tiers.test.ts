// Pins the SHIPPED two-tier error→status contract from
// `docs/old/proposals/validation-error-extension.md` on the reference (Hono)
// backend, so the route emitter can't silently drift from
// `src/util/error-defaults.ts`.
//
// Tier 1 — WIRE validation (Zod): a request that fails the schema is rejected
//   by the shared `defaultHook` with **422** ProblemDetails + per-field
//   `errors[]`.  This is the path a *field-mirrorable* `invariant`/`check`
//   takes (its rule is also a Zod refine), which is why showcase's negative
//   e2e cases assert `toThrow(422)`.
// Tier 2 — DOMAIN floor: an aggregate-level throw the wire validator can't
//   express reaches `app.onError` and maps by class — `DomainError → 400`
//   (by design: no per-field pointer), `AggregateNotFoundError → 404`,
//   `ForbiddenError → 403`, `DisallowedError → 409`.
//
// The reviewers read the 400 floor as a bug; it is the documented design.  This
// test locks both tiers in place.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system S {
  subdomain M {
    context Sales {
      aggregate Order with crudish {
        sku: string
        invariant sku.length > 0
        operation cancel() {
          requires currentUser.role == "admin"
          when sku.length > 0
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from M
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
  }
}
`;

describe("hono — two-tier error→status contract (validation-error-extension.md)", () => {
  it("tier 1: Zod validation failures map to 422 with per-field errors[]", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const problem = [...files.entries()].find(([p]) => p.endsWith("http/problem-details.ts"))?.[1];
    expect(problem, "problem-details.ts").toBeDefined();
    // The defaultHook rejects bad input with 422 + the §3.2 errors[] extension.
    expect(problem).toContain("status: 422");
    expect(problem).toContain("errors");
  });

  it("tier 2: the domain floor maps each error class to its documented status", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const routes = [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"))?.[1];
    expect(routes, "order.routes.ts").toBeDefined();
    // Each pairing mirrors src/util/error-defaults.ts; 400 is the DomainError
    // floor (intended, NOT 422).
    expect(routes).toContain(`problem(403, "Forbidden"`);
    expect(routes).toContain(`problem(409, "Disallowed"`);
    expect(routes).toContain(`problem(400, "Bad Request"`);
    expect(routes).toContain(`problem(404, "Not Found"`);
    // The domain floor never maps a throw to 422 — that status is reserved for
    // the wire-validation tier.
    expect(routes).not.toContain(`problem(422`);
  });
});
