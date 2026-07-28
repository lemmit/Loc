// `loom.component-prop-type` (M-T6.18 gap #3) — a page-body user-`component`
// invocation must pass prop values that match the component's declared param
// types. Both forms are covered: the paren call (`Panel(amount: "x")`,
// positional or named) and the brace builder (`Panel { amount: "x" }`). A
// mismatched prop compiled the .ddd and only failed the emitted frontend's tsc.
// `slot`/`action` params (JSX / callback) are skipped; optional/defaulted params
// need no arg, so only PROVIDED props are checked.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

const sys = (body: string) => `
system S {
  subdomain M { context C { } }
  ui WebApp {
    component CounterBadge(n: int) { body: Badge { "Count: " + string(n) } }
    component LabeledIcon(icon: string, label: string) { body: Stack { Text { icon }, Text { label } } }
    component Framed(title: string, body: slot) { body: Card { Text { title } } }
    page Home {
      route: "/"
      body: ${body}
    }
  }
  deployable api { platform: node, contexts: [C], port: 3000 }
  deployable web { platform: static targets: api ui: WebApp port: 3001 }
}`;

async function codes(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(sys(body), { validate: true });
  return codesOf(diagnostics);
}

const CODE = "loom.component-prop-type";

describe("component prop types (M-T6.18 gap #3)", () => {
  it("flags a wrong-typed positional prop in the paren form", async () => {
    expect(await codes('CounterBadge("x")')).toContain(CODE);
  });

  it("is CLEAN for a correctly-typed positional prop", async () => {
    expect(await codes("CounterBadge(5)")).not.toContain(CODE);
  });

  it("flags a wrong-typed NAMED prop in the paren form", async () => {
    expect(await codes('LabeledIcon(icon: 5, label: "F")')).toContain(CODE);
  });

  it("is CLEAN for correctly-typed named props", async () => {
    expect(await codes('LabeledIcon(icon: "star", label: "F")')).not.toContain(CODE);
  });

  it("flags a wrong-typed prop in the brace form", async () => {
    expect(await codes('CounterBadge { n: "x" }')).toContain(CODE);
  });

  it("admits int-literal promotion into a decimal prop", async () => {
    // (Declared via a helper component with a decimal param.)
    const { diagnostics } = await parseString(
      `
system S {
  subdomain M { context C { } }
  ui WebApp {
    component Price(amount: decimal) { body: Text { string(amount) } }
    page Home { route: "/"  body: Price(5) }
  }
  deployable api { platform: node, contexts: [C], port: 3000 }
  deployable web { platform: static targets: api ui: WebApp port: 3001 }
}`,
      { validate: true },
    );
    expect(codesOf(diagnostics)).not.toContain(CODE);
  });

  it("does not flag a `slot`-typed prop given JSX children", async () => {
    // `Framed(title: string, body: slot)` — the `body:` slot takes markup, not a
    // value, so it must be skipped.
    expect(await codes('Framed { title: "Hi", body: Text { "child" } }')).not.toContain(CODE);
  });

  it("does not flag a record construction of the same brace shape", async () => {
    // `Badge { … }` is a walker primitive, not a user component — no prop-type
    // error (its own arg surface owns it).
    expect(await codes("CounterBadge(5)")).not.toContain(CODE);
  });
});
