import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// HEEx CoreComponents `<.input>` field a11y (M-T1.12 follow-up).
//
// The emitted `core_components.ex` `input/1` clauses now link each control to
// its error text: `aria-invalid` flips to "true" only when the field carries
// errors, and `aria-describedby` points at the `<.error>` element, which is
// given a stable `id={"#{@id}-error"}`.  WCAG 3.3.1 (Error Identification) /
// 4.1.2 (Name, Role, Value).  This mirrors the field aria already wired on the
// library-backed frontends (Feliz slice 6, React/Vue via their libs).
// ---------------------------------------------------------------------------

const SRC = `
system Demo {
  subdomain M {
    context C {
      aggregate Doc { name: string  derived display: string = name }
      repository Docs for Doc { }
    }
  }
  api DemoApi from M
  ui DemoUi {
    page Landing { route: "/" body: Stack { Heading { "Docs", level: 1 } } }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [C], serves: DemoApi,
    ui: DemoUi, port: 4000
  }
}
`;

async function coreComponents(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  for (const [p, c] of files) {
    if (p.endsWith("/core_components.ex")) return c;
  }
  throw new Error("core_components.ex not found");
}

describe("HEEx CoreComponents <.input> field aria", () => {
  it("wires aria-invalid + aria-describedby on every input clause", async () => {
    const ex = await coreComponents();
    // Each control (checkbox/select/textarea/default text) links to its error.
    const invalid = ex.match(/aria-invalid=\{@errors != \[\] && "true"\}/g) ?? [];
    const describedby = ex.match(/aria-describedby=\{@errors != \[\] && "#\{@id\}-error"\}/g) ?? [];
    expect(invalid.length).toBe(4);
    expect(describedby.length).toBe(4);
  });

  it("gives the <.error> component a stable id the input can reference", async () => {
    const ex = await coreComponents();
    // The error component accepts an optional id...
    expect(ex).toContain("attr :id, :string, default: nil");
    expect(ex).toMatch(/def error\(assigns\) do\s+~H"""\s+<p id=\{@id\}/);
    // ...and every input clause passes the matching `<id>-error` id.
    const errorCalls = ex.match(/<\.error :for=\{msg <- @errors\} id=\{"#\{@id\}-error"\}>/g) ?? [];
    expect(errorCalls.length).toBe(4);
  });
});
