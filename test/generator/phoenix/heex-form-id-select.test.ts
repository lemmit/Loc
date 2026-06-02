// HEEx form — X id field renders as <.input type="select"> with
// mount-time options loading.
//
// Phase D Slice C from
// `docs/plans/platform-expansion-roadmap.md`.  Closes the second
// half of the walker TODO at `heex-walker.ts:1030`: T id types
// were falling through to text input.
//
// What this file pins:
//   1. An aggregate field with type `<Other> id` renders as
//      `<.input type="select" options={@<other_snake>_options}>` —
//      the options-list reference is by name; the actual list is
//      bound at mount/3.
//   2. The walker records the target aggregate on
//      `WalkResult.idOptionsBindings`; renderMount in liveview-emit.ts
//      iterates these and emits one
//      `socket |> assign(:<x_snake>_options, <Ctx>.list_<x_snake>s!() |> Enum.map(...))`
//      per binding.
//   3. When the target aggregate declares `derived display: string`,
//      the option-list load uses `list_<x>!(load: [:display])` and
//      maps each record to `{r.display, r.id}` — proper
//      human-readable label.
//      When NO display is declared (test below), falls back to the
//      v0 id-as-label shape `{to_string(r.id), r.id}`.
//   4. Non-id fields stay on their previous dispatch
//      (anti-regression).
//   5. Optional `X id?` still routes to select (the optional
//      wrapper unwraps before the id check).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const phoenixSystem = (orderField: string): string => `
  system Demo {
    subdomain M {
      context C {
        aggregate Customer {
          name: string
          derived display: string = name
        }
        repository Customers for Customer { }
        aggregate Order {
          ${orderField}
          notes: string
          derived display: string = notes
        }
        repository Orders for Order { }
      }
    }
    api DemoApi from M
    ui DemoUi {
      page NewOrder {
        route: "/orders/new"
        body: CreateForm { of: Order }
      }
    }
    deployable phoenixApp {
      platform: phoenix, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000
    }
  }
`;

function findNewOrderHeex(files: Map<string, string>): string {
  for (const [path, content] of files) {
    if (path.endsWith("/new_order_live.ex")) return content;
  }
  throw new Error(
    `NewOrder LiveView not found. Files: ${[...files.keys()]
      .filter((p) => p.includes("live"))
      .slice(0, 5)
      .join(", ")}`,
  );
}

describe("HEEx form — `X id` field renders as <.input type='select'>", () => {
  it("emits select input with @<target>_options reference", async () => {
    const files = await generateSystemFiles(phoenixSystem("customerId: Customer id"));
    const heex = findNewOrderHeex(files);
    expect(heex).toMatch(
      /<\.input field=\{@form\[:customer_id\]\} type="select" label="Customer Id" options=\{@customer_options\} \/>/,
    );
  });

  it("optional `X id?` field still routes to select", async () => {
    const files = await generateSystemFiles(phoenixSystem("customerId: Customer id?"));
    const heex = findNewOrderHeex(files);
    expect(heex).toMatch(/type="select"[^>]*options=\{@customer_options\}/);
  });

  it("renderMount emits an option-load assign per target aggregate", async () => {
    const files = await generateSystemFiles(phoenixSystem("customerId: Customer id"));
    const heex = findNewOrderHeex(files);
    // The mount stub assigns :<target>_options from the Ash code
    // interface list-call.  Customer in this fixture has
    // `derived display: string = name`, so the load includes
    // `load: [:display]` and the option label is `r.display`.
    expect(heex).toMatch(
      /\|> assign\(:customer_options, [\w.]+\.list_customers!\(load: \[:display\]\) \|> Enum\.map\(fn r -> \{r\.display, r\.id\} end\)\)/,
    );
  });

  it("falls back to id-as-label when target aggregate has no `derived display`", async () => {
    // No `derived display: string = ...` on Customer.  The walker
    // would still need a display for `string(<agg>)` semantics, but
    // for id-selects without one we fall back to showing the uuid as
    // the option label so the select stays functional (right value
    // flows through on submit).
    const files = await generateSystemFiles(`
      system Demo {
        subdomain M {
          context C {
            aggregate Customer { name: string }
            repository Customers for Customer { }
            aggregate Order {
              customerId: Customer id
              derived display: string = "ord"
            }
            repository Orders for Order { }
          }
        }
        api DemoApi from M
        ui DemoUi {
          page NewOrder { route: "/orders/new" body: CreateForm { of: Order } }
        }
        deployable phoenixApp {
          platform: phoenix, contexts: [C], serves: DemoApi,
          ui: DemoUi, port: 4000
        }
      }
    `);
    const heex = findNewOrderHeex(files);
    // No load: [:display] in the list call, fallback {to_string, id}
    // shape in the Enum.map.
    expect(heex).toMatch(
      /\|> assign\(:customer_options, [\w.]+\.list_customers!\(\) \|> Enum\.map\(fn r -> \{to_string\(r\.id\), r\.id\} end\)\)/,
    );
  });

  it("multiple distinct `X id` targets all get their own option-load", async () => {
    const files = await generateSystemFiles(`
      system Demo {
        subdomain M {
          context C {
            aggregate Customer { name: string  derived display: string = name }
            repository Customers for Customer { }
            aggregate Product { sku: string  derived display: string = sku }
            repository Products for Product { }
            aggregate Order {
              customerId: Customer id
              productId: Product id
              derived display: string = "ord"
            }
            repository Orders for Order { }
          }
        }
        api DemoApi from M
        ui DemoUi {
          page NewOrder {
            route: "/orders/new"
            body: CreateForm { of: Order }
          }
        }
        deployable phoenixApp {
          platform: phoenix, contexts: [C], serves: DemoApi,
          ui: DemoUi, port: 4000
        }
      }
    `);
    const heex = findNewOrderHeex(files);
    expect(heex).toMatch(/\|> assign\(:customer_options,/);
    expect(heex).toMatch(/\|> assign\(:product_options,/);
    // Both selects reference their own option-var.
    expect(heex).toMatch(/options=\{@customer_options\}/);
    expect(heex).toMatch(/options=\{@product_options\}/);
  });

  it("non-id fields stay on their previous input types", async () => {
    // Anti-regression: the dispatch for id shouldn't divert
    // string/int/bool/datetime/enum to select.
    const files = await generateSystemFiles(phoenixSystem("customerId: Customer id"));
    const heex = findNewOrderHeex(files);
    // `notes: string` still text-input.
    expect(heex).toMatch(/<\.input field=\{@form\[:notes\]\} type="text"/);
  });
});
