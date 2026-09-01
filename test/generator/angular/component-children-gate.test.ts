// F2-CFE-8 — `loom.component-children-unsupported`.
//
// A user component invoked with CHILDREN:
//
//   component Panel(label: string) { Card { Text { label }, Slot { } } }
//   page P { body: Panel("a", Text { "child" }) }
//
// React emits `<Panel label="a"><Text>child</Text></Panel>` and the body's
// `Slot { }` receives the child.  Angular has no PascalCase component tag, so
// its call site is `<ng-container [ngComponentOutlet]="Panel"
// [ngComponentOutletInputs]='{ label: "a" }'></ng-container>` — and
// `ngComponentOutlet` cannot project content from a template.  The extra
// positional argument hit `if (paramName === undefined) continue;` in
// `angular-target.renderUserComponent` and was DROPPED: grepping the whole
// emitted Angular project for the child text returned nothing, with no
// degradation comment anywhere in the output.  Only the renderer's own doc
// comment admitted it.
//
// Now named.  Angular-scoped — react/vue/svelte render it correctly, so a
// wider gate would be a false refusal.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/index.js";

async function childrenDiags(platform: string, pageBody: string): Promise<string[]> {
  const loom = await buildLoomModel(`
    system Demo {
      subdomain S { context C { } }
      ui Web {
        component Panel(label: string) { body: Card { Text { label }, Slot { } } }
        page P { route: "/p" body: ${pageBody} }
      }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
    }
  `);
  return validateLoomModel(loom)
    .filter((d) => d.code === "loom.component-children-unsupported")
    .map((d) => d.message);
}

const WITH_CHILD = `Panel("a", Text { "child" })`;
const NO_CHILD = `Panel("a")`;

describe("loom.component-children-unsupported", () => {
  it("angular: a component invoked with children is refused, not silently dropped", async () => {
    const d = await childrenDiags("angular", WITH_CHILD);
    expect(d).toHaveLength(1);
    expect(d[0]).toContain("page 'P'");
    expect(d[0]).toContain("component 'Panel'");
    // The message has to say WHY, or it is just a refusal.
    expect(d[0]).toContain("ngComponentOutlet");
  });

  it("angular: the same component with NO children is fine", async () => {
    expect(await childrenDiags("angular", NO_CHILD)).toEqual([]);
  });

  // The frontends that render children correctly must not be refused.
  for (const fw of ["react", "vue", "svelte"]) {
    it(`${fw}: children are supported, so the gate stays silent`, async () => {
      expect(await childrenDiags(fw, WITH_CHILD)).toEqual([]);
    });
  }
});
