// M-FT.11 — the two placement gates on the `if` statement.
//
// `if … { } else { }` renders on the four backends that share the
// `_stmt/target.ts` spine (node / dotnet / java / python, pinned by
// `test/generator/if-statement-render.test.ts`).  The two surfaces that do NOT
// render it must say so with a `loom.*` code, because both alternatives are the
// failure shape this repo treats as worst:
//
//   - elixir would DROP the branch silently (a Phoenix body threads its result
//     through a rebound `record`; an Elixir `if` block's bindings do not escape
//     the block, so `if c { x := 1 }` compiles and does nothing), and
//   - a frontend would CRASH codegen (every walker fails fast on a statement
//     kind it has no arm for).
//
// So both gates are proved twice: the offending shape errors, and the same
// model on a rendering backend does NOT (the gate is placement-specific, not a
// blanket ban on the statement).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function codes(src: string): Promise<string[]> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`unexpected parse errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

/** A one-context system whose only operation body is `body`, on `platform`. */
const backendSys = (platform: string, body: string): string => `system S {
  subdomain M { context C {
    enum Status { Open, Done }
    aggregate Task {
      title: string
      count: int
      status: Status
      operation run(n: int) {
${body}
      }
    }
    repository Tasks for Task {}
  } }
  storage primary { type: postgres }
  resource state { for: C, kind: state, use: primary }
  deployable api { platform: ${platform}, contexts: [C], dataSources: [state], port: 3000 }
}`;

const IF_BODY = `        if n > 0 {
          count := 1
        } else {
          count := 2
        }`;
const NO_IF_BODY = `        count := n`;

describe("loom.elixir-if-stmt-unsupported", () => {
  it("errors when an elixir deployable hosts a context whose operation uses `if`", async () => {
    expect(await codes(backendSys("elixir", IF_BODY))).toContain("loom.elixir-if-stmt-unsupported");
  });

  it("does NOT fire on the four backends that render the statement", async () => {
    for (const p of ["node", "dotnet", "java", "python"]) {
      expect(await codes(backendSys(p, IF_BODY)), `platform ${p}`).not.toContain(
        "loom.elixir-if-stmt-unsupported",
      );
    }
  });

  it("does NOT fire on elixir when the body has no `if` (placement gate, not a ban)", async () => {
    expect(await codes(backendSys("elixir", NO_IF_BODY))).not.toContain(
      "loom.elixir-if-stmt-unsupported",
    );
  });

  it("reaches an `if` NESTED inside another branch", async () => {
    const nested = `        if n > 0 {
          if n > 5 {
            count := 1
          }
        }`;
    expect(await codes(backendSys("elixir", nested))).toContain("loom.elixir-if-stmt-unsupported");
  });
});

const uiSys = (framework: string, webPlatform: string, action: string): string => `system S {
  subdomain M { context C {
    aggregate Task { title: string }
    repository Tasks for Task {}
  } }
  storage primary { type: postgres }
  resource state { for: C, kind: state, use: primary }
  deployable api { platform: node, contexts: [C], dataSources: [state], port: 3000 }
  ui Web {
    framework: ${framework}
    page Home {
      state { n: int = 0 }
      action bump() {
${action}
      }
      body: Stack { Button { label: "go", onClick: bump } }
    }
  }
  deployable web { platform: ${webPlatform}, ui: Web, targets: api, port: 3100 }
}`;

const UI_IF = `        if n == 0 {
          n := 1
        }`;
const UI_NO_IF = `        n := 1`;

describe("loom.if-stmt-page-body-unsupported", () => {
  it("errors for a page action on EVERY SPA frontend, not just one", async () => {
    for (const framework of ["react", "vue", "svelte", "angular", "feliz", "flutter"]) {
      expect(await codes(uiSys(framework, framework, UI_IF)), `framework ${framework}`).toContain(
        "loom.if-stmt-page-body-unsupported",
      );
    }
  });

  // LiveView is the frontend whose ui is MOUNTED ON THE BACKEND deployable (no
  // `targets:`), so it is spelled out rather than folded into the loop above.
  it("errors on a phoenixLiveView page action too", async () => {
    const src = `system S {
  subdomain M { context C {
    aggregate Task { title: string }
    repository Tasks for Task {}
  } }
  storage primary { type: postgres }
  resource state { for: C, kind: state, use: primary }
  ui Web {
    framework: phoenixLiveView
    page Home {
      state { n: int = 0 }
      action bump() {
        if n == 0 {
          n := 1
        }
      }
      body: Stack { Button { label: "go", onClick: bump } }
    }
  }
  deployable web {
    platform: elixir
    contexts: [C]
    dataSources: [state]
    ui: Web
    port: 4000
  }
}`;
    expect(await codes(src)).toContain("loom.if-stmt-page-body-unsupported");
  });

  it("does NOT fire on a page whose action has no `if`", async () => {
    expect(await codes(uiSys("react", "react", UI_NO_IF))).not.toContain(
      "loom.if-stmt-page-body-unsupported",
    );
  });

  it("reaches an `if` inside a store action too", async () => {
    const src = `system S {
  subdomain M { context C {
    aggregate Task { title: string }
    repository Tasks for Task {}
  } }
  storage primary { type: postgres }
  resource state { for: C, kind: state, use: primary }
  deployable api { platform: node, contexts: [C], dataSources: [state], port: 3000 }
  ui Web {
    framework: react
    store Cart {
      state { n: int = 0 }
      action bump() {
        if n == 0 {
          n := 1
        }
      }
    }
    page Home { body: Stack { Heading { text: "hi" } } }
  }
  deployable web { platform: react, ui: Web, targets: api, port: 3100 }
}`;
    expect(await codes(src)).toContain("loom.if-stmt-page-body-unsupported");
  });
});
