// Synthesised parameterless create — constructibility via defaults.
//
// An aggregate that declares no create but whose every required
// create-input field carries a default is constructible: it gets a
// synthesised, parameterless create.  The wire create request is empty and
// the domain factory applies each field's default.  (Stage 4's deferred
// "defaults-based implicit create".)

import { describe, expect, it } from "vitest";
import { hasCreate, isSynthesizedCreate } from "../../src/ir/enrich/wire-projection.js";
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

describe("synthesised parameterless create (constructibility via defaults)", () => {
  it("an all-defaulted aggregate is constructible via a synthesised create", async () => {
    const loom = await buildLoomModel(FIXTURE);
    const counter = allAggregates(loom).find((a) => a.name === "Counter")!;
    expect(counter.canonicalCreate ?? null).toBe(null);
    expect(isSynthesizedCreate(counter)).toBe(true);
    expect(hasCreate(counter)).toBe(true);
  });

  it("Hono: empty create request + factory applies the defaults", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const routes = findFile(files, /counter\.routes\.ts$/i)!;
    // Parameterless: empty request schema + empty-input factory call.
    expect(routes).toMatch(/CreateCounterRequest = z\.object\(\{\s*\}\)/);
    expect(routes).toMatch(/Counter\.create\(\{\s*\}\)/);
    const domain = findFile(files, /domain\/counter\.ts$/i)!;
    expect(domain).toMatch(/static create\(input: \{\s*\}\): Counter/);
    expect(domain).toMatch(/count: 0/);
    expect(domain).toMatch(/label: "untitled"/);
  });

  it(".NET: empty CreateRequest + parameterless factory applying defaults", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const dto = findFile(files, /Counters\/Requests\/CounterRequests\.cs$/)!;
    expect(dto).toMatch(/record CreateCounterRequest\(\)/);
    const domain = findFile(files, /Domain\/Counters\/Counter\.cs$/)!;
    expect(domain).toMatch(/public static Counter Create\(\)/);
    expect(domain).toMatch(/e\.Count = 0;/);
    expect(domain).toMatch(/e\.Label = "untitled";/);
  });
});
