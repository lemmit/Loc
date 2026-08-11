// M-T6.31 — every ABSENT-READ 404 in a service comes out of that service's ONE
// 404 producer, on all five backends.
//
// The sibling of `not-found-by-id-detail-parity.test.ts` (RS-27), which pins the
// AGGREGATE by-id read.  RS-27 and the 2026-08-05 caller-census drain converted
// three read sites — `GET /<agg>/{id}`, the `T?` find, the `T option` find — and
// stopped there.  Two sites were left, and they are the ones a client is most
// likely to hit second:
//
//   * projection show      `GET /api/projections/<p>/{key}`
//   * workflow-instance show `GET /api/workflows/<wf>/instances/{id}`
//
// On those two, .NET answered `return NotFound();` (ASP.NET's own 404, rendered
// by `ProblemDetailsFactory`: rfc9110 `type`, null `detail`, null `instance`,
// plus a `traceId` extension no other backend sends) and java answered
// `ResponseEntity.notFound().build()` (**404 with an empty body and no
// content-type**).  Both backends already emitted the CORRECT envelope on their
// command paths, from a hand-built handler, and then contradicted themselves
// here — an INTRA-backend split, which is why this is M-T9.25's class rather
// than an ordinary parity gap.
//
// WHY THIS SHAPE OF TEST.  Three properties are load-bearing, each learned from
// a way an earlier version of this rule was pinned and still shipped broken:
//
//  1. **Per-SITE, not per-backend.**  The defect is "one route of a service
//     answers differently from the rest of the same service", so the assertion
//     names the route file and the site inside it.  A backend-wide assertion is
//     satisfied by whichever sibling route is already correct.
//  2. **File-scoped.**  `not-found-by-id-detail-parity`'s first java pin
//     searched all `.java` for the sentence, which `OrderRepositoryImpl`
//     satisfies — so "java emits the sentence" was TRUE while the controller
//     answered an empty body.  Every needle here is scoped to the emitted file
//     that OWNS the route.
//  3. **A NEGATIVE beside every positive.**  The positive alone cannot tell
//     "the arm throws" from "the arm was renamed"; the negative alone cannot
//     tell "it throws" from "the route was deleted".  Each backend asserts both.
//
// Deliberately NOT asserted here: `GET /files/{key}`'s absent-object 404.  That
// is a FOURTH shape (node/python/elixir `{"error":"not found"}` as
// `application/json`; dotnet/java empty-bodied) and none of the five is 7807 —
// a separate wire change on three backends, recorded on M-T6.31 rather than
// silently folded in here.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One canonical single-backend system per platform, carrying BOTH read sites:
 *  a folded `projection` (→ the projections controller's show route) and a
 *  correlation-bearing `workflow` with an `instance { … }` block (→ the workflow
 *  -instances controller's show route). */
function systemFor(platform: string, port: number): string {
  return `
system S {
  subdomain M {
    context C {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          status := "Placed"
          emit OrderPlaced { orderRef: id, at: now() }
        }
      }
      repository Orders for Order { }
      event OrderPlaced { orderRef: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
      projection OrderBoard keyed by orderRef {
        orderRef: Order id
        status: string
        at: datetime
        on(e: OrderPlaced) { orderRef := e.orderRef  status := "Placed"  at := e.at }
      }
      workflow Fulfil {
        orderRef: Order id
        stage: string
        create(p: OrderPlaced) by p.orderRef {
          stage := "started"
        }
      }
    }
  }
  api OrdersApi from M
  storage pg { type: postgres }
  resource state { for: C, kind: state, use: pg }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [state]
    serves: OrdersApi
    port: ${port}
  }
}`;
}

const sourceFor = (files: Map<string, string>, ...suffixes: string[]): string =>
  [...files.entries()]
    .filter(([k]) => suffixes.some((s) => k.endsWith(s)))
    .map(([, v]) => v)
    .join("\n");

/** Each backend's spelling of "raise the shared 404 producer", per read site,
 *  plus the local answer it must NOT contain.  The sentence is byte-identical
 *  across all five — `"<Resource> <key> not found"` — because every id type
 *  renders to its bare value. */
const SITES: Record<
  string,
  {
    platform: string;
    port: number;
    /** The emitted file that owns the route. */
    file: string;
    /** Must appear: the throw that reaches the one 404 producer. */
    raises: string[];
    /** Must NOT appear in that file: the framework's own 404. */
    forbidden: string[];
  }
> = {
  "dotnet projection show": {
    platform: "dotnet",
    port: 3102,
    file: "ProjectionsController.cs",
    raises: [
      'throw new global::Api.Domain.Common.AggregateNotFoundException($"OrderBoard {key} not found")',
    ],
    forbidden: ["NotFound()"],
  },
  "dotnet workflow-instance show": {
    platform: "dotnet",
    port: 3103,
    file: "WorkflowInstancesController.cs",
    raises: [
      'throw new global::Api.Domain.Common.AggregateNotFoundException($"Fulfil {id} not found")',
    ],
    forbidden: ["NotFound()"],
  },
  "java projection show": {
    platform: "java",
    port: 3104,
    file: "ProjectionsController.java",
    raises: [
      '.orElseThrow(() -> new AggregateNotFoundException("OrderBoard " + key + " not found"))',
    ],
    forbidden: ["ResponseEntity.notFound().build()"],
  },
  "java workflow-instance show": {
    platform: "java",
    port: 3105,
    file: "WorkflowInstancesController.java",
    raises: ['.orElseThrow(() -> new AggregateNotFoundException("Fulfil " + id + " not found"))'],
    forbidden: ["ResponseEntity.notFound().build()"],
  },
  // The three that were already right — asserted so "these were correct" is a
  // CHECKED claim, and so a future change that breaks one of them fails here
  // rather than on a booted leg.
  "node projection show": {
    platform: "node",
    port: 3106,
    file: "http/projections.ts",
    raises: ["throw new AggregateNotFoundError(`OrderBoard ${key} not found`)"],
    forbidden: ['c.json({ error: "not found" }, 404)'],
  },
  "node workflow-instance show": {
    platform: "node",
    port: 3107,
    file: "http/workflows.ts",
    raises: ["throw new AggregateNotFoundError(`Fulfil ${id} not found`)"],
    forbidden: ['c.json({ error: "not found" }, 404)'],
  },
  "python projection show": {
    platform: "python",
    port: 3108,
    file: "projections_routes.py",
    raises: ['raise AggregateNotFoundError(f"OrderBoard {key} not found")'],
    forbidden: ["status_code=404"],
  },
  "python workflow-instance show": {
    platform: "python",
    port: 3109,
    file: "workflows_routes.py",
    raises: ['raise AggregateNotFoundError(f"Fulfil {id} not found")'],
    forbidden: ["status_code=404"],
  },
  "elixir projection show": {
    platform: "elixir",
    port: 3110,
    file: "projections_controller.ex",
    raises: ['ProblemDetails.not_found_response(conn, "OrderBoard", key)'],
    forbidden: ['json(%{"error" => "not found"})'],
  },
  "elixir workflow-instance show": {
    platform: "elixir",
    port: 3111,
    file: "workflow_instances_controller.ex",
    // Was `"Fulfil instance"` until M-T6.31 — elixir was the only backend
    // whose instance 404 named a different resource than node/python did.
    raises: ['ProblemDetails.not_found_response(conn, "Fulfil", id)'],
    forbidden: ['not_found_response(conn, "Fulfil instance"'],
  },
};

describe("M-T6.31 — an absent read raises the service's one 404 producer, all five backends", () => {
  for (const [name, spec] of Object.entries(SITES)) {
    it(`${name} reaches the shared envelope`, async () => {
      const src = sourceFor(
        await generateSystemFiles(systemFor(spec.platform, spec.port)),
        spec.file,
      );
      expect(src, `${name}: no ${spec.file} was emitted at all`).not.toBe("");
      for (const needle of spec.raises) {
        expect(src, `${name}: missing ${needle}`).toContain(needle);
      }
      for (const banned of spec.forbidden) {
        expect(src, `${name}: still answers locally with ${banned}`).not.toContain(banned);
      }
    });
  }

  // The producers themselves, one assertion each — the other half of "the route
  // matches the handler".  Reading only the route (as this file's ancestor did
  // for java) cannot tell whether the thing it throws is actually rendered as
  // 7807 by anybody.
  it("dotnet renders the raised carrier as the 7807 envelope", async () => {
    const files = await generateSystemFiles(systemFor("dotnet", 3112));
    expect(sourceFor(files, ".cs")).toContain(
      'context.Result = Problem(context, 404, "Not Found", nf.Message, trace_id);',
    );
  });

  it("java renders the raised carrier as the 7807 envelope", async () => {
    const files = await generateSystemFiles(systemFor("java", 3113));
    expect(sourceFor(files, ".java")).toContain(
      'return respond(problem(404, "Not Found", e.getMessage(), request), 404);',
    );
  });

  // node's projection router declares NO `app.onError`, so its throw is rendered
  // by the ROOT ladder in `http/index.ts` (M-T6.28).  Without that floor the
  // same throw answered 500 `"internal"` — a 404 raised correctly and reported
  // as a server fault — so the two halves of this family are pinned together.
  it("node's root floor renders a projection-router throw as 404, not 500", async () => {
    const files = await generateSystemFiles(systemFor("node", 3114));
    const projections = sourceFor(files, "http/projections.ts");
    const index = sourceFor(files, "http/index.ts");
    // The premise: the projection router really does declare no handler of its
    // own (if it grows one, this test's reasoning moves, and it should fail).
    expect(projections).toContain("const app = new OpenAPIHono();");
    expect(projections).not.toContain("app.onError(");
    // …so the floor must carry the domain rung.
    expect(index).toContain("if (err instanceof AggregateNotFoundError) {");
    expect(index).toContain('return problem(404, "Not Found", err.message);');
  });
});
