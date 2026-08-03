// Entity history on .NET / ASP.NET + Mediator — the read side of the `audited`
// trail (docs/audit.md).  The RUNTIME contract is proven by the behavioral leg
// (`node run-dotnet.mjs audit-history` diffs the booted app's responses against
// the node-minted wire golden), and `dotnet build /warnaserror` proves the
// emitted project is sound.  This suite is the fast per-PR net over the
// emission SHAPE, and specifically over the guards — a masking or scoping
// regression should fail here in seconds rather than waiting for a boot.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

/** Audited, with a masked field, a lifecycle stamp and a `versioned` counter —
 *  one of each thing the diff boundary has to suppress — plus a gated list read
 *  for history to inherit.  Mirrors the node/python fixtures field-for-field.
 *
 *  `create(...) audited` rather than a header-wide `audited`: an aggregate that
 *  is BOTH masked and has an audited OPERATION does not compile on .NET today
 *  (the operation handler renders `maskWrap`'s `__maskUser` pattern variable
 *  twice in one scope, once for each snapshot → CS0128).  That is a pre-existing
 *  write-side defect, unrelated to the read path under test here; the fixture
 *  keeps to the lifecycle form so it stays a shape test of THIS feature. */
const MASKED = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate Employee with versioned, auditable {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
        create(name: string, salary: decimal) audited {
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
  deployable api { platform: dotnet  contexts: [C]  dataSources: [st]  serves: A  port: 8080  auth: required }
}`;

async function emit(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src);
  return generateSystems(model).files;
}

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  for (const [p, c] of files) if (p.endsWith(suffix)) return c;
  throw new Error(`no file ending in ${suffix}; have ${[...files.keys()].join(", ")}`);
};

describe("entity history — .NET route surface", () => {
  it("serves GET /{id}/history off the derived find", async () => {
    const ctrl = fileEndingWith(await emit(MASKED), "Api/EmployeesController.cs");
    expect(ctrl).toContain('[HttpGet("{id}/history")]');
    expect(ctrl).toContain("[ProducesResponseType(typeof(IReadOnlyList<AuditEntry>), 200)]");
    expect(ctrl).toContain("await _mediator.Send(new GetEmployeeHistoryQuery(new EmployeeId(id)))");
  });

  it("queries audit_records on the indexed (target_type, target_id) pair, oldest first", async () => {
    const reader = fileEndingWith(
      await emit(MASKED),
      "Infrastructure/Persistence/AuditHistoryReader.cs",
    );
    expect(reader).toContain("_db.AuditRecords");
    expect(reader).toContain("r.TargetType == targetType && r.TargetId == targetId");
    expect(reader).toContain(".OrderBy(r => r.At)");
    // The handler passes the aggregate NAME as target_type, matching the write
    // side's `TargetType = "Employee"`.
    const handler = fileEndingWith(await emit(MASKED), "Queries/GetEmployeeHistoryHandler.cs");
    expect(handler).toContain(
      'await _history.ReadAsync("Employee", query.Id.Value.ToString(), cancellationToken)',
    );
  });

  it("emits the shared shape module once, with no aggregate knowledge in it", async () => {
    const mod = fileEndingWith(await emit(MASKED), "Application/Common/AuditHistory.cs");
    expect(mod).toContain("public sealed record AuditEntry(");
    expect(mod).toContain("public static bool Changed(JsonNode? before, JsonNode? after)");
    expect(mod).not.toContain("Employee");
  });

  it("reads the trail through a persistence-neutral PORT, not the aggregate repo", async () => {
    const files = await emit(MASKED);
    // `AuditRecord` lives in Infrastructure; putting the read on the DOMAIN-facing
    // `I<Agg>Repository` would drag it across the layer boundary — the same
    // inversion the Python port refuses.  It also has to work under
    // `persistence: dapper`, where there is no AppDbContext to inject.
    const port = fileEndingWith(files, "Domain/Employees/IEmployeeRepository.cs");
    expect(port).not.toContain("AuditRecord");
    expect(port).not.toContain("HistoryAsync");
    expect(fileEndingWith(files, "Application/Common/IAuditHistoryReader.cs")).toContain(
      "public interface IAuditHistoryReader",
    );
    // …and it is actually bound, or the handler could not resolve.
    expect(fileEndingWith(files, "Program.cs")).toContain(
      "AddScoped<Api.Application.Common.IAuditHistoryReader, Api.Infrastructure.Persistence.AuditHistoryReader>()",
    );
  });

  it("indexes the snapshot object directly — no parse, and no value re-typing", async () => {
    const files = await emit(MASKED);
    const mod = fileEndingWith(files, "Application/Common/AuditHistory.cs");
    // `before`/`after` bind as `JsonNode?` (docs/audit.md §2 — the jsonb object
    // binding every backend shares), so the mapper indexes them; carrying the
    // diffed values straight back out as `JsonNode` is what keeps `5` from
    // re-serializing as `5.0` and diverging from the wire golden.
    expect(mod).toContain(
      "public sealed record AuditFieldChange(string Field, JsonNode? Before, JsonNode? After);",
    );
    expect(mod).toContain("public static JsonNode? Value(JsonNode? snapshot, string key)");
    expect(mod).not.toContain("decimal");
    expect(mod).not.toContain("JsonSerializer.Deserialize");
    // Nothing parses a snapshot — the handler reads `row.Before` / `row.After`.
    const handler = fileEndingWith(files, "Queries/GetEmployeeHistoryHandler.cs");
    expect(handler).toContain("AuditSnapshot.Value(row.Before,");
    expect(handler).not.toContain("JsonDocument.Parse");
    expect(handler).not.toContain("AuditSnapshot.Parse");
  });

  it("looks the snapshot up by the PascalCase key the write side actually stored", async () => {
    const files = await emit(MASKED);
    // The write side serializes the wire DTO with NO options — so
    // `JsonSerializerDefaults.General` (PascalCase), not the app's
    // camelCase MVC policy.  This pins the pair: if the write site ever gains a
    // camelCase options argument, this assertion is the thing that fails.
    const create = fileEndingWith(files, "Commands/CreateEmployeeHandler.cs");
    expect(create).toContain(
      "After = System.Text.Json.JsonSerializer.SerializeToNode(new EmployeeResponse(",
    );
    // No naming-policy options at the write site — that is the whole reason the
    // stored keys are PascalCase rather than the app's camelCase MVC wire.
    expect(create).not.toContain("JsonSerializerOptions");
    expect(create).not.toContain("CamelCase");
    const handler = fileEndingWith(files, "Queries/GetEmployeeHistoryHandler.cs");
    // camelCase on the wire, PascalCase into the blob — emitted as a pair.
    expect(handler).toContain('new[] { ("name", "Name") }');
    expect(handler).toContain('AuditSnapshot.Value(row.Before, "Salary")');
  });
});

describe("entity history — .NET negative authz", () => {
  it("DROPS a masked field's change entry rather than redacting it", async () => {
    const handler = fileEndingWith(await emit(MASKED), "Queries/GetEmployeeHistoryHandler.cs");
    // Unmasked fields go through the unconditional loop; `salary` must not.
    expect(handler).toContain('new[] { ("name", "Name") }');
    expect(handler).not.toContain('("salary", "Salary") }');
    // Its entry is added only inside the predicate guard, so a caller who fails
    // the predicate sees no entry at all — a redacted-but-present entry would
    // still disclose that it changed, when, and by whom.
    expect(handler).toMatch(
      /if \(RequestContext\.Current\?\.CurrentUser is \{ \} __maskUser0 &&[^\n]*\)\n(?:.*\n)*?\s+__changes\.Add\(new AuditFieldChange\("salary"/,
    );
    // No redaction-style null placeholder anywhere.
    expect(handler).not.toContain('new AuditFieldChange("salary", null, null)');
  });

  it("is fail-closed on an unauthenticated caller", async () => {
    const handler = fileEndingWith(await emit(MASKED), "Queries/GetEmployeeHistoryHandler.cs");
    // The ambient NULLABLE accessor: no principal → the `is { }` pattern fails →
    // every masked entry drops.  Same fail-closed shape as `maskWrap` on the
    // entity read (NOT `_currentUser.User`, which is non-nullable).
    expect(handler).toContain("RequestContext.Current?.CurrentUser is { } __maskUser0");
  });

  it("inherits the list read's gate — 403 before any query runs", async () => {
    const files = await emit(MASKED);
    const handler = fileEndingWith(files, "Queries/GetEmployeeHistoryHandler.cs");
    expect(handler).toContain('throw new ForbiddenException("Forbidden: find history")');
    // The gate runs BEFORE the entity load and before the audit table is read.
    expect(handler.indexOf("ForbiddenException")).toBeLessThan(handler.indexOf("GetByIdAsync"));
    expect(handler.indexOf("ForbiddenException")).toBeLessThan(
      handler.indexOf("_history.ReadAsync"),
    );
    // …and the action declares the 403 it can actually answer with.
    const ctrl = fileEndingWith(files, "Api/EmployeesController.cs");
    const action = ctrl.slice(ctrl.indexOf('[HttpGet("{id}/history")]'));
    expect(action).toContain("[ProducesResponseType(typeof(ProblemDetails), 403)]");
    expect(action).toContain("[ProducesResponseType(typeof(ProblemDetails), 404)]");
  });

  it("scopes by entity reachability, so a filtered-out row 404s instead of leaking", async () => {
    const handler = fileEndingWith(await emit(MASKED), "Queries/GetEmployeeHistoryHandler.cs");
    // `audit_records` carries no tenant column, so there is nothing on it for a
    // capability filter to scope.  The handler resolves the ENTITY first —
    // `GetByIdAsync` already carries every capability predicate (EF applies the
    // read query-filter automatically) — and only reads the trail for a row this
    // caller can see.  Absent → AggregateNotFoundException → 404.
    expect(handler).toContain("await _repo.GetByIdAsync(query.Id, cancellationToken)");
    expect(handler).toContain("throw new AggregateNotFoundException(");
    expect(handler.indexOf("GetByIdAsync")).toBeLessThan(handler.indexOf("_history.ReadAsync"));
  });

  it("never lets a stamp, the version counter, or the id into the diff", async () => {
    const handler = fileEndingWith(await emit(MASKED), "Queries/GetEmployeeHistoryHandler.cs");
    const mapper = handler.slice(handler.indexOf("var __changes"));
    const keyLoop = mapper.slice(0, mapper.indexOf("__entries.Add"));
    // `auditable` stamps these post-save and `versioned` bumps `version` on
    // every command — left in, they would be most of the timeline.
    expect(keyLoop).not.toContain("updatedAt");
    expect(keyLoop).not.toContain("createdAt");
    expect(keyLoop).not.toContain('"version"');
    expect(keyLoop).not.toContain('"id"');
  });
});

describe("entity history — aggregates that serve none", () => {
  it("emits no history action, query or shared module when nothing is audited", async () => {
    const files = await emit(MASKED.replace("audited {\n", "{\n"));
    expect([...files.keys()].some((p) => p.endsWith("Application/Common/AuditHistory.cs"))).toBe(
      false,
    );
    expect([...files.keys()].some((p) => p.endsWith("AuditHistoryReader.cs"))).toBe(false);
    expect(fileEndingWith(files, "Api/EmployeesController.cs")).not.toContain(
      '[HttpGet("{id}/history")]',
    );
  });
});
