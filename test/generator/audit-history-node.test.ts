// Entity history — the node/Hono read path (docs/audit.md).
//
// The assertions about MASKING and SCOPING here are the reason this endpoint
// needed a design rather than a route.  An audit row's `before`/`after`
// snapshots are written server-side inside the command's transaction, where
// there is no caller to mask against, so they hold raw values for every field.
// A history endpoint is therefore a read surface over already-collected
// unmasked data, and every guard the entity read has must be re-established on
// it explicitly — none of them come for free.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";

/** An audited aggregate with a masked field, a stamp, and a `versioned`
 *  counter — one of each thing the diff boundary must suppress. */
const MASKED = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate Employee audited with versioned, auditable {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
        create(name: string, salary: decimal) {
          name := name
          salary := salary
        }
        operation rename(name: string) { name := name }
      }
      repository Employees for Employee {
        find all(): Employee[] requires currentUser.role == "hr"
      }
    }
  }
  api A from M
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 8080  auth: required }
}`;

async function emitFiles(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src);
  return generateSystems(model).files;
}

const routesOf = (files: Map<string, string>, agg: string): string => {
  for (const [p, c] of files) if (p.endsWith(`http/${agg}.routes.ts`)) return c;
  throw new Error(`no routes file for ${agg}; have ${[...files.keys()].join(", ")}`);
};

describe("entity history — node route surface", () => {
  it("serves GET /{id}/history for an audited aggregate", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    expect(routes).toContain('path: "/{id}/history"');
    expect(routes).toContain("schema: z.array(AuditEntryResponse)");
    expect(routes).toContain("from(schema.auditRecords)");
    // Filtered on the pair the write side indexes, oldest first — a timeline
    // reads forwards.
    expect(routes).toContain('eq(schema.auditRecords.targetType, "Employee")');
    expect(routes).toContain("orderBy(schema.auditRecords.at)");
  });

  it("emits the shared shape module once, with no aggregate knowledge in it", async () => {
    const files = await emitFiles(MASKED);
    const mod = [...files].find(([p]) => p.endsWith("audit/history.ts"))?.[1];
    expect(mod).toBeDefined();
    expect(mod).toContain("export interface AuditEntry");
    expect(mod).toContain("export const AuditEntryResponse");
    expect(mod).toContain("export function auditValueChanged");
    // Shape-only: one copy serves every audited aggregate.
    expect(mod).not.toContain("Employee");
  });
});

describe("entity history — negative authz", () => {
  it("DROPS a masked field's change entry rather than redacting it", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    // The unmasked fields run through the unconditional loop...
    expect(routes).toContain('for (const key of ["name"])');
    // ...and `salary` is NOT among them.  A masked field must never reach the
    // always-emitted path.
    expect(routes).not.toContain('for (const key of ["name", "salary"])');
    // Its entry is pushed only inside the predicate guard — so a caller who
    // fails the predicate sees no entry at all.  "admin changed `salary` on the
    // 3rd" is itself the disclosure the mask exists to prevent; a redacted
    // placeholder would still make it.
    expect(routes).toMatch(
      /if \(currentUser !== null && \([^\n]*permissions[^\n]*\)\) \{[\s\S]*?field: "salary"[\s\S]*?\n {2}\}/,
    );
    // There is exactly one mention of the field name in the mapper — the
    // guarded push — and no redaction-style null assignment.
    expect(routes).not.toContain('field: "salary", before: null, after: null');
  });

  it("is fail-closed on an unauthenticated caller", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    // `?? null` → the guard's `currentUser !== null` short-circuits → every
    // masked entry drops.  Same fail-closed shape as `toWireMasked`.
    expect(routes).toContain('.get("currentUser") ?? null');
    expect(routes).toContain("currentUser !== null &&");
  });

  it("inherits the list read's gate — 403 before any query runs", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    const handler = routes.slice(routes.indexOf('path: "/{id}/history"'));
    expect(handler).toContain('403: { description: "Forbidden"');
    expect(handler).toContain('throw new ForbiddenError("Forbidden")');
    // The gate runs BEFORE the audit table is touched.
    expect(handler.indexOf("ForbiddenError")).toBeLessThan(handler.indexOf("schema.auditRecords"));
  });

  it("scopes by entity reachability, so a filtered-out row 404s instead of leaking", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    const handler = routes.slice(routes.indexOf('path: "/{id}/history"'));
    // `audit_records` carries no tenant column, so there is nothing on it for a
    // capability filter to scope.  The handler therefore resolves the ENTITY
    // first — `findById` already carries every capability predicate — and only
    // reads the trail for a row this caller can see.
    expect(handler).toContain("const __target = await repo.findById(Ids.EmployeeId(id));");
    expect(handler).toContain('if (!__target) throw new AggregateNotFoundError("not_found");');
    expect(handler.indexOf("repo.findById")).toBeLessThan(handler.indexOf("schema.auditRecords"));
  });

  it("never lets a stamp, the version counter, or the id into the diff", async () => {
    const routes = routesOf(await emitFiles(MASKED), "employee");
    const mapper = routes.slice(routes.indexOf("function employeeAuditEntry"));
    const keyLoop = mapper.slice(0, mapper.indexOf("return {"));
    // `auditable` stamps these post-save, `versioned` bumps `version` on every
    // command — left in, they would be most of the timeline.
    expect(keyLoop).not.toContain("updatedAt");
    expect(keyLoop).not.toContain("createdAt");
    expect(keyLoop).not.toContain('"version"');
    expect(keyLoop).not.toContain('"id"');
  });
});

describe("entity history — aggregates that serve none", () => {
  it("emits no history route, mapper or module when nothing is audited", async () => {
    const files = await emitFiles(
      MASKED.replace("aggregate Employee audited", "aggregate Employee"),
    );
    expect([...files.keys()].some((p) => p.endsWith("audit/history.ts"))).toBe(false);
    expect(routesOf(files, "employee")).not.toContain('path: "/{id}/history"');
  });
});
