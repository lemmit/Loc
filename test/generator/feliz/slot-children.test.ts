// `Slot { }` on Feliz — the children a call site passed never arrived.
//
// Two halves of one gap:
//   1. The component body's `Slot { }` fell through to the walker's JSX
//      `{children}` default, which in F# is an ANONYMOUS RECORD over an unbound
//      `children` — `dotnet fable` rejects it.
//   2. `felizTarget.renderUserComponent` mapped args to declared params and
//      `continue`d past the rest, so `Panel("Hello", Text { "inside" })` dropped
//      the `Text` outright.
//
// The component's single props record now carries a `children: ReactElement`
// field when its body has a slot, and the call site fills it — with the walked
// markup, or `Html.none` when none was passed (an F# anonymous record is exact:
// an unfilled field is a type error, not an absent prop).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const sys = (pageBody: string) => `
system SlotDemo {
  subdomain S {
    context Ops {
      aggregate Job { name: string }
      repository Jobs for Job { }
    }
  }
  ui Web {
    framework: feliz
    component Panel(title: string) {
      body: Stack {
        Heading { title, level: 2 },
        Slot { }
      }
    }
    page Home {
      route: "/"
      body: Stack { ${pageBody} }
    }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable web { platform: feliz targets: api ui: Web port: 3007 }
}`;

async function appFs(pageBody: string): Promise<string> {
  const files = await generateSystemFiles(sys(pageBody));
  return (
    files.get("web/src/App.fs") ?? [...files.entries()].find(([k]) => k.endsWith("App.fs"))![1]
  );
}

describe("feliz — a component's Slot { } and the children a caller passes", () => {
  it("declares the children field and reads it in the body", async () => {
    const fs = await appFs(`Panel("Hi", Text { "inside" })`);
    expect(fs).toContain("let Panel (props: {| title: string; children: ReactElement |}) =");
    expect(fs).toContain("props.children");
    // The defect: `{children}` is an F# anonymous record over an unbound name.
    expect(fs).not.toContain("{children}");
  });

  it("passes the caller's markup as the children field", async () => {
    const fs = await appFs(`Panel("Hi", Text { "inside" })`);
    expect(fs).toMatch(/Panel \{\| title = "Hi"; children = Html\.p \[ Html\.text \(/);
    // The child is WALKED (markup), not run through the expression renderer.
    expect(fs).toContain("inside");
  });

  it("folds several children into one fragment", async () => {
    const fs = await appFs(`Panel("Hi", Text { "a" }, Text { "b" })`);
    // One `ReactElement` field, so a run of children becomes a fragment.
    expect(fs).toMatch(/children = React\.fragment \[ Html\.p .*; Html\.p .* \]/);
  });

  it("fills the field with Html.none when the caller passed no children", async () => {
    // An F# anonymous record is EXACT — omitting the field would not typecheck,
    // so an empty slot has to be spelled, not skipped.
    const fs = await appFs(`Panel("Hi")`);
    expect(fs).toContain(`Panel {| title = "Hi"; children = Html.none |}`);
  });

  it("leaves a component with no Slot { } byte-identical", async () => {
    const files = await generateSystemFiles(`
system NoSlot {
  subdomain S { context Ops { aggregate Job { name: string } repository Jobs for Job { } } }
  ui Web {
    framework: feliz
    component Plaque(title: string) { body: Stack { Heading { title, level: 2 } } }
    page Home { route: "/" body: Stack { Plaque("Hi") } }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable web { platform: feliz targets: api ui: Web port: 3007 }
}`);
    const fs = [...files.entries()].find(([k]) => k.endsWith("App.fs"))![1];
    expect(fs).toContain("let Plaque (props: {| title: string |}) =");
    expect(fs).toContain(`Plaque {| title = "Hi" |}`);
    // No slot in the body → no synthetic props field, no call-site argument.
    expect(fs).not.toContain("children: ReactElement");
    expect(fs).not.toContain("children =");
  });
});
