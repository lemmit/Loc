// .NET read-mask redaction (`mask unless`, authorization.md §5, M-T3.2 item 6).
// A masked field's response DTO param is nullable, and every read handler
// projects it through a fail-closed ambient-principal guard (redacted to null
// unless the caller satisfies the predicate).  Compile-verified separately in
// the dotnet SDK container; this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const SRC = `system S {
  user { id: string  role: string  permissions: string[] }
  subdomain M {
    permissions { unmask }
    context C {
      aggregate P with crudish {
        name: string
        salary: decimal mask unless currentUser.permissions.contains(permissions.unmask)
      }
    }
  }
}`;

async function files(): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(SRC, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  return generateDotnetForContexts(contexts, "S");
}

describe("mask unless — .NET read redaction", () => {
  it("makes the masked response param nullable", async () => {
    const out = await files();
    const resp = [...out.entries()].find(([k]) => k.endsWith("PResponses.cs"))?.[1] ?? "";
    expect(resp).toMatch(/decimal\?\s+Salary/);
    // A non-masked field stays required.
    expect(resp).toMatch(/\[property: Required\] string Name/);
  });

  it("projects the masked field through a fail-closed ambient-principal guard", async () => {
    const out = await files();
    const handler = [...out.entries()].find(([k]) => k.endsWith("GetPByIdHandler.cs"))?.[1] ?? "";
    // fail-closed: null caller OR failed predicate → null.
    expect(handler).toContain("RequestContext.Current?.CurrentUser is { } __maskUser");
    expect(handler).toContain('(__maskUser.Permissions).Contains("m.unmask")');
    expect(handler).toMatch(/\?\s*\(decimal\?\)\(found\.Salary\)\s*:\s*null/);
    // the handler imports where RequestContext lives.
    expect(handler).toContain("using S.Domain.Common;");
  });
});
