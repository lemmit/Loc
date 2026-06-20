// .NET lifecycle stamping — the EF Core AuditableInterceptor (audit-and-logging.md).
//
// Stamps (`stamp onCreate`/`onUpdate`) are applied by a SaveChangesInterceptor
// before persistence.  Timestamp values (`createdAt := now()`) render as
// `DateTime.UtcNow`; a PRINCIPAL value (`createdBy := currentUser`) resolves to
// the request principal's id read from the ambient RequestContext — the .NET
// analogue of the Java backend's `currentUser.id()`.  Stamped fields are widened
// to `internal set` so the same-assembly interceptor can write them.  Compiled
// end-to-end by the LOOM_DOTNET_BUILD `stamps-principal.ddd` cell; this suite
// pins the emitted constructs in the fast suite.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const diagErrs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (diagErrs.length) {
    throw new Error(
      `diagnostics:\n${diagErrs
        .map((e) => `${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`)
        .join("\n")}`,
    );
  }
  return doc.parseResult?.value as Model;
}

const SOURCE = `
system PS {
  user { id: guid  name: string }
  subdomain D {
    context Shop {
      stamp onCreate { createdAt := now()  createdBy := currentUser }
      stamp onUpdate { updatedAt := now() }
      aggregate Order with crudish {
        code: string
        createdAt: datetime
        updatedAt: datetime
        createdBy: guid
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api { platform: dotnet, contexts: [Shop], dataSources: [st], serves: A, port: 8081, auth: required }
}
`;

describe(".NET lifecycle stamping (AuditableInterceptor)", () => {
  it("renders timestamp stamps as DateTime.UtcNow and principal stamps from RequestContext", async () => {
    const files = generateSystems(await build(SOURCE)).files;
    const src = files.get("api/Infrastructure/Persistence/AuditableInterceptor.cs")!;
    expect(src).toMatch(/e\.CreatedAt = DateTime\.UtcNow;/);
    expect(src).toMatch(/e\.UpdatedAt = DateTime\.UtcNow;/);
    // currentUser resolves to the principal id from the ambient carrier.
    expect(src).toMatch(/e\.CreatedBy = RequestContext\.Current!\.CurrentUser!\.Id;/);
    // The principal namespaces (deployable-derived ns `Api`) are pulled in only
    // because a stamp uses the principal.
    expect(src).toMatch(/using Api\.Domain\.Common;/);
    expect(src).toMatch(/using Api\.Auth;/);
    // No leftover undefined identifier from the old (uncompilable) emit.
    expect(src).not.toMatch(/= currentUser;/);
  });

  it("widens stamped fields to `internal set` so the interceptor can write them", async () => {
    const files = generateSystems(await build(SOURCE)).files;
    const entity = files.get("api/Domain/Orders/Order.cs")!;
    expect(entity).toMatch(/public DateTime CreatedAt \{ get; internal set; \}/);
    expect(entity).toMatch(/public DateTime UpdatedAt \{ get; internal set; \}/);
    expect(entity).toMatch(/public Guid CreatedBy \{ get; internal set; \}/);
    // A non-stamped field keeps its private setter.
    expect(entity).toMatch(/public string Code \{ get; private set; \}/);
  });

  it("gates a currentUser stamp on a dotnet deployable WITHOUT auth fail-fast", async () => {
    const noAuth = SOURCE.replace(
      ", serves: A, port: 8081, auth: required }",
      ", serves: A, port: 8081 }",
    );
    const loom = await buildLoomModel(noAuth);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.dotnet-stamp-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("no auth");
  });
});
