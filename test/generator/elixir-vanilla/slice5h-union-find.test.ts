import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// Union-returning finds on the vanilla foundation (the union-find absence
// producer).  `find locate(...): Order or NotFound` is a single-get whose `nil`
// is the absent variant: NotFound (an error payload with `resource`) → an
// RFC-7807 ProblemDetails at its status carrying `resource: "Order"`, a found
// record → the SUCCESS variant returned directly (untagged) at 200 —
// wire-identical to `Order?` and every other backend (exception-less.md §4,
// the BUG-005 fix).  `foundation: vanilla` now runs the union-find shape check
// (the elixir exemption is Ash-only).
// ---------------------------------------------------------------------------

const source = () => `
system S {
  subdomain Core {
    context Shop {
      error NotFound { resource: string }
      aggregate Order with crudish { customerId: string }
      repository Orders for Order {
        find locate(ref: string): Order or NotFound where this.customerId == ref
      }
    }
  }
  api A from Core
  storage pg { type: postgres }
  resource st { for: Shop, kind: state, use: pg }
  deployable api { platform: elixir
    contexts: [Shop] dataSources: [st] serves: A port: 4000 }
}
`;

const get = (m: Map<string, string>, suffix: string) =>
  m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

describe("vanilla — union-find absence producer", () => {
  it("translates the absent variant and returns the found record untagged", async () => {
    const f = await generateSystemFiles(source());
    const ctl = get(f, "/controllers/order_controller.ex");
    expect(ctl).toContain("def locate(conn, params) do");
    // absent (NotFound) → ProblemDetails at its status, carrying resource: "Order"
    expect(ctl).toContain(
      'problem_variant(conn, 404, "/errors/not-found", "Not Found", %{resource: "Order"})',
    );
    // found → success variant returned directly, untagged (no `:type`)
    expect(ctl).toContain("json(conn, serialize(record))");
    expect(ctl).not.toContain("Map.put(serialize(record), :type");
    expect(ctl).toContain("defp problem_variant(conn, status, type, title, data) do");
    // route mounted
    expect(get(f, "/router.ex")).toContain('get "/orders/locate", OrderController, :locate');
  });

  it("the repository find is a single-get returning {:ok, record | nil}", async () => {
    const repo = get(await generateSystemFiles(source()), "/shop/order_repository.ex");
    expect(repo).toContain("def locate(ref) do");
    expect(repo).toContain("{:ok, Repo.one(query)}");
  });

  it("the union-find shape check passes for a well-shaped union find", async () => {
    const { model } = await parseString(source(), { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    // A well-shaped union find (Order + NotFound{resource}) passes.
    expect(diags.find((d) => d.code === "loom.union-find-shape-unsupported")).toBeUndefined();
  });
});
