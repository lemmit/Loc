// HEEx CreateForm — stamp-target fields never render as client inputs.
//
// S1(b) sibling of the JS-walker fix (`walker-form-of.test.ts`): the HEEx
// `renderForm` used to iterate raw `agg.fields`, so a field written by a
// `stamp onCreate` (server-owned; promoted to `access: managed` by
// `promoteStampTargets`) still surfaced as an editable `<.input>` — while
// the save path stamps its real value at persist.  The form now renders the
// create-input contract (`createInputFields`), matching every backend's
// Create request DTO.
//
// What this file pins:
//   1. The stamped field emits no `<.input>` in the LiveView form.
//   2. Client-suppliable fields (incl. optionals — the HEEx form has no
//      update flow to defer them to) still render.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYSTEM = `
  system Demo {
    user { id: guid  role: string }
    subdomain M {
      context C {
        aggregate Order {
          notes: string
          memo: string?
          createdByRole: string
          stamp onCreate { createdByRole := currentUser.role }
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
      platform: elixir, contexts: [C], serves: DemoApi,
      ui: DemoUi, port: 4000, auth: required
    }
  }
`;

function findNewOrderHeex(files: Map<string, string>): string {
  for (const [path, content] of files) {
    if (path.endsWith("/new_order_live.ex")) return content;
  }
  throw new Error(`NewOrder LiveView not found.  Files: ${[...files.keys()].join(", ")}`);
}

describe("HEEx CreateForm renders the create-input contract (S1b)", () => {
  it("stamp-target field emits no input; client fields (incl. optional) do", async () => {
    const files = await generateSystemFiles(SYSTEM);
    const heex = findNewOrderHeex(files);
    expect(heex).toContain("@form[:notes]");
    expect(heex).toContain("@form[:memo]");
    expect(heex).not.toContain("@form[:created_by_role]");
  });
});
