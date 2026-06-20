// View `requires` gate on .NET (D-AUTH-OIDC / default-deny).  A
// `view X = Agg requires <expr> where <pred>` emits an in-handler 403 gate at
// the top of the view's Mediator query handler — the read-side analogue of an
// operation `requires` — evaluated against the request's currentUser before
// the query runs.  ForbiddenException maps to 403 via DomainExceptionFilter
// (the same path operations use).  An ungated view emits no gate.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

async function emit(viewClause: string): Promise<Map<string, string>> {
  const src = `
    system Acme {
      user { id: string role: string }
      subdomain Sales {
        context Tickets {
          aggregate Ticket { subject: string open: bool }
          repository Tickets for Ticket { }
          view OpenTickets = Ticket ${viewClause}where open == true
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

describe(".NET view requires gate", () => {
  it("emits a ForbiddenException gate evaluated against currentUser before the query", async () => {
    const handler = (await emit('requires currentUser.role == "agent" ')).get(
      "Application/Views/OpenTicketsHandler.cs",
    )!;
    // Accessor injected + local bound for the predicate.
    expect(handler).toMatch(/ICurrentUserAccessor _currentUser/);
    expect(handler).toContain("var currentUser = _currentUser.User;");
    expect(handler).toContain(
      'if (!(currentUser.Role == "agent")) throw new ForbiddenException("Forbidden: view OpenTickets");',
    );
    // ForbiddenException is in scope.
    expect(handler).toMatch(/using Api\.Domain\.Common;/);
    // The gate sits before the repository call.
    const gateIdx = handler.indexOf("throw new ForbiddenException");
    const queryIdx = handler.indexOf("await _repo.OpenTickets(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated view", async () => {
    const handler = (await emit("")).get("Application/Views/OpenTicketsHandler.cs")!;
    expect(handler).not.toContain("throw new ForbiddenException");
    expect(handler).not.toContain("var currentUser =");
  });

  it("`requires true` emits an always-pass gate without touching currentUser", async () => {
    const handler = (await emit("requires true ")).get("Application/Views/OpenTicketsHandler.cs")!;
    expect(handler).toContain(
      'if (!(true)) throw new ForbiddenException("Forbidden: view OpenTickets");',
    );
    // No currentUser local / accessor for a constant gate (would be an unused
    // field under /warnaserror).
    expect(handler).not.toContain("var currentUser = _currentUser.User;");
    expect(handler).not.toMatch(/ICurrentUserAccessor _currentUser/);
  });
});
