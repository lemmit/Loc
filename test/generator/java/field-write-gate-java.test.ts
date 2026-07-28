// Java/Spring write-side field gate (`write(<expr>)` / `readonly when`,
// authorization.md §5, M-T3.2 item 6 — the write-side twin of `mask unless`).
// A write-gated field's create/op @Service method binds the ambient principal
// off the STATIC accessor and rejects (fail-closed 403 via ForbiddenException)
// before the domain call, whenever a client-supplied param of the same name is
// present. Compile-verified separately (gradle, JDK 25); this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateJavaForContexts } from "../../../src/generator/java/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const gatedSrc = (fieldClause: string) => `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { setSalary }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal ${fieldClause}
      }
    }
  }
}`;

async function serviceFor(fieldClause: string): Promise<string> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(gatedSrc(fieldClause), { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  const out = generateJavaForContexts(contexts, "S");
  return [...out.entries()].find(([k]) => k.endsWith("PService.java"))?.[1] ?? "";
}

describe("field write gate — Java write enforcement", () => {
  it("binds the principal + fail-closed forbidden throw in the create service method", async () => {
    // `crudish` gives P a generated `update` operation whose params include
    // `salary` (the write-gated field), so both create + update guard it.
    const svc = await serviceFor("write(currentUser.permissions.contains(permissions.setSalary))");
    // create method: bind once off the static accessor, guard before P.create(...).
    expect(svc).toMatch(
      /public PId createP\(CreatePRequest request\) \{\s*\n\s*User __writeUser = CurrentUserAccessor\.currentOrNull\(\);/,
    );
    // The fail-closed guard with the rendered currentUser-only predicate.
    expect(svc).toContain(
      'if (!(__writeUser != null && (__writeUser.permissions().contains("m.setSalary")))) throw new ForbiddenException("Forbidden: write salary");',
    );
    // The guard runs before the domain construction.
    const createBody = svc.slice(svc.indexOf("public PId createP("));
    expect(createBody.indexOf("__writeUser")).toBeLessThan(createBody.indexOf("P.create("));
  });

  it("binds the principal + fail-closed forbidden throw in the update operation method", async () => {
    const svc = await serviceFor("write(currentUser.permissions.contains(permissions.setSalary))");
    const updateBody = svc.slice(svc.indexOf("public void update("));
    expect(updateBody).toContain("User __writeUser = CurrentUserAccessor.currentOrNull();");
    expect(updateBody).toContain(
      'if (!(__writeUser != null && (__writeUser.permissions().contains("m.setSalary")))) throw new ForbiddenException("Forbidden: write salary");',
    );
    // The guard fires before the aggregate load / mutation.
    expect(updateBody.indexOf("__writeUser")).toBeLessThan(
      updateBody.indexOf("repository.getById(id)"),
    );
  });

  it("imports the static accessor, principal type, and forbidden exception", async () => {
    const svc = await serviceFor("write(currentUser.permissions.contains(permissions.setSalary))");
    expect(svc).toMatch(/import \S+\.auth\.CurrentUserAccessor;/);
    expect(svc).toMatch(/import \S+\.auth\.User;/);
    expect(svc).toMatch(/import \S+\.domain\.common\.ForbiddenException;/);
  });

  it("emits no write guard for a non-gated field", async () => {
    const svc = await serviceFor("");
    expect(svc).not.toContain("__writeUser");
    expect(svc).not.toContain("Forbidden: write");
  });
});
