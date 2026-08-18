import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Out-of-range `page` / `pageSize` is REFUSED, not clamped (audit A16).
//
// `openapi-emit.ts` publishes `minimum: 1` / `maximum: <limit>` for both paging
// params on every paged read.  The vanilla-Phoenix `page_param/4` helper
// nevertheless CLAMPED (`min(v, limit)`, and anything below 1 fell through to
// the default), so elixir answered `200` — with a page the caller never asked
// for — to a request its own OpenAPI document calls invalid.  node (zod
// `.min(1).max(…)` → the 422 hook) and python (`Query(ge=…, le=…)` → the 422
// handler) both refuse it; elixir was the odd one out, and no wire case sends
// an out-of-range page, so nothing caught it.
//
// It now returns `{:error, {:invalid_paging, [...]}}`, which the read's `with`
// answers through `ProblemDetails.validation_errors_response/2` — the SAME
// §3.2 `errors[]` 422 sender the changeset rung uses, so the envelope is
// byte-identical to the one node/python emit.
//
// Two other things are pinned here because they were part of the same defect:
//   * the helper is defined ONCE (`page-param.ts`), not copy-pasted into the
//     find controller and the queryHandler controller;
//   * the in-range path still binds the same values through the same reads, so
//     a valid request is behaviourally unchanged.
// ---------------------------------------------------------------------------

const SOURCE = `
system PagedShop {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order {
        find recent(): Order paged
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

/** The OTHER controller that pages — a paged-run `queryHandler` mounted on an
 *  explicit api route.  It used to carry its own byte-identical copy of the
 *  clamping helper; it now shares the one definition, and must refuse the same
 *  way (this is what the de-duplication is FOR). */
const HANDLER_SOURCE = `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order { }
      criterion InRegion(rgn: string) of Order = region == rgn
      queryHandler ListInRegion(rgn: string): Order paged {
        let r = Orders.run(InRegion(rgn))
        return r
      }
    }
  }
  api A from Sales { route GET "/orders/projections/in_region" -> Orders.ListInRegion }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Orders], dataSources: [s], serves: A, port: 5001 }
}
`;

// NOT asserted here: an app with NO paged read emitting neither the helper nor
// the responder.  There is no such app for a normal aggregate — the auto-
// `findAll` is paged by default (M-T2.6), so every non-abstract controller
// pages.  The emission gate (`contextsHavePagedReads`) is still written
// narrowly, so it stays honest for the read-only/abstract-base shapes.

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla paging bounds — refuse, don't clamp (A16)", () => {
  it("page_param returns a tagged error outside the published bounds instead of clamping", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/order_controller.ex");

    // The clamp is GONE — neither `min(v, limit)` nor the `>= 1`-only guard
    // that silently defaulted a `page=0`.
    expect(ctrl).not.toContain("min(v, limit)");
    expect(ctrl).not.toContain("min(n, limit)");
    expect(ctrl).not.toContain("v when is_integer(v) and v >= 1");

    // In-bounds → `{:ok, n}`; out of bounds → the tagged refusal carrying the
    // `errors[]` entry (RFC 6901 pointer at the offending query param).
    expect(ctrl).toContain(
      "defp __page_bounds(n, _key, limit) when n >= 1 and n <= limit, do: {:ok, n}",
    );
    expect(ctrl).toContain("{:invalid_paging,");
    expect(ctrl).toContain('pointer: "/" <> key');
    expect(ctrl).toContain('message: "must be between 1 and #{limit}"');
  });

  it("the paged action answers the refusal as the shared errors[] 422", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/order_controller.ex");

    // Both reads (the auto-findAll `index` and the declared `recent`) validate
    // BEFORE the repository call — the page controls are bound by `with`
    // clauses, so an out-of-range window never reaches the query.
    for (const action of ["def index(conn, params) do", "def recent(conn, params) do"]) {
      const body = ctrl.slice(ctrl.indexOf(action));
      expect(
        body.indexOf('{:ok, page_arg} <- page_param(params, "page", 1, 1000000)'),
      ).toBeGreaterThan(-1);
      expect(body).toContain('{:ok, page_size_arg} <- page_param(params, "pageSize", 20, 500)');
      expect(body).toContain("{:error, {:invalid_paging, paging_errors}} ->");
      expect(body).toContain("ProblemDetails.validation_errors_response(conn, paging_errors)");
      // The paging clauses precede the read, and the read consumes the BOUND
      // values rather than re-reading the raw params.
      expect(body.indexOf("page_param(params")).toBeLessThan(
        body.indexOf("page_arg, page_size_arg"),
      );
    }

    // The 422 sender is emitted for a paged app even with no wire-rung
    // precondition anywhere (it used to be gated on that alone).
    const pd = file(await generateSystemFiles(SOURCE), "/problem_details.ex");
    expect(pd).toContain("def validation_errors_response(conn, errors) when is_list(errors) do");
    expect(pd).toContain('title: "Validation failed"');
    expect(pd).toContain('detail: "One or more fields are invalid."');
  });

  it("a non-paging `with` failure still falls through unchanged", async () => {
    // Adding an `else` to a `with` turns every previously-RETURNED non-matching
    // term into a WithClauseError.  The catch-all keeps that path behaving
    // exactly as it did before the refusal arm existed.
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/order_controller.ex");
    expect(ctrl).toContain("      other ->\n        other");
  });

  it("the page_param helper is defined exactly once per controller, from one source", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/order_controller.ex");
    expect((ctrl.match(/defp page_param\(/g) ?? []).length).toBe(1);
    expect((ctrl.match(/defp __page_bounds\(/g) ?? []).length).toBe(2); // two clauses, one fn
  });

  it("the paged-run queryHandler controller refuses identically (the de-duplication)", async () => {
    const files = await generateSystemFiles(HANDLER_SOURCE);
    const ctrl = file(files, "lib/d_web/controllers/a_routes_controller.ex");

    // Same reader, same refusal, same sender — this controller carried its OWN
    // clamping copy before the helper was hoisted into `page-param.ts`.
    expect(ctrl).not.toContain("min(v, limit)");
    expect(ctrl).not.toContain("min(n, limit)");
    expect(ctrl).toContain(
      "defp __page_bounds(n, _key, limit) when n >= 1 and n <= limit, do: {:ok, n}",
    );
    const body = ctrl.slice(ctrl.indexOf("def list_in_region(conn, params) do"));
    expect(body).toContain('{:ok, page_arg} <- page_param(params, "page", 1, 1000000)');
    expect(body).toContain("{:error, {:invalid_paging, paging_errors}} ->");
    expect(body).toContain("ProblemDetails.validation_errors_response(conn, paging_errors)");

    // …and the aggregate controller in the SAME app agrees byte-for-byte — one
    // definition, two emitters.
    const agg = file(files, "/controllers/order_controller.ex");
    const grab = (s: string) =>
      s.slice(s.indexOf("defp page_param("), s.indexOf("]}}\n  end") + "]}}\n  end".length);
    expect(grab(ctrl)).toBe(grab(agg));
  });
});
