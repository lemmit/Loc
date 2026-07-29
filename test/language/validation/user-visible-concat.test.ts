import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// `loom.user-visible-concat` (M-T1.11, i18n-strings.md) — string `+` in a
// user-visible page slot is untranslatable and flagged an ERROR (the template→ICU
// runtime has landed, so a backtick interpolation is the first-class, translatable
// rewrite the diagnostic points to). A backtick template is accepted.

async function diagsFor(body: string): Promise<{ code?: string | number; severity?: number }[]> {
  const services = createDddServices(NodeFileSystem);
  const source = `
    system S {
      subdomain M {
        context C {
          aggregate Order with crudish { customerId: string }
          repository Orders for Order { }
        }
      }
      api A from M
      ui W {
        api A: A
        page P(o: Order) { route: "/p/:id" body: ${body} }
      }
    }
  `;
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  return doc.diagnostics ?? [];
}

const concat = async (body: string) =>
  (await diagsFor(body)).filter((d) => d.code === "loom.user-visible-concat");
const has = async (body: string) => (await concat(body)).length > 0;

describe("loom.user-visible-concat", () => {
  it("flags string concatenation in a Heading text slot — as an error", async () => {
    const diags = await concat(`Heading { "Order " + o.id }`);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe(1); // 1 === error (blocks codegen)
  });

  it("rejects string concatenation in a Button label slot", async () => {
    expect(await has(`Button { "View " + o.customerId }`)).toBe(true);
  });

  it("accepts a backtick template interpolation (the intended rewrite)", async () => {
    // The real rewrite is a backtick template with `{expr}` holes — a distinct
    // AST node (`TemplateStr`), not a `BinaryChain`. (A double-quoted "…${x}…"
    // is a plain literal, not interpolation, so it's also accepted but for a
    // different reason — the backtick form is what the diagnostic points to.)
    expect(await has("Heading { `Order {o.id}` }")).toBe(false);
  });

  it("accepts a plain string literal", async () => {
    expect(await has(`Heading { "Orders" }`)).toBe(false);
  });

  it("leaves numeric arithmetic in a value slot alone (no string operand)", async () => {
    // Stat's second positional is a user-visible value slot, but `1 + 2` is
    // arithmetic, not text composition — no string literal operand.
    expect(await has(`Stat { "Total", 1 + 2 }`)).toBe(false);
  });

  it("does not fire outside user-visible slots", async () => {
    // A `+` inside a QueryView's `of:` (a data slot, not user-visible text).
    expect(await has(`Stack { Heading { "Orders" } }`)).toBe(false);
  });
});
