// Defaulted aggregate → parameterized create (Stage 4 invariant gate).
//
// `Counter` declares no create and has no invariants, so it is constructible
// (vacuously — `isConstructible`).  Under the invariant gate it gets a
// NORMAL create parameterized by its create-input fields — there is no
// parameterless "synthesised" form any more.
//
// Note (minimal Stage-4 slice): the defaults (`count = 0`,
// `label = "untitled"`) do NOT yet make the create params optional — a
// defaulted field is a required create param, exactly as crudish treats it
// today.  Making a default an *optional* create input (apply-when-omitted)
// is the separate, uniform `requiredInput`-consumption step.

import { describe, expect, it } from "vitest";
import { hasCreate, isConstructible } from "../../src/ir/enrich/wire-projection.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel, generateSystemFiles } from "../_helpers/index.js";

const FIXTURE = `
system Demo {
  subdomain Shop {
    context Catalog {
      aggregate Counter {
        count: int = 0
        label: string = "untitled"
        operation bump() { count := count + 1 }
      }
      repository Counters for Counter { }
    }
  }
  api ShopApi from Shop
  storage primarySql { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primarySql }
  deployable honoApi   { platform: hono   contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 3000 }
  deployable dotnetApi { platform: dotnet contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 8080 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

describe("defaulted aggregate — parameterized create (invariant gate)", () => {
  it("a defaulted aggregate with no invariants is constructible (no declared create)", async () => {
    const loom = await buildLoomModel(FIXTURE);
    const counter = allAggregates(loom).find((a) => a.name === "Counter")!;
    expect(counter.canonicalCreate ?? null).toBe(null);
    expect(isConstructible(counter)).toBe(true);
    expect(hasCreate(counter)).toBe(true);
  });

  it("Hono: create request + factory are parameterized by the create-input fields", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const routes = findFile(files, /counter\.routes\.ts$/i)!;
    // Non-empty request schema carrying count + label (not the old `z.object({})`).
    expect(routes).toMatch(
      /CreateCounterRequest = z\.object\(\{[\s\S]*?count:[\s\S]*?label:[\s\S]*?\}\)\.openapi/,
    );
    expect(routes).toMatch(/Counter\.create\(\{ count: body\.count, label: body\.label \}\)/);
    const domain = findFile(files, /domain\/counter\.ts$/i)!;
    expect(domain).toMatch(/static create\(input: \{ count: number; label: string \}\): Counter/);
  });

  it(".NET: CreateRequest + factory are parameterized by the create-input fields", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const dto = findFile(files, /Counters\/Requests\/CounterRequests\.cs$/)!;
    expect(dto).toMatch(/record CreateCounterRequest\(.*int Count.*string Label.*\)/);
    const domain = findFile(files, /Domain\/Counters\/Counter\.cs$/)!;
    expect(domain).toMatch(/public static Counter Create\(int count, string label\)/);
  });
});
