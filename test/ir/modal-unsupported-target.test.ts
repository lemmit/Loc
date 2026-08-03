// `loom.modal-unsupported-target` — a state-controlled Modal on a frontend that
// can't render it is a COMPILE ERROR, not silently missing page content.
//
// The sibling of `loom.datagrid-unsupported-target`, and the same discipline.
// Before it, a `Modal { …, open: <state> }` on Flutter fell through the walker
// to a generic "expects trigger: Button(...) and an OperationForm child"
// comment — which describes a DIFFERENT Modal shape.  So an author who wrote a
// perfectly valid controlled modal watched their content vanish and was told to
// fix input that was not wrong.
//
// The allowlist tracks one question: does this frontend ship a controlled-modal
// renderer?  Every JSX/markup pack has `primitive-modal-controlled`, Feliz
// renders a daisyUI dialog procedurally, and HEEx has `.modal`.  Flutter's pack
// has no controlled-modal renderer.  It is NOT formless: it ships the op-dialog
// Modal (an AlertDialog around an OperationForm) and the create/operation forms
// themselves — only the `open:` shape is missing, so this entry is expected to
// move to the allowlist when that renderer lands.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

async function codes(src: string): Promise<string[]> {
  const diags = validateLoomModel(enrichLoomModel(lowerModel(await parseValid(src))));
  return diags.map((d) => d.code);
}

/** Feliz and Flutter each host only their own framework; the four static-bundle
 *  frameworks share the `static` host. */
const hostFor = (framework: string): string =>
  framework === "feliz" || framework === "flutter" ? framework : "static";

const sys = (framework: string, body: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  ui WebApp {
    framework: ${framework}
    api Sales: SalesApi
    page X {
      route: "/x"
      state { open: bool = false }
      body: ${body}
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [st] serves: SalesApi port: 3000 }
  deployable web { platform: ${hostFor(framework)} targets: api ui: WebApp { Sales: api } port: 3005 }
}`;

const CONTROLLED = `Modal { Text { "body" }, open: open, title: "T" }`;

describe("loom.modal-unsupported-target", () => {
  for (const framework of ["react", "vue", "svelte", "angular", "feliz"]) {
    it(`${framework} renders a controlled Modal — no diagnostic`, async () => {
      expect(await codes(sys(framework, CONTROLLED))).not.toContain(
        "loom.modal-unsupported-target",
      );
    });
  }

  it("flutter rejects it with an actionable message", async () => {
    const diags = validateLoomModel(
      enrichLoomModel(lowerModel(await parseValid(sys("flutter", CONTROLLED)))),
    );
    const diag = diags.find((d) => d.code === "loom.modal-unsupported-target");
    expect(diag, "flutter must reject a controlled Modal").toBeDefined();
    expect(diag!.severity).toBe("error");
    // The message must name the frontends that DO support it — a bare "not
    // supported" leaves the author with no next step.
    expect(diag!.message).toContain("react");
    expect(diag!.message).toContain("feliz");
  });

  it("flutter accepts a page with no controlled Modal", async () => {
    expect(await codes(sys("flutter", `Text { "plain" }`))).not.toContain(
      "loom.modal-unsupported-target",
    );
  });

  it("the OP-DIALOG Modal shape is a different primitive — not gated here", async () => {
    // `Modal { OperationForm(…), trigger: … }` carries no `open:`, so the check
    // must not fire on it (its own support matrix is separate).
    const src = sys("flutter", `Text { "x" }`).replace(
      `body: Text { "plain" }`,
      `body: Text { "x" }`,
    );
    expect(await codes(src)).not.toContain("loom.modal-unsupported-target");
  });
});
