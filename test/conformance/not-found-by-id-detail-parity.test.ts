// RS-27 — a 404-BY-ID carries the sentence `"<Aggregate> <id> not found"`.
//
// The RUNTIME half is gated by the wire goldens (`corpus/core-domain` now drives
// a `GET /api/orders/{id}` 404 on every behavioural leg).  This is the fast
// per-PR STRUCTURAL substitute: it reads the string out of each backend's own
// emitted source, so a regression fails in the fast suite instead of waiting for
// a booted leg.
//
// WHY A SHARED FILE AND NOT PER-BACKEND PINS.  The defect this rule names is not
// "a backend has the wrong string" — it is "ONE ROUTE of a service answers
// differently from the rest of that same service", which happens whenever a 404
// is HAND-ROLLED at the route instead of raised by the shared producer.  THREE
// of five had it (node, .NET, java), each on the by-id READ; python and elixir
// were correct because their route reaches the producer.  A pin that looked at
// one backend would not have said that — so the assertion is written across all
// five at once, which is also the form that fails if a NEW backend arrives with
// its own spelling.
//
// EVERY ASSERTION IS FILE-SCOPED, and that is the point of this file's own
// history: its first java pin searched ALL `.java` for the message, which
// `OrderRepositoryImpl` satisfies — so "java emits the sentence" was TRUE while
// the controller answered an empty body, and the pin was green when the
// behavioural-java leg failed.  A 404 is a property of the ROUTE; only a
// route-scoped assertion can pin it.  Each backend's arm is mutation-proven.
//
// Deliberately NOT asserted here: an OPTIONAL FIND's 404, which keeps the
// `"not_found"` token on node and python alike.  RS-27 is about reads addressed
// BY ID; widening it would be a different (unmade) decision.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One canonical single-backend system per platform.  `audited` is on so the
 *  `GET /{id}/history` route — the SECOND by-id read, and the other half of the
 *  node bypass — is emitted too. */
function systemFor(platform: string, port: number): string {
  return `
system S {
  subdomain M {
    context C {
      aggregate Order audited with crudish {
        customerId: string
        status: string
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from M
  storage primary { type: postgres }
  resource ordersState { for: C, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [C]
    dataSources: [ordersState]
    serves: OrdersApi
    port: ${port}
  }
}`;
}

const sourceFor = (files: Map<string, string>, ...exts: string[]): string =>
  [...files.entries()]
    .filter(([k]) => exts.some((e) => k.endsWith(e)))
    .map(([, v]) => v)
    .join("\n");

/** Each backend's spelling of the ONE sentence, in its own interpolation
 *  syntax.  Every id type renders to the bare value (`OrderId.toString()` is
 *  overridden on java/.NET; TS and python ids ARE strings), so all five produce
 *  byte-identical bytes on the wire. */
const EXPECTED: Record<
  string,
  { platform: string; port: number; exts: string[]; needles: string[] }
> = {
  node: {
    platform: "node",
    port: 3001,
    // ROUTES ONLY.  Scoped deliberately: the repository emits the byte-
    // identical line, so a `.ts`-wide search is satisfied by the shared
    // producer even when the route has regressed to the token — the pin would
    // pass while naming nothing.  (Found by mutation-proving this file: with
    // the getById arm reverted, a `.ts`-wide version still went green.)
    exts: [".routes.ts"],
    needles: [
      // the getById route — was `AggregateNotFoundError("not_found")`
      "if (!found) throw new AggregateNotFoundError(`Order ${id} not found`);",
      // the history route — the same bypass, same fix
      "if (!__target) throw new AggregateNotFoundError(`Order ${id} not found`);",
    ],
  },
  // The shared producer the two node routes were bypassing — asserted on its
  // own file so "the route matches the repository" is two facts, not one.
  nodeRepository: {
    platform: "node",
    port: 3006,
    exts: ["-repository.ts"],
    needles: ["throw new AggregateNotFoundError(`Order ${id} not found`);"],
  },
  dotnet: {
    platform: "dotnet",
    port: 3002,
    exts: [".cs"],
    // The route no longer answers ASP.NET's OWN 404; it throws so the app's
    // DomainExceptionFilter renders the envelope (which is also what keeps it
    // inside RS-22).
    // Namespace-suffix match: the root is derived from the DEPLOYABLE name, so
    // pinning `global::<Root>.` would assert the namespace derivation, not the
    // rule.  What matters is the exception TYPE (the one the shared filter
    // catches) and the message.
    needles: ['.Domain.Common.AggregateNotFoundException($"Order {id} not found")'],
  },
  // The by-id READ path — the one that bypassed.  Scoped to `Service.java` for
  // the same reason node is scoped to `.routes.ts`: a `.java`-wide search is
  // satisfied by `OrderRepositoryImpl`'s byte-identical line, so it would pass
  // with the read path fully reverted.  (That weak form is exactly what shipped
  // and let the java leg fail in CI — this file's first java pin asserted only
  // the repository, and "java emits the sentence" was TRUE while the route
  // answered an empty body.)
  java: {
    platform: "java",
    port: 3003,
    exts: ["Service.java"],
    needles: [
      "return repository.findById(id).map(OrderResponse::from)",
      '.orElseThrow(() -> new AggregateNotFoundException("Order " + id + " not found"));',
    ],
  },
  // The shared producer, on its own file.
  javaRepository: {
    platform: "java",
    port: 3007,
    exts: ["RepositoryImpl.java"],
    needles: ['new AggregateNotFoundException("Order " + id + " not found")'],
  },
  python: {
    platform: "python",
    port: 3004,
    exts: [".py"],
    needles: ['raise AggregateNotFoundError(f"Order {id} not found")'],
  },
  // Phoenix never had the bypass: the CONTROLLER action itself calls the shared
  // producer.  Pinned at the controller (not just at the helper) so that fact
  // is asserted rather than assumed — reading only `problem-details-emit.ts` is
  // what made the java bypass invisible on the first pass.
  elixir: {
    platform: "elixir",
    port: 3005,
    exts: ["_controller.ex"],
    needles: ['ProblemDetails.not_found_response(conn, "Order", id)'],
  },
  // …and the helper the controller reaches, whose body IS the sentence.
  elixirProblemDetails: {
    platform: "elixir",
    port: 3008,
    exts: ["problem_details.ex"],
    needles: ['problem_response(conn, 404, "Not Found", "#{kind} #{id} not found")'],
  },
};

describe("RS-27 — a 404-by-id detail is the same sentence on all five backends", () => {
  for (const [name, spec] of Object.entries(EXPECTED)) {
    it(`${name} emits "<Aggregate> <id> not found"`, async () => {
      const src = sourceFor(
        await generateSystemFiles(systemFor(spec.platform, spec.port)),
        ...spec.exts,
      );
      for (const needle of spec.needles) {
        expect(src, `${name}: missing ${needle}`).toContain(needle);
      }
    });
  }

  it("node's by-id reads no longer answer the bare `not_found` token", async () => {
    const src = sourceFor(await generateSystemFiles(systemFor("node", 3011)), ".ts");
    // The token still legitimately appears — the OPTIONAL-FIND arm, the
    // projection read, and `recordDomainFault("not_found")` all use it — so this
    // pins the two BY-ID sites specifically rather than banning the string.
    expect(src).not.toContain('if (!found) throw new AggregateNotFoundError("not_found");');
    expect(src).not.toContain('if (!__target) throw new AggregateNotFoundError("not_found");');
  });

  it("dotnet's getById no longer bypasses the ProblemDetails filter", async () => {
    const files = await generateSystemFiles(systemFor("dotnet", 3012));
    const controller = sourceFor(files, "Controller.cs");
    // STRENGTHENED 2026-08-05, and for the reason the java arm below was: this
    // asserted only a NEGATIVE, and only the one exact by-id spelling, over
    // EVERY `.cs` file at once — so it could not tell "the route throws" from
    // "the route was renamed", and it said nothing about the OTHER arms that
    // answered `NotFound()`.  Those arms existed: both find-absence paths (`T
    // option` / `T?`) shipped ASP.NET's bare 404 until the same day, and this
    // test passed the whole time.  (The dapper behavioural leg read them as 28
    // wire divergences across 5 cases: wrong `type`, null `detail`, null
    // `instance`, an injected `traceId` — RS-22 on every count.)
    //
    // So: the POSITIVE, scoped to the controller…
    expect(controller).toContain(
      'throw new global::Api.Domain.Common.AggregateNotFoundException($"Order {id} not found");',
    );
    // …and a BLANKET ban on the framework 404 anywhere in the controller, which
    // now holds because every arm goes through the filter.
    expect(controller).not.toContain("NotFound()");
    // The filter that renders it — `nf.Message` is what carries the sentence,
    // and `Problem(...)` is what supplies `about:blank` + `instance`.
    expect(sourceFor(files, ".cs")).toContain(
      'context.Result = Problem(context, 404, "Not Found", nf.Message, trace_id);',
    );
  });

  it("java's getById route no longer answers Spring's own empty-bodied 404", async () => {
    const files = await generateSystemFiles(systemFor("java", 3013));
    const controller = sourceFor(files, "Controller.java");
    // The CONTROLLER, not the repository.  `ResponseEntity.notFound().build()`
    // is a 404 with an EMPTY BODY that never reaches the
    // `@ExceptionHandler(AggregateNotFoundException)` arm in the
    // `@RestControllerAdvice` — which is literally what the java behavioural leg
    // read (`golden {…} ≠ java ""`).  The route hands the service's value
    // straight back and lets the service throw.
    expect(controller).toContain(
      "return ResponseEntity.ok(service.getOrderById(new OrderId(id)));",
    );
    expect(controller).not.toContain("ResponseEntity.notFound().build()");
    // The advice that renders it — `e.getMessage()` is what carries the sentence.
    expect(sourceFor(files, ".java")).toContain(
      'return respond(problem(404, "Not Found", e.getMessage(), request), 404);',
    );
  });

  it("elixir's by-id route reaches the shared producer directly (no bypass to add)", async () => {
    const controller = sourceFor(
      await generateSystemFiles(systemFor("elixir", 3014)),
      "_controller.ex",
    );
    // `show/2` IS the by-id route; asserting the producer call inside its clause
    // — rather than anywhere in the file — is what makes "elixir was already
    // correct" a checked claim instead of a reading.
    const show = controller.slice(controller.indexOf('def show(conn, %{"id" => id})'));
    expect(show.slice(0, show.indexOf("\n  end"))).toContain(
      'ProblemDetails.not_found_response(conn, "Order", id)',
    );
    // Same for the history action, the OTHER by-id read.
    const history = controller.slice(controller.indexOf('def history(conn, %{"id" => id})'));
    expect(history.slice(0, history.indexOf("\n  end"))).toContain(
      'ProblemDetails.not_found_response(conn, "Order", id)',
    );
  });
});
