// RS-27 — a 404-BY-ID carries the sentence `"<Aggregate> <id> not found"`.
//
// The RUNTIME half is gated by the wire goldens (`corpus/core-domain` now drives
// a `GET /api/orders/{id}` 404 on every behavioural leg).  This is the fast
// per-PR STRUCTURAL substitute: it reads the string out of each backend's own
// emitted source, so a regression fails in the fast suite instead of waiting for
// a booted leg.
//
// WHY A SHARED FILE AND NOT TWO PER-BACKEND PINS.  The defect this rule names is
// not "a backend has the wrong string" — it is "ONE ROUTE of a service answers
// differently from the rest of that same service", which happens whenever a 404
// is HAND-ROLLED at the route instead of raised by the shared producer.  Four
// backends were already correct precisely because they had one producer; the two
// that diverged each had exactly one bypass.  A pin that only looked at node, or
// only at .NET, would not have said that — so the assertion is written across
// all five at once, which is also the form that fails if a NEW backend arrives
// with its own spelling.
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
  java: {
    platform: "java",
    port: 3003,
    exts: [".java"],
    needles: ['new AggregateNotFoundException("Order " + id + " not found")'],
  },
  python: {
    platform: "python",
    port: 3004,
    exts: [".py"],
    needles: ['raise AggregateNotFoundError(f"Order {id} not found")'],
  },
  elixir: {
    platform: "elixir",
    port: 3005,
    exts: [".ex"],
    // Phoenix reaches the same sentence through its shared helper, whose body
    // IS the sentence — so both halves are pinned.
    needles: [
      'ProblemDetails.not_found_response(conn, "Order", id)',
      'problem_response(conn, 404, "Not Found", "#{kind} #{id} not found")',
    ],
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
    const src = sourceFor(await generateSystemFiles(systemFor("dotnet", 3012)), ".cs");
    // `NotFound()` produced ASP.NET's own bare 404 — outside the app's filter,
    // and therefore outside RS-22's envelope too (no `instance`, an injected
    // `traceId`).  Nothing in the controller may answer it that way again.
    expect(src).not.toContain("return response is null ? NotFound() : Ok(response);");
  });
});
