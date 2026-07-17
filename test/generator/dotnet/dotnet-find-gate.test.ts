// Find `requires` gate on .NET (D-AUTH-OIDC / default-deny).  A
// `find f(): T[] requires <expr> where <pred>` emits an in-handler 403 gate at
// the top of the find's Mediator query handler — the read-side twin of the view
// gate — evaluated against the request's currentUser before the query runs.
// ForbiddenException maps to 403 via DomainExceptionFilter.  Ungated → no gate.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

async function emit(findClause: string): Promise<Map<string, string>> {
  const src = `
    system Acme {
      user { id: string role: string }
      subdomain Sales {
        context Tickets {
          aggregate Ticket { subject: string open: bool }
          repository Tickets for Ticket {
            find openOnes(): Ticket[] ${findClause}where open == true
          }
        }
      }
      deployable api {
        platform: dotnet
        contexts: [Tickets]
        port: 8080
        auth: required
      }
    }
  `;
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const { lowerModel } = await import("../../../src/ir/lower/lower.js");
  const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
  const { generateDotnetForContexts } = await import("../../../src/generator/dotnet/index.js");
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const sys = loom.systems[0]!;
  const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
  const contexts = sys.subdomains.flatMap((m) => m.contexts);
  return generateDotnetForContexts(contexts, "Api", { deployable: dep, sys });
}

function handlerOf(files: Map<string, string>): string {
  const key = [...files.keys()].find((k) => k.endsWith("OpenOnesHandler.cs"));
  expect(key, "OpenOnesHandler.cs not emitted").toBeDefined();
  return files.get(key!)!;
}

describe(".NET find requires gate", () => {
  it("emits a ForbiddenException gate evaluated against currentUser before the query", async () => {
    const handler = handlerOf(await emit('requires currentUser.role == "agent" '));
    expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
    expect(handler).toContain("var currentUser = _currentUser.User;");
    expect(handler).toContain(
      'if (!(currentUser.Role == "agent")) throw new ForbiddenException("Forbidden: find openOnes");',
    );
    expect(handler).toMatch(/using Api\.Domain\.Common;/);
    const gateIdx = handler.indexOf("throw new ForbiddenException");
    const queryIdx = handler.indexOf("await _repo.OpenOnes(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated find", async () => {
    const handler = handlerOf(await emit(""));
    expect(handler).not.toContain("ForbiddenException");
  });

  it("`requires true` emits an always-pass gate without injecting the accessor", async () => {
    const handler = handlerOf(await emit("requires true "));
    expect(handler).toContain(
      'if (!(true)) throw new ForbiddenException("Forbidden: find openOnes");',
    );
    expect(handler).not.toContain("var currentUser = _currentUser.User;");
  });
});
