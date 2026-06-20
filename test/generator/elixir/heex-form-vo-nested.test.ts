// HEEx form — value-object field renders as <.inputs_for :let={…}> nested form.
//
// Phase D Slice D from
// `docs/plans/platform-expansion-roadmap.md`.  Closes the VO half
// of the "expand types beyond text input" gap; arrays remain as
// future work (need event-handler scaffolding for add/remove).
//
// What this file pins:
//   1. A VO-typed aggregate field renders as
//      `<fieldset><legend>…</legend><.inputs_for :let={<f>_form}
//         field={@form[:<f>]}> … sub-inputs … </.inputs_for></fieldset>`
//      where each VO field becomes a nested `<.input>` whose
//      field-binding is the local `<f>_form[:<sub>]` (no `@` prefix
//      because the let-bound var is a local, not an assign).
//   2. VO sub-fields dispatch through the same renderer recursively
//      — primitives become typed inputs, enums become selects.
//   3. Optional VO fields unwrap before the VO lookup.
//   4. Operation-modal forms (renderModal path) honour VO nesting
//      too (the same renderFieldInputForField is the dispatch core).
//   5. Anti-regression — non-VO field types stay on their previous
//      dispatch shape.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

function phoenixSystem(uiOrderBody: string, extras = ""): string {
  return `
  system Demo {
    subdomain M {
      context C {
        valueobject Money {
          amount: decimal
          currency: string
        }
        ${extras}
        aggregate Product {
          sku: string
          price: Money
          notes: string
          derived display: string = sku
        }
        repository Products for Product { }
      }
    }
    api DemoApi from M
    ui DemoUi {
      page NewProduct {
        route: "/products/new"
        body: ${uiOrderBody}
      }
    }
    deployable phoenixApp {
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000
    }
  }
`;
}

function findNewProductHeex(files: Map<string, string>): string {
  for (const [path, content] of files) {
    if (path.endsWith("/new_product_live.ex")) return content;
  }
  throw new Error(
    `NewProduct LiveView not found. Files: ${[...files.keys()]
      .filter((p) => p.includes("live"))
      .slice(0, 5)
      .join(", ")}`,
  );
}

describe("HEEx form — value-object field renders as <.inputs_for> nested form", () => {
  it("emits a <fieldset><.inputs_for>…</.inputs_for></fieldset> wrapping VO sub-inputs", async () => {
    const files = await generateSystemFiles(phoenixSystem(`CreateForm { of: Product }`));
    const heex = findNewProductHeex(files);
    // Fieldset wrapper with humanized legend.
    expect(heex).toMatch(/<fieldset><legend>Price<\/legend>/);
    // inputs_for :let={…} bound to @form[:price].
    expect(heex).toMatch(/<\.inputs_for :let=\{price_form\} field=\{@form\[:price\]\}>/);
    // Sub-inputs reference the local `price_form` (no @ prefix).
    expect(heex).toMatch(/<\.input field=\{price_form\[:amount\]\} type="number"/);
    expect(heex).toMatch(/<\.input field=\{price_form\[:currency\]\} type="text"/);
    // Closing tags.
    expect(heex).toContain(`</.inputs_for></fieldset>`);
  });

  it("VO sub-fields dispatch recursively — enum inside VO renders as select", async () => {
    // Use a separate fixture so Product.price points at the Price VO
    // (with a currency: Currency enum field) rather than the default
    // Money VO.  Recursing into the VO should hit the enum branch
    // and emit a select-with-options.
    const files = await generateSystemFiles(`
      system Demo {
        subdomain M {
          context C {
            enum Currency { USD, EUR, GBP }
            valueobject Price {
              amount: decimal
              currency: Currency
            }
            aggregate Product {
              sku: string
              price: Price
              derived display: string = sku
            }
            repository Products for Product { }
          }
        }
        api DemoApi from M
        ui DemoUi {
          page NewProduct { route: "/products/new" body: CreateForm { of: Product } }
        }
        deployable phoenixApp {
          platform: elixir, contexts: [C], serves: DemoApi,
          ui: DemoUi, port: 4000
        }
      }
    `);
    const heex = findNewProductHeex(files);
    expect(heex).toMatch(
      /<\.input field=\{price_form\[:currency\]\}[^>]*type="select"[^>]*options=\{\["USD", "EUR", "GBP"\]\}/,
    );
  });

  it("optional `Money?` field still routes to nested form", async () => {
    const files = await generateSystemFiles(`
      system Demo {
        subdomain M {
          context C {
            valueobject Money { amount: decimal currency: string }
            aggregate Product {
              sku: string
              price: Money?
              derived display: string = sku
            }
            repository Products for Product { }
          }
        }
        api DemoApi from M
        ui DemoUi {
          page NewProduct { route: "/products/new" body: CreateForm { of: Product } }
        }
        deployable phoenixApp {
          platform: elixir, contexts: [C], serves: DemoApi,
          ui: DemoUi, port: 4000
        }
      }
    `);
    const heex = findNewProductHeex(files);
    expect(heex).toMatch(/<\.inputs_for :let=\{price_form\}/);
  });

  it("non-VO fields stay on previous dispatch (anti-regression)", async () => {
    const files = await generateSystemFiles(phoenixSystem(`CreateForm { of: Product }`));
    const heex = findNewProductHeex(files);
    // `sku: string` still a plain text input.
    expect(heex).toMatch(/<\.input field=\{@form\[:sku\]\} type="text"/);
    // `notes: string` likewise.
    expect(heex).toMatch(/<\.input field=\{@form\[:notes\]\} type="text"/);
  });

  it("operation-modal form (renderModal path) honours VO nesting", async () => {
    // The walker's renderModal builds its input list from operation
    // params via the same renderFieldInputForField; ctx.valueObjectsByName
    // threads through.  storefront-elixir's `topUp(amount: Money)`
    // already exercises this path — the test here pins the shape
    // explicitly against a minimal fixture.
    const files = await generateSystemFiles(`
      system Demo {
        subdomain M {
          context C {
            valueobject Money { amount: decimal currency: string }
            aggregate Wallet {
              balance: Money
              derived display: string = "wallet"
              operation topUp(amount: Money) { balance := amount }
            }
            repository Wallets for Wallet { }
          }
        }
        api DemoApi from M
        ui DemoUi with scaffold(subdomains: [M]) {}
        deployable phoenixApp {
          platform: elixir, contexts: [C], serves: DemoApi,
          ui: DemoUi, port: 4000
        }
      }
    `);
    // Find the detail live module that hosts the top_up modal.
    let foundNested = false;
    for (const [path, content] of files) {
      if (
        path.endsWith(".ex") &&
        content.includes("top_up_form") &&
        content.includes("<.inputs_for :let={amount_form} field={@top_up_form[:amount]}>") &&
        content.includes('<.input field={amount_form[:amount]} type="number"') &&
        content.includes('<.input field={amount_form[:currency]} type="text"')
      ) {
        foundNested = true;
        break;
      }
    }
    expect(foundNested, "operation-modal Money param should render as nested form").toBe(true);
  });
});
