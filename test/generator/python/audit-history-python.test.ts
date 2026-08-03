// Entity history on Python/FastAPI — the read side of the `audited` trail
// (docs/audit.md).  The RUNTIME contract is proven by the behavioral leg
// (`node run-python.mjs audit-history` diffs the booted app's responses against
// the node-minted wire golden), and `ruff` + `mypy --strict` prove the emitted
// project is sound.  This suite is the fast per-PR net over the emission SHAPE,
// and specifically over the guards — a masking or scoping regression should
// fail here in seconds rather than waiting for a backend boot.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

/** Audited, with a masked field, a lifecycle stamp and a `versioned` counter —
 *  one of each thing the diff boundary has to suppress — plus a gated list read
 *  for history to inherit. */
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
  deployable api { platform: python  contexts: [C]  dataSources: [st]  serves: A  port: 8080  auth: required }
}`;

async function emit(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src);
  return generateSystems(model).files;
}

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

describe("entity history — python route surface", () => {
  it("serves GET /{id}/history off the derived find", async () => {
    const routes = fileEndingWith(await emit(MASKED), "app/http/employee_routes.py");
    expect(routes).toContain('@router.get("/{id}/history"');
    expect(routes).toContain("response_model=AuditEntryListResponse");
    expect(routes).toContain("__rows = await repo.history(EmployeeId(id))");
  });

  it("queries audit_records on the indexed (target_type, target_id) pair, oldest first", async () => {
    const repo = fileEndingWith(await emit(MASKED), "app/db/repositories/employee_repository.py");
    expect(repo).toContain('AuditRecordRow.target_type == "Employee"');
    expect(repo).toContain("AuditRecordRow.target_id == str(id)");
    expect(repo).toContain(".order_by(AuditRecordRow.at)");
  });

  it("emits the shared shape module once, with no aggregate knowledge in it", async () => {
    const mod = fileEndingWith(await emit(MASKED), "app/audit/history.py");
    expect(mod).toContain("class AuditEntry(BaseModel):");
    expect(mod).toContain("def audit_value_changed(");
    expect(mod).not.toContain("Employee");
  });

  it("keeps `history` off the domain-facing repository Protocol", async () => {
    // The audit trail is INFRASTRUCTURE on both sides: no domain code calls
    // `history` or `record_audit`, and putting either on the port would drag
    // `AuditRecordRow` into `app/domain/` — the layering inversion the port
    // exists to prevent (and which `mypy --strict` flags as an undefined name,
    // the port pool importing domain types only).
    const port = fileEndingWith(await emit(MASKED), "app/domain/repository_ports.py");
    expect(port).not.toContain("async def history");
    expect(port).not.toContain("AuditRecordRow");
  });
});

describe("entity history — python negative authz", () => {
  it("DROPS a masked field's change entry rather than redacting it", async () => {
    const routes = fileEndingWith(await emit(MASKED), "app/http/employee_routes.py");
    // Unmasked fields go through the unconditional loop; `salary` must not.
    expect(routes).toContain('for key in ("name",)');
    expect(routes).not.toContain('for key in ("name", "salary")');
    // Its entry is appended only inside the predicate guard, so a caller who
    // fails the predicate sees no entry at all — a redacted-but-present entry
    // would still disclose that it changed, when, and by whom.
    expect(routes).toMatch(
      /if _mask_user is not None and \([^\n]*\):\n(?:.*\n)*?\s+changes\.append\(\{"field": "salary"/,
    );
  });

  it("is fail-closed on an unauthenticated caller", async () => {
    const routes = fileEndingWith(await emit(MASKED), "app/http/employee_routes.py");
    // The NON-raising ambient getter: no principal → None → every masked entry
    // drops, same shape as `to_wire_masked`.
    expect(routes).toContain("_mask_user = current_user()");
    expect(routes).toContain("_mask_user is not None and");
  });

  it("scopes by entity reachability, so a filtered-out row 404s instead of leaking", async () => {
    const routes = fileEndingWith(await emit(MASKED), "app/http/employee_routes.py");
    const handler = routes.slice(routes.indexOf('@router.get("/{id}/history"'));
    // `audit_records` carries no tenant column, so there is nothing on it for a
    // capability filter to scope.  The handler resolves the ENTITY first —
    // `get_by_id` already carries every capability predicate — and only reads
    // the trail for a row this caller can see.
    expect(handler).toContain("await repo.get_by_id(EmployeeId(id))");
    expect(handler.indexOf("get_by_id")).toBeLessThan(handler.indexOf("repo.history"));
  });

  it("never lets a stamp, the version counter, or the id into the diff", async () => {
    const routes = fileEndingWith(await emit(MASKED), "app/http/employee_routes.py");
    const mapper = routes.slice(routes.indexOf("def _employee_audit_entry"));
    const keyLoop = mapper.slice(0, mapper.indexOf("return {"));
    expect(keyLoop).not.toContain("updated_at");
    expect(keyLoop).not.toContain("created_at");
    expect(keyLoop).not.toContain('"version"');
    expect(keyLoop).not.toContain('"id"');
  });
});

describe("entity history — aggregates that serve none", () => {
  it("emits no history route or module when nothing is audited", async () => {
    const files = await emit(MASKED.replace("aggregate Employee audited", "aggregate Employee"));
    expect([...files.keys()].some((p) => p.endsWith("app/audit/history.py"))).toBe(false);
    expect(fileEndingWith(files, "app/http/employee_routes.py")).not.toContain(
      '@router.get("/{id}/history"',
    );
  });
});
