// ---------------------------------------------------------------------------
// `+` between STRINGS in a Phoenix/HEEx page body must render Elixir's `<>`,
// not `+` (F2-FFE-6).
//
// `heex-walker-core.ts`'s `renderBinary` used to pick the operator from a
// syntactic probe — "is either operand a string LITERAL" — with a comment
// saying the IR carried no type tags.  It does: `BinaryIR` stamps `leftType` /
// `rightType` / `resultType`, and the DOMAIN renderer (`render-expr.ts`
// `elixirOp(op, leftIsString)`) has always read them.  So `who + other`
// between two string state cells — no literal anywhere — emitted
// `(@who + @other)`, which raises `ArithmeticError: bad argument in arithmetic
// expression` when the LiveView renders and takes the whole page down.
//
// `mix compile` cannot see it (a runtime error), so every elixir compile gate
// is blind to this shape — hence a render-level assertion here.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = `system ElxConcat {
  subdomain S {
    context C {
      aggregate Thing with crudish { name: string }
      repository Things for Thing { }
    }
  }
  api A from S
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui App {
    framework: phoenixLiveView
    api C: A
    page Home {
      route: "/"
      state { flag: bool = false  who: string = "me"  other: string = "you"  n: int = 1 }
      derived plainCat: string = who + "!"
      derived condCat: string = who + (flag ? " yes" : " no")
      derived twoVars: string = who + other
      derived sum: int = n + 1
      body: Stack { Text { plainCat }, Text { condCat }, Text { twoVars }, Text { sum } }
    }
  }
  deployable app {
    platform: elixir
    contexts: [C]
    dataSources: [st]
    serves: A
    ui: App { C: app }
    port: 4000
  }
}`;

async function homeLive(): Promise<string> {
  const files = await generateSystemFiles(SYSTEM);
  const live = [...files].find(([p]) => p.endsWith("live/home_live.ex"))?.[1];
  expect(live, `no home_live.ex in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return live as string;
}

describe("HEEx string concatenation picks `<>` from the IR type, not from literal-ness", () => {
  it("two string state cells concatenate with `<>`", async () => {
    expect(await homeLive()).toContain("(@who <> @other)");
  });

  it("a string cell plus a ternary concatenates with `<>`", async () => {
    expect(await homeLive()).toContain('(@who <> (if @flag, do: " yes", else: " no"))');
  });

  it("the literal-bearing case is unchanged", async () => {
    expect(await homeLive()).toContain('(@who <> "!")');
  });

  it("numeric `+` still renders as `+`", async () => {
    expect(await homeLive()).toContain("(@n + 1)");
  });
});
