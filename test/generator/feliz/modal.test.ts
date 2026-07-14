// Feliz Modal — the scaffold detail's action dialog (one `Modal` per public
// operation, each wrapping an `OperationForm`).  Rendered as a native `<details>`
// DISCLOSURE (no MVU open-state): the `<summary>` is the trigger label, the
// wrapped operation form (via the shared `renderOperationForm` seam) is revealed
// on click.  Proven to compile via `dotnet fable` (SDK:8.0) + vite build.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A scaffolded aggregate with a public operation → its detail page hosts a
// `Modal` wrapping the op's `OperationForm`.
const SCAFFOLD = `
system Shop {
  api ShopApi from Catalog
  subdomain Catalog {
    context Cat {
      aggregate Product with crudish {
        name:  string
        price: money
        operation rename(newName: string) { name := newName }
      }
      repository Products for Product { }
    }
  }
  storage db { type: postgres }
  resource catState { for: Cat, kind: state, use: db }
  ui WebApp with scaffold(aggregates: [Product]) {
    api Shop: ShopApi
  }
  deployable api { platform: node contexts: [Cat] dataSources: [catState] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz modal", () => {
  it("renders a Modal as a <details> disclosure wrapping the operation form", async () => {
    const app = await appFs(SCAFFOLD);
    // A native disclosure styled as a daisyUI `collapse`: the trigger label is
    // the summary; no MVU open-state.
    expect(app).toContain(
      'Html.details [ prop.className "collapse collapse-arrow border border-base-300 bg-base-200"; prop.children [',
    );
    expect(app).toContain(
      'Html.summary [ prop.className "collapse-title font-medium"; prop.text "Rename" ]',
    );
    // The wrapped operation form renders inline inside the disclosure (its inputs
    // + the id-carrying submit — the same `renderOperationForm` markup).
    expect(app).toContain('prop.placeholder "newName"');
    expect(app).toContain(
      'prop.onClick (fun _ -> dispatch (SubmitRenameProductForm id)); prop.text "Rename Product"',
    );
    // No dead trigger-only button leaks (the pre-disclosure inert placeholder).
    expect(app).not.toContain('prop.className "loom-modal-trigger"');
  });

  it("validates cleanly through validateLoomModel", async () => {
    const { errors } = await parseString(SCAFFOLD, { validate: true });
    expect(errors).toEqual([]);
  });
});
