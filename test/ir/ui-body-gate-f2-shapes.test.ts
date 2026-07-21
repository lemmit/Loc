// Bucket V / F2 — adversarial coverage of the method-call receiver-resolution
// gate (`loom.method-call-unresolved-receiver`).  Pins that every body-method-
// call shape the React/Vue walker resolves CLEANLY (aggregate-rooted op,
// api-param-rooted op, `<wf>.instances.all`
// workflow-instance hook, and a `CreateForm` `onSubmit:` shell-local) is
// ADMITTED, while a genuinely-unresolvable receiver still REJECTS.  Guards
// against F2 widening into a false positive that would break valid `.ddd`.
//
// Every case asserts the scaffolding parses before checking the verdict, so a
// shape can't pass vacuously on a dropped (unparseable) body.
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function probe(source: string): Promise<{ parseErr: string[]; f2: string[] }> {
  const { model, doc } = await parseString(source, { validate: false });
  const parseErr = (doc.parseResult.parserErrors ?? []).map((e) => e.message);
  if (parseErr.length) return { parseErr, f2: [] };
  const f2 = validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.method-call-unresolved-receiver")
    .map((d) => d.message);
  return { parseErr: [], f2 };
}

// ui-compose binding MUST be the last deployable clause (grammar gap:
// UiComposeBinding has no trailing `,?`), and `state {}` after `body:`.
const page = (binding: string, dep: string, body: string) => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Customer { name: string }
        aggregate Order { customerId: Customer id  tags: string[] }
        repository Customers for Customer { }
        repository Orders for Order { }
        workflow placeOrder { create(orderId: Order id) { let o = Orders.getById(orderId) } }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      ${binding}
      page X {
        route: "/x/:id"
        body: Button { "Go", onClick: e => { ${body} } }
        state { draft: int = 0 }
      }
    }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, port: 3001${dep} }
  }
`;

const form = (body: string) => `
  system S {
    subdomain Sales {
      context Sales {
        aggregate Order { customerId: string }
        repository Orders for Order { }
      }
    }
    api SalesApi from Sales
    ui WebApp {
      api Sales: SalesApi
      page X { route: "/new" body: ${body} }
    }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, port: 3001, ui: WebApp { Sales: api } }
  }
`;

describe("F2 adversarial matrix", () => {
  const admits: Array<[string, string]> = [
    ["aggregate-rooted op", page("", "", "Order.create(draft)")],
    [
      "api-param-rooted op",
      page("api Sales: SalesApi", ", ui: WebApp { Sales: api }", "Sales.Order.create(draft)"),
    ],
    ["workflow instances.all then call", page("", "", "placeOrder.instances.all.refetch()")],
    [
      "CreateForm onSubmit shell-local",
      form("CreateForm(of: Order, onSubmit: v => create.mutateAsync(v))"),
    ],
  ];
  for (const [name, src] of admits) {
    it(`admits: ${name}`, async () => {
      const { parseErr, f2 } = await probe(src);
      expect(parseErr, `scaffolding must parse: ${JSON.stringify(parseErr)}`).toEqual([]);
      expect(f2).toEqual([]);
    });
  }

  const rejects: Array<[string, string]> = [
    ["bogus aggregate name", page("", "", "Bogus.create(draft)")],
    ["bogus free name", page("", "", "whatever.frobnicate(draft)")],
  ];
  for (const [name, src] of rejects) {
    it(`rejects: ${name}`, async () => {
      const { parseErr, f2 } = await probe(src);
      expect(parseErr, `scaffolding must parse: ${JSON.stringify(parseErr)}`).toEqual([]);
      expect(f2.length).toBeGreaterThan(0);
    });
  }

  // Grammar fact: a member suffix after a call suffix (`X.foo(args).bar`)
  // does not parse in a page-body expression, so chained-hook receivers
  // (`Customer.byId(id).data`) never reach F2 — no false-positive surface.
  it("grammar: call-then-member chain does not parse (so F2 never sees it)", async () => {
    const { parseErr } = await probe(page("", "", "Order.byId(id).data.refetch()"));
    expect(parseErr.length).toBeGreaterThan(0);
  });
});
