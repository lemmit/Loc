// M-T5.20 (elixir leg) — the WHOLE denial ladder resolves through
// `resolveErrorStatus`, not hardcoded integer literals.
//
// Before this, only the structural-conflict rung (`Disallowed` / `ReferencedInUse`
// / the two 409s) read the api's `httpStatus <Error> -> <Code>` map; the domain
// floor (`DomainError` 422), `Forbidden` (403) and `NotFound` (404) were literals
// baked into each Phoenix handler arm.  Two consequences, both tested here:
//
//   1. a user could not remap them at all — `httpStatus DomainError -> 400` was
//      inexpressible even though the identical clause worked for `Disallowed`;
//   2. the RFC 7807 `title` sat next to the literal and drifted with it (elixir
//      shipped a "Precondition Failed" title against a 422 status until #2300).
//
// The DEFAULT half of the contract — 403 / 409 / 422 with occurrence-specific
// details — is pinned cross-backend by `domain-denial-detail-parity.test.ts`;
// this suite pins the OVERRIDE half on elixir: an override must move the runtime
// arm AND the OpenAPI declaration together, since moving one without the other
// is exactly the runtime/spec drift the mechanism exists to prevent.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** One aggregate carrying every rung: a `requires` (403), a `precondition`
 *  (the 422 domain floor), a `when` state gate (409), and an optional find
 *  (404).  `apiBody` is spliced into the api so a test can declare overrides. */
const SOURCE = (apiBody: string) => `
system Denials {
  user {
    id: string
    level: int
  }
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        total: int
        status: string

        operation cancel() {
          requires currentUser.level > 2
          precondition total > 0
          status := "cancelled"
        }

        operation reopen() when status != "open" {
          status := "open"
        }
      }
      repository Orders for Order {
        find recent(): Order? where this.total > 0
      }
    }
  }
  api SalesApi from Sales ${apiBody}
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

async function emit(apiBody: string): Promise<{ all: string; spec: string; problem: string }> {
  const files = await generateSystemFiles(SOURCE(apiBody));
  const pick = (suffix: string): string =>
    files.get([...files.keys()].find((k) => k.endsWith(suffix))!) ?? "";
  return {
    all: [...files.values()].join("\n"),
    spec: pick("/api/sales_api_spec.ex"),
    problem: pick("_web/problem_details.ex"),
  };
}

describe("elixir denial ladder — defaults (no `httpStatus` override)", () => {
  it("keeps the RS-15 ladder verbatim: 403 / 409 / 422 with their canonical titles", async () => {
    const { all } = await emit("");
    expect(all).toContain('problem_response(conn, 403, "Forbidden"');
    expect(all).toContain('problem_response(conn, 409, "Disallowed"');
    expect(all).toContain('problem_response(conn, 422, "Unprocessable Entity"');
    expect(all).toContain('problem_response(conn, 404, "Not Found"');
  });
});

describe("elixir denial ladder — `httpStatus` overrides move the runtime arm", () => {
  it("`httpStatus DomainError -> 400` retargets the domain floor, title included", async () => {
    const { all } = await emit("{ httpStatus DomainError -> 400 }");
    expect(all).toContain('problem_response(conn, 400, "Bad Request"');
    // …and the 422 domain-floor arm is gone (403 / 409 are untouched).
    expect(all, "the domain floor still answers a literal 422").not.toContain(
      'problem_response(conn, 422, "Unprocessable Entity"',
    );
    expect(all).toContain('problem_response(conn, 403, "Forbidden"');
    expect(all).toContain('problem_response(conn, 409, "Disallowed"');
  });

  // THE TITLE MOVES WITH THE STATUS on these two rungs.  Both assertions used
  // to read `401, "Forbidden"` / `410, "Not Found"` — the error NAME humanised,
  // pinning a divergence: the other four backends title `Forbidden`/`NotFound`
  // through `problemTitle(<resolved status>)`, so they answer `410, "Gone"` and
  // `401, "Error"` (401 has no `problemTitle` entry).  Elixir alone kept the
  // name.  Cross-backend census: `test/conformance/override-status-title-parity`.
  it("`httpStatus Forbidden -> 401` retargets the `requires` rung, title included", async () => {
    const { all } = await emit("{ httpStatus Forbidden -> 401 }");
    expect(all).toContain('problem_response(conn, 401, "Error"');
    expect(all).not.toContain('problem_response(conn, 403, "Forbidden"');
    // The old (name-derived) pairing must be gone, not merely joined.
    expect(all).not.toContain('problem_response(conn, 401, "Forbidden"');
  });

  it("`httpStatus NotFound -> 410` retargets BOTH the per-controller arm and the shared `not_found_response/3`", async () => {
    const { all, problem } = await emit("{ httpStatus NotFound -> 410 }");
    expect(all).toContain('problem_response(conn, 410, "Gone"');
    // The shared app-global responder is the one a per-controller-only fix
    // would have left behind at 404 — the exact half-move the mechanism exists
    // to prevent.
    expect(problem).toContain('problem_response(conn, 410, "Gone"');
    expect(problem).not.toContain('problem_response(conn, 404, "Not Found"');
    expect(problem).not.toContain('problem_response(conn, 410, "Not Found"');
  });

  it("`Disallowed` is the exception: its title stays the error NAME under a remap", async () => {
    // Every backend spells the state-gate title as the literal "Disallowed"
    // next to a resolved status, so a blanket "title = problemTitle(status)"
    // repair would break parity here.  423 is "Locked" — asserting the title is
    // still "Disallowed" is what stops that.
    const { all } = await emit("{ httpStatus Disallowed -> 423 }");
    expect(all).toContain('problem_response(conn, 423, "Disallowed"');
    expect(all).not.toContain('problem_response(conn, 423, "Locked"');
  });
});

describe("elixir denial ladder — the OpenAPI declaration moves with the arm", () => {
  it("declares the overridden statuses, not the defaults", async () => {
    const { spec } = await emit(
      "{ httpStatus DomainError -> 418 httpStatus NotFound -> 410 httpStatus Forbidden -> 401 }",
    );
    // The guarded operation route declares the whole ladder; each rung's
    // DECLARED status must equal the status its handler arm now answers.
    expect(spec).toContain("418 => %OpenApiSpex.Response{");
    expect(spec).toContain("410 => %OpenApiSpex.Response{");
    expect(spec).toContain("401 => %OpenApiSpex.Response{");
    // The default 403/404 declarations are gone — a declaration left behind is
    // a spec lie about a route that no longer serves that status.
    expect(spec).not.toContain("403 => %OpenApiSpex.Response{");
    expect(spec).not.toContain("404 => %OpenApiSpex.Response{");
    // 422 SURVIVES: an operation route declares it for the WIRE-VALIDATION
    // failure (`ValidationError`) as well as the domain floor, and only the
    // latter was remapped.
    expect(spec).toContain("422 => %OpenApiSpex.Response{");
  });

  it("an override-free system declares the default ladder (byte-identical)", async () => {
    const { spec } = await emit("");
    expect(spec).toContain("403 => %OpenApiSpex.Response{");
    expect(spec).toContain("404 => %OpenApiSpex.Response{");
    expect(spec).toContain("422 => %OpenApiSpex.Response{");
  });
});

// ─── The DENIAL TERM's own shape, as declared by the emitted `@spec` ─────────
//
// Since the typed denial protocol (`denial.ts`) every rung short-circuits to a
// 2-TUPLE reason — `{:error, {:forbidden, msg}}` / `{:precondition_failed, msg}`
// / `{:disallowed, msg}` / `{:validation_failed, [%{…}]}` — the tag naming the
// rung and the second element carrying the RFC 7807 `detail`.  The guarded
// operations' `@spec`s still declared `| {:error, atom()}`, which no denial the
// function can produce matches: a spec that describes a shape the code never
// returns, in the one place a reader looks for the contract.
const GUARDED_RETURNING = `
system Denials2 {
  user { id: string  level: int }
  subdomain Sales {
    context Sales {
      error Refused { message: string }
      aggregate Order with crudish {
        total: int
        status: string
        operation settle(): Order or Refused {
          requires currentUser.level > 2
          precondition total > 0
          status := "settled"
        }
      }
      repository Orders for Order { }
      aggregate Cart shape: document with crudish {
        total: int
        status: string
        operation close(): Cart or Refused {
          precondition total > 0
          status := "settled"
        }
        operation touch() {
          precondition total > 0
          total := total + 1
        }
      }
      repository Carts for Cart { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable d {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

describe("elixir denial ladder — the emitted @spec matches the typed-denial term", () => {
  it("a guarded op's spec declares the 2-tuple reason, on the relational AND document paths", async () => {
    const files = await generateSystemFiles(GUARDED_RETURNING);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/sales.ex"))!) ?? "";
    expect(ctx, "the context facade was not emitted").not.toBe("");
    // Three guarded ops: the relational returning op, the document returning
    // op, and the document NAMED op — one per `denialSpec` site.
    const specs = ctx.split("\n").filter((l) => l.includes("{:error, {atom(), term()}}"));
    expect(specs.length, "expected all three guarded-op specs to carry the 2-tuple").toBe(3);
    // The bare-atom form must be gone: it is what the guards never return.
    expect(ctx).not.toContain("{:error, atom()}");
  });

  it("the actual denial terms the same ops emit ARE 2-tuples (the spec is not a lie)", async () => {
    const files = await generateSystemFiles(GUARDED_RETURNING);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/sales.ex"))!) ?? "";
    expect(ctx).toMatch(/ensure\([^\n]*, \{:forbidden, "/);
    expect(ctx).toMatch(/ensure\([^\n]*, \{:precondition_failed, "/);
  });
});
