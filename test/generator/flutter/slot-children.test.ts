// `Slot { }` on Flutter — the children a call site passed never arrived.
//
// Two halves of one gap:
//   1. The component body's `Slot { }` fell through to the walker's JSX
//      `{children}` default.  In Dart that is a SET literal over an unbound
//      name, sitting inside a `<Widget>[…]` list — neither a name that resolves
//      nor a type that fits.
//   2. `flutterTarget.renderUserComponent` mapped args to declared params and
//      `continue`d past the rest, so `Panel('Hi', Text { 'inside' })` dropped
//      the `Text` outright.
//
// The widget now takes an OPTIONAL `Widget? child` constructor param (Flutter's
// own name for a single-widget slot), the slot renders it with a zero-size
// fallback, and the call site passes the walked markup.

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
  ui App {
    framework: flutter
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
  deployable app { platform: flutter targets: api ui: App port: 3007 }
}`;

/** The generated components file + the home page, concatenated. */
async function dart(pageBody: string): Promise<string> {
  const files = await generateSystemFiles(sys(pageBody));
  let all = "";
  for (const [path, content] of files) {
    if (path.endsWith("components.dart") || path.endsWith("home_page.dart")) {
      all += `\n${content}`;
    }
  }
  return all;
}

describe("flutter — a component's Slot { } and the children a caller passes", () => {
  it("declares an optional child param and renders it with a zero-size fallback", async () => {
    const out = await dart(`Panel("Hi", Text { "inside" })`);
    expect(out).toContain("const Panel({super.key, required this.title, this.child});");
    expect(out).toContain("final Widget? child;");
    expect(out).toContain("(child ?? const SizedBox.shrink())");
    // The defect: `{children}` is a Dart SET literal over an unbound name.
    expect(out).not.toContain("{children}");
  });

  it("passes the caller's markup as the child argument", async () => {
    const out = await dart(`Panel("Hi", Text { "inside" })`);
    expect(out).toMatch(/Panel\(title: 'Hi', child: Text\(/);
    expect(out).toContain("inside");
  });

  it("folds several children into one min-height Column", async () => {
    const out = await dart(`Panel("Hi", Text { "a" }, Text { "b" })`);
    expect(out).toMatch(
      /child: Column\(mainAxisSize: MainAxisSize\.min, children: <Widget>\[Text\(.*\), Text\(.*\)\]\)/,
    );
  });

  it("omits the argument when the caller passed no children — the param is optional", async () => {
    const out = await dart(`Panel("Hi")`);
    expect(out).toContain("Panel(title: 'Hi')");
    // Still constructs: `this.child` is not `required`.
    expect(out).toContain("const Panel({super.key, required this.title, this.child});");
  });

  it("leaves a component with no Slot { } byte-identical", async () => {
    const files = await generateSystemFiles(`
system NoSlot {
  subdomain S { context Ops { aggregate Job { name: string } repository Jobs for Job { } } }
  ui App {
    framework: flutter
    component Plaque(title: string) { body: Stack { Heading { title, level: 2 } } }
    page Home { route: "/" body: Stack { Plaque("Hi") } }
  }
  api OpsApi from S
  storage primary { type: postgres }
  resource st { for: Ops, kind: state, use: primary }
  deployable api { platform: node contexts: [Ops] dataSources: [st] serves: OpsApi port: 4400 }
  deployable app { platform: flutter targets: api ui: App port: 3007 }
}`);
    const comp = [...files.entries()].find(([k]) => k.endsWith("components.dart"))![1];
    expect(comp).toContain("const Plaque({super.key, required this.title});");
    expect(comp).not.toContain("Widget? child");
  });
});
