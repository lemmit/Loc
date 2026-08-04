// Entity history on Java/Spring Boot — the read side of the `audited` trail
// (docs/audit.md).  The RUNTIME contract is proven by the behavioral leg
// (`node run-java.mjs audit-history` diffs the booted app's responses against
// the node-minted wire golden) and `gradle testClasses bootJar` proves the
// emitted project compiles.  This suite is the fast per-PR net over the
// emission SHAPE, and specifically over the three guards — a masking or
// scoping regression should fail here in seconds rather than waiting for a
// backend boot.

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
  deployable api { platform: java  contexts: [C]  dataSources: [st]  serves: A  port: 8080  auth: required }
}`;

async function emit(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src);
  return generateSystems(model).files;
}

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

describe("entity history — java route surface", () => {
  it("serves GET /{id}/history off the derived find", async () => {
    const controller = fileEndingWith(await emit(MASKED), "EmployeesController.java");
    expect(controller).toContain('@GetMapping("/{id}/history")');
    expect(controller).toContain(
      "public List<AuditEntry> historyEmployee(@PathVariable UUID id) {",
    );
    expect(controller).toContain("return service.historyEmployee(new EmployeeId(id));");
  });

  it("queries audit_records on the indexed (target_type, target_id) pair, oldest first", async () => {
    const files = await emit(MASKED);
    const port = fileEndingWith(files, "AuditRecordRepository.java");
    // A Spring Data derived finder over exactly the pair the write side
    // indexes; `OrderByAtAsc` is the timeline's natural (forwards) scan order.
    expect(port).toContain(
      "List<AuditRecord> findByTargetTypeAndTargetIdOrderByAtAsc(String targetType, String targetId);",
    );
    const service = fileEndingWith(files, "EmployeeService.java");
    expect(service).toContain(
      'auditRecords.findByTargetTypeAndTargetIdOrderByAtAsc("Employee", id.value().toString())',
    );
  });

  it("emits the shared shape classes once, with no aggregate knowledge in them", async () => {
    const files = await emit(MASKED);
    for (const name of ["AuditEntry.java", "AuditFieldChange.java", "AuditHistory.java"]) {
      const mod = fileEndingWith(files, name);
      expect(mod).not.toContain("Employee");
    }
    expect(fileEndingWith(files, "AuditEntry.java")).toContain("public record AuditEntry(");
    expect(fileEndingWith(files, "AuditHistory.java")).toContain(
      "public static boolean valueChanged(",
    );
  });
});

describe("entity history — java negative authz", () => {
  it("DROPS a masked field's change entry rather than redacting it", async () => {
    const service = fileEndingWith(await emit(MASKED), "EmployeeService.java");
    // The unmasked fields run through the unconditional loop...
    expect(service).toContain('for (var key : List.of("name")) {');
    // ...and `salary` is NOT among them.  A masked field must never reach the
    // always-emitted path.
    expect(service).not.toContain('for (var key : List.of("name", "salary")) {');
    // Its entry is added only inside the predicate guard, so a caller who fails
    // the predicate sees no entry at all.  "the admin changed `salary` on the
    // 3rd" is itself the disclosure the mask exists to prevent; a redacted
    // placeholder would still make it.
    expect(service).toMatch(
      /if \(__maskUser != null && \([^\n]*\)\) \{[\s\S]*?new AuditFieldChange\("salary"[\s\S]*?\n {8}\}/,
    );
    // No redaction-style null placeholder anywhere.
    expect(service).not.toContain('new AuditFieldChange("salary", null, null)');
  });

  it("is fail-closed on an unauthenticated caller", async () => {
    const service = fileEndingWith(await emit(MASKED), "EmployeeService.java");
    // The STATIC, non-throwing accessor — an unauthenticated request yields
    // null and every masked entry drops.  Same binding `fromMasked` uses.
    expect(service).toContain("User __maskUser = CurrentUserAccessor.currentOrNull();");
    expect(service).toContain("__maskUser != null &&");
  });

  it("inherits the list read's gate — 403 before any query runs", async () => {
    const controller = fileEndingWith(await emit(MASKED), "EmployeesController.java");
    const handler = controller.slice(controller.indexOf('@GetMapping("/{id}/history")'));
    expect(handler).toContain('throw new ForbiddenException("Forbidden: find history")');
    // The gate runs BEFORE the service (and therefore the audit table) is
    // touched.
    expect(handler.indexOf("ForbiddenException")).toBeLessThan(
      handler.indexOf("service.historyEmployee"),
    );
  });

  it("scopes by entity reachability, so a filtered-out row 404s instead of leaking", async () => {
    const service = fileEndingWith(await emit(MASKED), "EmployeeService.java");
    const method = service.slice(service.indexOf("public List<AuditEntry> historyEmployee"));
    // `audit_records` carries no tenant column, so there is nothing on it for a
    // capability filter to scope.  The method resolves the ENTITY first —
    // `findById` already carries every capability predicate — and only reads
    // the trail for a row this caller can see.
    expect(method).toContain("repository.findById(id).orElseThrow(() ->");
    expect(method).toContain("new AggregateNotFoundException(");
    expect(method.indexOf("repository.findById")).toBeLessThan(
      method.indexOf("findByTargetTypeAndTargetIdOrderByAtAsc"),
    );
  });

  it("never lets a stamp, the version counter, or the id into the diff", async () => {
    const service = fileEndingWith(await emit(MASKED), "EmployeeService.java");
    const mapper = service.slice(service.indexOf("private static AuditEntry employeeAuditEntry"));
    const keyLoop = mapper.slice(0, mapper.indexOf("return new AuditEntry("));
    // `auditable` stamps these post-save and `versioned` bumps `version` on
    // every command — left in, they would be most of the timeline.
    expect(keyLoop).not.toContain("updatedAt");
    expect(keyLoop).not.toContain("createdAt");
    expect(keyLoop).not.toContain('"version"');
    expect(keyLoop).not.toContain('"id"');
  });
});

describe("entity history — aggregates that serve none", () => {
  it("emits no history route, mapper or shared classes when nothing is audited", async () => {
    const files = await emit(MASKED.replace("aggregate Employee audited", "aggregate Employee"));
    expect([...files.keys()].some((p) => p.endsWith("AuditEntry.java"))).toBe(false);
    expect([...files.keys()].some((p) => p.endsWith("AuditHistory.java"))).toBe(false);
    expect(fileEndingWith(files, "EmployeesController.java")).not.toContain(
      '@GetMapping("/{id}/history")',
    );
    expect(fileEndingWith(files, "EmployeeService.java")).not.toContain("employeeAuditEntry");
  });
});
