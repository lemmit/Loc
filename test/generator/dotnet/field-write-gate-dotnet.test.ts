// .NET write-side field gate enforcement (`write(...)` / `readonly when`,
// authorization.md §5, M-T3.2 item 6 — the write-side twin of `mask unless`).
// A field's `writeGate` is a `currentUser`-only ALLOWED-WHEN predicate that must
// hold whenever a client-supplied command param of the SAME NAME is present. The
// .NET backend (CQRS Mediator command handlers) emits a fail-closed 403
// (ForbiddenException → DomainExceptionFilter → RFC-7807) BEFORE the domain
// method runs. A `crudish` aggregate auto-generates `create` + `update` ops that
// take the field as a param, so both handlers must guard it. Compile-verified
// separately in the dotnet SDK container; this pins the emit shape.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const SRC = (fieldClause: string) => `system S {
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

async function files(fieldClause: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(SRC(fieldClause), { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  return generateDotnetForContexts(contexts, "S");
}

const GATE = "write(currentUser.permissions.contains(permissions.setSalary))";
const BIND = "var __writeUser = RequestContext.Current?.CurrentUser;";
const GUARD =
  'if (!(__writeUser is not null && ((__writeUser.Permissions).Contains("m.setSalary")))) ' +
  'throw new ForbiddenException("Forbidden: write salary");';

describe("field write gate — .NET enforcement", () => {
  it("guards the create command handler before the aggregate is constructed", async () => {
    const out = await files(GATE);
    const handler = [...out.entries()].find(([k]) => k.endsWith("CreatePHandler.cs"))?.[1] ?? "";
    expect(handler).toContain(BIND);
    expect(handler).toContain(GUARD);
    // Fail-closed guard lands before the create factory call.
    expect(handler.indexOf(GUARD)).toBeLessThan(handler.indexOf("P.Create("));
    // RequestContext + ForbiddenException both live in Domain.Common.
    expect(handler).toContain("using S.Domain.Common;");
  });

  it("guards the update op command handler before the aggregate load/mutation", async () => {
    const out = await files(GATE);
    const handler = [...out.entries()].find(([k]) => k.endsWith("UpdateHandler.cs"))?.[1] ?? "";
    expect(handler).toContain(BIND);
    expect(handler).toContain(GUARD);
    const guardIdx = handler.indexOf(GUARD);
    // Principal-only ⇒ fails fast, before the repo load and the domain call.
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(handler.indexOf("_repo.", guardIdx)).toBeGreaterThan(guardIdx);
    expect(handler.indexOf("aggregate.Update(", guardIdx)).toBeGreaterThan(guardIdx);
    expect(handler).toContain("using S.Domain.Common;");
  });

  it("binds __writeUser once per handler", async () => {
    const out = await files(GATE);
    const handler = [...out.entries()].find(([k]) => k.endsWith("UpdateHandler.cs"))?.[1] ?? "";
    // Exactly one bind even if several params were gated.
    expect(handler.split(BIND).length - 1).toBe(1);
  });

  it("emits no guard for a non-gated field (byte-identical)", async () => {
    const out = await files("");
    const create = [...out.entries()].find(([k]) => k.endsWith("CreatePHandler.cs"))?.[1] ?? "";
    const update = [...out.entries()].find(([k]) => k.endsWith("UpdateHandler.cs"))?.[1] ?? "";
    expect(create).not.toContain("__writeUser");
    expect(create).not.toContain("Forbidden: write");
    expect(update).not.toContain("__writeUser");
    expect(update).not.toContain("Forbidden: write");
  });
});
