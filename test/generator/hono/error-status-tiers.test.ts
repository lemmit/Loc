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
//   express reaches `app.onError` and maps by class — `DomainError → 422`
//   (RS-15: the request parsed and typechecked, so it is well-formed; it was
//   rejected on *semantics*, which RFC 9110 §15.5.21 spells 422, not 400.  The
//   floor differs from tier 1 only in carrying no per-field `errors[]` pointer),
//   `AggregateNotFoundError → 404`, `ForbiddenError → 403`,
//   `DisallowedError → 409`.
//
// Both tiers therefore answer 422; the two are distinguished by the `errors[]`
// extension, not by the status.  400 is left to genuinely MALFORMED input (an
// unparseable body).  This test locks both tiers in place.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `
system S {
  subdomain M {
    context Sales {
      aggregate Order with crudish {
        sku: string
        invariant sku.length > 0
        operation cancel() when sku.length > 0 {
          requires currentUser.role == "admin"
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
    expect(routes).toContain(`problem(403, "Forbidden"`);
    expect(routes).toContain(`problem(409, "Disallowed"`);
    expect(routes).toContain(`problem(422, "Unprocessable Entity"`);
    expect(routes).toContain(`problem(404, "Not Found"`);
    // …and NOT 400: a domain-floor rejection is never "malformed request".
    expect(routes).not.toContain(`problem(400`);
  });
  // The bug this catches, and why it needs its own test.  The `problem()`
  // helper's `status` parameter is a UNION LITERAL computed from the set of
  // statuses the emitter believes it emits — so it is a hand-maintained mirror
  // of the call sites, and the two can drift.  RS-15 moved the domain floor
  // 400 → 422 at the call site and left `400` in the union: the emitted TS then
  // failed `tsc --noEmit` with "Argument of type '422' is not assignable", on
  // EVERY project.  Nothing in the fast suite saw it — only the opt-in
  // `LOOM_TS_BUILD` gates compile emitted output, so the break reached CI.
  //
  // Checking union ⊇ calls is a pure string check over the emitted file, so it
  // runs in the fast suite and fails the moment the mirror drifts, whichever
  // direction a future change moves a status.
  it("every status passed to problem() is a member of its declared union", async () => {
    const files = await generateSystemFiles(SYSTEM);
    for (const [path, text] of files) {
      if (!path.endsWith(".routes.ts") && !path.endsWith(".ts")) continue;
      const decl = text.match(/const problem = \(status: ([^,]+),/);
      if (!decl) continue;
      const declared = new Set(
        decl[1]!
          .split("|")
          .map((t) => t.trim())
          .filter((t) => /^\d+$/.test(t)),
      );
      // Only literal call sites — a `problem(${expr}, …)` is emitted with its
      // status already resolved, so every call in the output is a literal.
      const called = [...text.matchAll(/\bproblem\((\d+),/g)].map((m) => m[1]!);
      const unlisted = [...new Set(called)].filter((c) => !declared.has(c));
      expect(unlisted, `${path}: problem() called with status(es) outside its union`).toEqual([]);
      // …and the mirror should not carry members it never uses either: an
      // unused literal is how a stale status survives a migration unnoticed.
      const unused = [...declared].filter((d) => !called.includes(d));
      expect(unused, `${path}: union declares status(es) problem() never emits`).toEqual([]);
    }
  });
});
