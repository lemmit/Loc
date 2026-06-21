import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx Slot primitive (parity finding #5).  `Slot()` inside a user
// `component` body renders the children the parent passed in.  On HEEx it
// emits `{render_slot(@inner_block)}` and the component emitter declares the
// matching `slot :inner_block` (driven by the walker's `usesSlot` flag).
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc {
        name: string
        derived display: string = name
      }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    component Panel(title: string) {
      body: Card { Text { title }, Slot {} }
    }
    component Plain(label: string) {
      body: Text { label }
    }
    page Landing {
      route: "/"
      body: Stack { Heading { "Hi" } }
    }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [C], serves: DemoApi,
    ui: DemoUi, port: 4000
  }
}
`;

async function uiComponents(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/ui_components.ex")) return c;
  }
  throw new Error("ui_components.ex not found");
}

describe("HEEx Slot primitive (parity finding #5)", () => {
  it("a component body's Slot() emits render_slot + declares slot :inner_block", async () => {
    const comps = await uiComponents();
    expect(comps).toMatch(/slot :inner_block, required: true/);
    expect(comps).toContain("{render_slot(@inner_block)}");
  });

  it("declares the slot only for the component that uses Slot (one declaration)", async () => {
    const comps = await uiComponents();
    // `Panel` uses Slot; `Plain` does not — so exactly one slot declaration.
    expect(comps.match(/slot :inner_block/g)?.length).toBe(1);
  });
});
