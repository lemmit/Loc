import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { eventNames, listEmits, setEmitEvent } from "../../web/src/builder/system/emit-event.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "examples", "sales.ddd"), "utf8");
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;
function aggregate(name: string): { $type: string } {
  for (const n of (function* walk(x: { $type: string }): Generator<{ $type: string }> {
    yield x;
    for (const v of Object.values(x)) {
      if (Array.isArray(v))
        for (const c of v)
          if (c && typeof c === "object" && "$type" in c) yield* walk(c);
          else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
    }
  })(parse(sales))) {
    if (n.$type === "Aggregate" && (n as { name?: string }).name === name) return n;
  }
  throw new Error(`no aggregate ${name}`);
}

describe("System builder — emit event", () => {
  it("lists emit statements across an aggregate's operations", () => {
    const emits = listEmits(aggregate("Order"));
    expect(emits.map((e) => `${e.op}/${e.event}`)).toEqual(
      expect.arrayContaining(["addLine/LineAdded", "confirm/OrderConfirmed"]),
    );
  });

  it("lists declared events", () => {
    expect(eventNames(parse(sales))).toEqual(
      expect.arrayContaining(["LineAdded", "OrderConfirmed"]),
    );
  });

  it("repoints an emit at a different event, keeping the field block", () => {
    const out = setEmitEvent(sales, "aggregate", "Order", "addLine", 3, "OrderConfirmed")!;
    expect(out).toMatch(/emit OrderConfirmed \{ order: id, productId: productId, quantity: qty \}/);
    // The other emit (confirm) is untouched.
    expect(out).toMatch(/emit OrderConfirmed \{ order: id, at: now\(\) \}/);
  });

  it("returns null for a bad target", () => {
    expect(setEmitEvent(sales, "aggregate", "Order", "addLine", 0, "LineAdded")).toBeNull(); // index 0 is a precondition
    expect(setEmitEvent(sales, "aggregate", "Nope", "addLine", 3, "LineAdded")).toBeNull();
  });
});
