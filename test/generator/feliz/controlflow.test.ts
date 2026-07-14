// Feliz control-flow seams — `cond ? a : b` (renderConditionalChild) and the
// predicate-arm `match { … }` (renderMatchChild / renderMatch).  Both emit an
// F# `if`/`elif`/`else` on ONE line so they stay offside-safe when spliced
// into a Feliz `[ … ]` children list (a multi-line `if` there is offside of the
// list context — the walker only re-indents a child's first line).  Proven to
// compile via `dotnet fable`; this pins the single-line shape.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

async function viewOf(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

describe("feliz control-flow seams", () => {
  it("renders `cond ? a : b` as a single-line if/else", async () => {
    const app = await viewOf(`
      system Tern {
        subdomain S { context C { } }
        ui WebApp {
          framework: feliz
          page P {
            route: "/"
            state { active: bool = true }
            body: Stack {
              active ? Card { "On" } : Card { "Off" }
            }
          }
        }
        deployable api { platform: node contexts: [C] port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
      }
    `);
    expect(app).toContain(
      '(if model.Active then Html.div [ prop.className "card bg-base-100 shadow"',
    );
    // Single line — no newline between `then`/`else` and their branches.
    const cond = app.split("\n").find((l) => l.includes("if model.Active then"))!;
    expect(cond).toContain("else Html.div");
  });

  it("renders `match { p => v … else => e }` as a single-line if/elif/else", async () => {
    const app = await viewOf(`
      system MatchApp {
        subdomain S { context C { } }
        ui WebApp {
          framework: feliz
          page P {
            route: "/"
            state { step: int = 0 }
            body: match {
              step == 0 => Card { "Zero" }
              step == 1 => Card { "One" }
              else      => Card { "Other" }
            }
          }
        }
        deployable api { platform: node contexts: [C] port: 3000 }
        deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
      }
    `);
    const arm = app.split("\n").find((l) => l.includes("if (model.Step = 0) then"))!;
    expect(arm).toContain("elif (model.Step = 1) then");
    expect(arm).toContain("else Html.div");
  });
});
