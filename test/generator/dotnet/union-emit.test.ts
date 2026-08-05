// .NET generator coverage for single-success union finds (`find x(): Agg or
// Err`).  Per exception-less.md §4 the 200 body is the SUCCESS variant
// DIRECTLY (`<Agg>Response`) — never a tagged `oneOf`/JsonPolymorphic
// component (an error variant belongs at its status, not in a 200 schema) — so
// a union find is CQRS-identical to an optional find: the Domain repository
// returns the optional twin (`Agg?`), the query/handler yield `<Agg>Response?`,
// and the controller returns it directly at 200 or maps a null result to the
// error/absent variant's status (ProblemDetails / 404).  No union DTO is
// emitted.  Compiles under `dotnet build /warnaserror`.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Orders {
    aggregate Order { code: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

function find(map: Map<string, string>, suffix: string): string {
  const key = [...map.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending ${suffix}; have:\n${[...map.keys()].join("\n")}`);
  return map.get(key)!;
}

describe("dotnet generator — discriminated-union finds (P4c)", () => {
  it("emits NO JsonPolymorphic union DTO for a single-success find", async () => {
    const map = await files();
    expect([...map.keys()].some((k) => k.endsWith("Responses/OrderOrNotFound.cs"))).toBe(false);
    // No response file mentions the tagged union base anywhere.
    for (const [k, v] of map) if (k.endsWith(".cs")) expect(v).not.toContain("OrderOrNotFound");
  });

  it("the query + controller return the success variant's <Agg>Response", async () => {
    const map = await files();
    expect(find(map, "Queries/RecentQuery.cs")).toContain("IQuery<OrderResponse?>");
    const ctrl = find(map, "OrdersController.cs");
    expect(ctrl).toContain("Task<ActionResult<OrderResponse>>");
    expect(ctrl).toContain("[ProducesResponseType(typeof(OrderResponse), 200)]");
  });

  it("the handler maps the repository's optional twin to <Agg>Response? (optional-style)", async () => {
    const handler = find(await files(), "Queries/RecentHandler.cs");
    expect(handler).not.toContain("NotImplementedException");
    expect(handler).toContain("var domain = await _repo.Recent(cancellationToken);");
    expect(handler).toContain("return domain is null ? null :");
    expect(handler).not.toContain("OrderOrNotFound");
  });

  it("the Domain repository emits the find as its optional twin", async () => {
    const map = await files();
    const iface = find(map, "Domain/Orders/IOrderRepository.cs");
    expect(iface).toContain("Task<Order?> Recent(");
    expect(iface).not.toContain("OrderOrNotFound");
    expect(find(map, "Repositories/OrderRepository.cs")).not.toContain("OrderOrNotFound");
  });

  it("the controller maps a null result to ProblemDetails at its status, with the resource extension", async () => {
    const ctrl = find(await files(), "OrdersController.cs");
    expect(ctrl).toContain("if (result is null)");
    // The error payload declares `resource`, so the absent arm builds an
    // explicit ProblemDetails (the bare `Problem(...)` helper has no slot for
    // extension members) and serializes the aggregate name at the body root.
    // `Instance` set explicitly — nothing fills it in on a hand-built
    // ProblemDetails, and the other four backends all send the request path.
    expect(ctrl).toContain(
      'var problem = new ProblemDetails { Status = 404, Title = "Not Found", Type = "/errors/not-found", Detail = "Not Found", Instance = HttpContext.Request.Path };',
    );
    expect(ctrl).toContain('problem.Extensions["resource"] = "Order";');
    expect(ctrl).toContain(
      'return new ObjectResult(problem) { StatusCode = 404, ContentTypes = { "application/problem+json" } };',
    );
    expect(ctrl).toContain("[ProducesResponseType(typeof(ProblemDetails), 404)]");
  });
});

// ---------------------------------------------------------------------------
// RS-22/RS-27 — a FIND-ABSENCE 404 goes through the shared producer.
//
// Both arms below used to `return NotFound();` — ASP.NET's own bare 404, which
// never reaches `DomainExceptionFilter` and is rendered by
// `ProblemDetailsFactory` instead.  That is FOUR wrong members at once against
// the golden envelope: `type` = the rfc9110 §15.5.5 URI rather than
// `about:blank`, `detail` = null rather than the `"not_found"` token,
// `instance` = null rather than the request path, plus an injected `traceId`
// the envelope must not carry.  RS-22 names exactly this factory behaviour and
// records dotnet as CONFORMING — because the arms nobody had converted were the
// arms nobody had CALLED.
//
// The controller emitter is SHARED between the EF and Dapper adapters (its only
// `usingDapper` branch is the destroy FK catch), so both legs carried it.
// Found 2026-08-05 on the dapper leg, one backend over from the identical java
// defect: the caller census named these finds as zero-caller routes, the first
// callers drove their miss paths, and all 28 of the leg's wire divergences —
// across `union-find-absence`, `inheritance`, `provenance`, `audited` and
// `wire-contract` — were this one bug.
// ---------------------------------------------------------------------------

const ABSENCE_SRC = `
  context Orders {
    aggregate Order { code: string }
    error Missing { resource: string }
    repository Orders for Order {
      find optionFind(code: string): Order option
      find nullableFind(code: string): Order?
      find errorFind(code: string): Order or Missing
      find listFind(code: string): Order[]
    }
  }
`;

describe("dotnet generator — find-absence 404 (RS-22/RS-27)", () => {
  it("throws through the shared producer for BOTH the `option` and the `?` find", async () => {
    const map = await generateDotnet(await parseValid(ABSENCE_SRC));
    const ctrl = find(map, "OrdersController.cs");

    // Premise: all four find shapes really are on this controller, so the
    // assertions below are about the ABSENCE arm and not about a find the
    // emitter dropped.
    for (const route of ["option_find", "nullable_find", "error_find", "list_find"]) {
      expect(ctrl).toContain(`[HttpGet("${route}")]`);
    }

    // The two shapes that answered the framework 404.
    const throws = ctrl.match(
      /throw new global::[\w.]*Domain\.Common\.AggregateNotFoundException\("not_found"\);/g,
    );
    expect(throws?.length).toBe(2);

    // NOT the framework 404, anywhere in the controller.  `NotFound()` bypasses
    // `DomainExceptionFilter`, so it can never carry the RS-22 envelope.
    expect(ctrl).not.toContain("NotFound()");

    // The declared-`error` variant keeps its own mapped status + `resource`
    // extension (RS-19) — the fix must not collapse the two absence classes.
    expect(ctrl).toContain('problem.Extensions["resource"] = "Order";');
  });

  it("a LIST find is untouched — it has no absence to answer", async () => {
    // Scope guard: `Order[]` answers `[]`, never a 404 (RS-23).  Without this,
    // a fix that threw on every null-ish find would pass the test above.
    const ctrl = find(await generateDotnet(await parseValid(ABSENCE_SRC)), "OrdersController.cs");
    const arm = ctrl.slice(ctrl.indexOf('[HttpGet("list_find")]'));
    const next = arm.indexOf("[HttpGet", 1);
    const body = next === -1 ? arm : arm.slice(0, next);
    expect(body).toContain("return Ok(result);");
    expect(body).not.toContain("AggregateNotFoundException");
  });
});
