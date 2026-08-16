// The `now()` literal on Feliz — it used to emit the bare word `now`.
//
// `now` is an `ExprIR` LITERAL kind whose `value` is the string "now", not a
// number.  `FS_LEAVES.literal` classified string/bool/null and then fell
// through to "numeric literal verbatim", so `now` came out as `now`: an
// unbound F# identifier that fails `dotnet fable` on BOTH feliz expression
// paths (the shared view walker via `felizTarget.exprLiteral`, and the MVU
// `init`/`update` path via `renderFsExpr`, which share the one leaf table).
//
// A Loom `datetime` is a `System.DateTime` on this target (`type-fs.ts`),
// decoded off the wire as UTC (`Decode.datetimeUtc`), so the current instant
// is `System.DateTime.UtcNow` — the same UTC-clock spelling the .NET backend
// renders for the same literal.

import { describe, expect, it } from "vitest";
import { FS_LEAVES, FS_NOW, renderFsExpr } from "../../../src/generator/feliz/fs-expr.js";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const sys = (pages: string) => `
system P {
  subdomain S { context C {
    aggregate Order { name: string }
    repository Orders for Order { }
  } }
  api A from S
  ui WebApp {
    api C: A
    ${pages}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3005 }
}`;

/** Generate `src/App.fs` for a feliz-hosted ui with these pages. */
async function app(pages: string): Promise<string> {
  const model = await buildLoomModel(sys(pages));
  const s = model.systems[0]!;
  const web = s.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
}

describe("feliz — the `now()` literal", () => {
  it("renders `System.DateTime.UtcNow` from the shared leaf table", () => {
    expect(FS_LEAVES.literal("now", "now")).toBe("System.DateTime.UtcNow");
    expect(FS_NOW).toBe("System.DateTime.UtcNow");
  });

  it("seeds a datetime state field with a real instant (MVU init path)", async () => {
    const fs = await app(`
    page Sched {
      route: "/s"
      state { until: datetime = now() }
      body: Text(string(until))
    }`);
    expect(fs).toContain("Until: System.DateTime");
    expect(fs).toContain("Until = System.DateTime.UtcNow");
    // The exact defect: a bare `now` is an unbound identifier in F#.
    expect(fs).not.toMatch(/Until = now\b/);
  });

  it("assigns a real instant in an action body (MVU update path)", async () => {
    const fs = await app(`
    page Sched {
      route: "/s"
      state { until: datetime = now() }
      action push() { until := now() }
      body: Button("go", onClick: push)
    }`);
    expect(fs).toContain("{ model with Until = System.DateTime.UtcNow }");
    expect(fs).not.toMatch(/Until = now\b/);
  });

  it("renders in a view-position expression (shared walker path)", async () => {
    const fs = await app(`
    page Sched {
      route: "/s"
      state { until: datetime = now() }
      body: match {
        until < now() => Text("late")
        else          => Text("ok")
      }
    }`);
    expect(fs).toContain("(model.Until < System.DateTime.UtcNow)");
    expect(fs).not.toMatch(/model\.Until < now\b/);
  });

  it("keeps the update dispatcher on the same spelling as the leaf table", () => {
    expect(
      renderFsExpr(
        { kind: "literal", lit: "now", value: "now" },
        { stateNames: new Set(), locals: new Set() },
      ),
    ).toBe(FS_NOW);
  });
});
