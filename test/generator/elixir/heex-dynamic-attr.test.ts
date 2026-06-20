// Regression: dynamic attribute values must ride HEEx `{…}` expression
// attributes, never quoted literals.
//
// A *dynamic* attribute value is an Elixir expression (e.g. a string
// concatenation `"/x/" <> id`).  Emitting it inside quotes — `href="…" <> id"`
// or `data-testid="x <> y"` — is a HEEx tokenizer ParseError ("expected
// attribute name") that fails `mix compile`.  This shipped once on the
// scaffolded workflow-instances list (PR #1367): each row linked to its
// instance detail via a concat route that was rendered into `<a href="…">`.
//
// `src/generator/elixir/heex-primitives.ts` funnels every dynamic attribute
// value through `attrValue` (and `testIdAttr` for `data-testid`), so the bug
// class is closed at one seam.  This test pins both halves of the contract:
//   1. the literal contract stays byte-identical (quoted attrs, default ids);
//   2. a dynamic route renders as a `{…}` expression attribute.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attrValue, testIdAttr } from "../../../src/generator/elixir/heex-primitives.js";
import type { WalkContext } from "../../../src/generator/elixir/heex-walker-core.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

// The literal/absent paths never touch the walk context, so a bare cast is
// sufficient to exercise the byte-identical contract.
const ctx = {} as unknown as WalkContext;
const lit = (value: string): ExprIR => ({ kind: "literal", lit: "string", value }) as ExprIR;
const call = (
  argNames: (string | undefined)[],
  args: ExprIR[],
): Extract<ExprIR, { kind: "call" }> =>
  ({ kind: "call", name: "Anchor", args, argNames }) as Extract<ExprIR, { kind: "call" }>;

describe("heex dynamic attribute seam", () => {
  it("renders a literal attribute value as a quoted string (unchanged)", () => {
    expect(attrValue(lit("/home"), ctx)).toBe('"/home"');
  });

  it("renders a literal testid as a quoted data-testid (unchanged)", () => {
    expect(testIdAttr(call(["testid"], [lit("widget-row")]), ctx)).toBe(
      ' data-testid="widget-row"',
    );
  });

  it("emits nothing when no testid is given", () => {
    expect(testIdAttr(call([undefined], [lit("label")]), ctx)).toBe("");
  });

  it("scaffolded workflow-instances list links via a `{…}` navigate expression", async () => {
    // dispatch.ddd scaffolds an OrderFulfillment instances list whose rows
    // link to the instance detail by the (non-id) correlation field — a
    // string-concat route, the exact shape that broke pre-#1367.
    const src = readFileSync(
      join(repoRoot, "test", "e2e", "fixtures", "elixir-ash-build", "dispatch.ddd"),
      "utf8",
    );
    const files = await generateSystemFiles(src);
    const list = [...files.entries()].find(([p]) =>
      /order_fulfillment_instances_list_live\.ex$/.test(p),
    )?.[1];
    expect(list, "instances list LiveView").toBeDefined();
    // The dynamic route rides a `{…}` expression attribute …
    expect(list).toContain('navigate={"/workflows/order_fulfillment/instances/" <> i.order_id}');
    // … and never the malformed quoted-attribute form that fails mix compile.
    expect(list).not.toMatch(/href="[^"]*"\s*<>/);
  });
});
