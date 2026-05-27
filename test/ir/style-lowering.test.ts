// Pin lowering of the `style: { ... }` escape hatch on walker
// primitives.  The named entry is hoisted out of the regular
// `args`/`argNames` list into a dedicated `style.entries` IR field
// (an ordered list of `{ key, value }` so source order survives the
// pipeline).  Both BuilderCall (`Container { style: {…}, … }`) and
// CallExpr (`Container(style: {…}, …)`) source forms produce the
// same IR shape.

import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

async function buildLoom(src: string): Promise<LoomModel> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: false });
  return lowerModel(doc.parseResult.value as Model);
}

function bodyOf(loom: LoomModel, page: string): ExprIR {
  const sys = loom.systems[0]!;
  const ui = sys.uis[0]!;
  const p = ui.pages.find((p) => p.name === page);
  if (!p?.body) throw new Error(`page '${page}' body missing`);
  return p.body;
}

describe("walker style: escape hatch — IR lowering", () => {
  it("hoists `style:` out of args into a dedicated StyleIR field (BuilderCall form)", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page Hero {
            route: "/"
            body: Container {
              style: { background: "red", padding: "60px 0" },
              Heading { "hi", level: 1 },
              size: "xl"
            }
          }
        }
      }
    `);
    const body = bodyOf(loom, "Hero");
    expect(body.kind).toBe("call");
    if (body.kind !== "call") return;
    // `style:` should be absent from args/argNames — hoisted out.
    expect(body.argNames).toBeDefined();
    expect(body.argNames!.includes("style")).toBe(false);
    // The other two entries (the positional Heading + `size:`) survive.
    expect(body.args.length).toBe(2);
    // StyleIR is present and preserves source order.
    expect(body.style).toBeDefined();
    expect(body.style!.entries.map((e) => e.key)).toEqual(["background", "padding"]);
    const bg = body.style!.entries[0]!.value;
    expect(bg.kind).toBe("literal");
    if (bg.kind === "literal") {
      expect(bg.lit).toBe("string");
      expect(bg.value).toBe("red");
    }
  });

  it("absent `style:` leaves the style field undefined", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page Hero {
            route: "/"
            body: Container { Heading { "hi", level: 1 }, size: "xl" }
          }
        }
      }
    `);
    const body = bodyOf(loom, "Hero");
    expect(body.kind).toBe("call");
    if (body.kind !== "call") return;
    expect(body.style).toBeUndefined();
  });

  it("preserves entry order across many style keys", async () => {
    const loom = await buildLoom(`
      system Acme {
        ui WebApp {
          page Hero {
            route: "/"
            body: Stack {
              style: { display: "flex", flexDirection: "column", gap: "8px", color: "white" }
            }
          }
        }
      }
    `);
    const body = bodyOf(loom, "Hero");
    if (body.kind !== "call") throw new Error("expected call");
    expect(body.style!.entries.map((e) => e.key)).toEqual([
      "display",
      "flexDirection",
      "gap",
      "color",
    ]);
  });
});
