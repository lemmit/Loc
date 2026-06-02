// Defaulted aggregate → parameterized create (Stage 4 invariant gate).
//
// `Counter` declares no create and has no invariants, so it is constructible
// (vacuously — `isConstructible`).  Under the invariant gate it gets a
// NORMAL create parameterized by its create-input fields — there is no
// parameterless "synthesised" form any more.
//
// Stage-4 canonical-create: an explicit `= default` (`count = 0`,
// `label = "untitled"`) makes the field an *optional* create input — the
// default is applied at the wire boundary when the client omits it, so the
// field drops out of the request's required-set.  Each backend renders the
// default in its native slot: Hono zod `.default(…)`, .NET record `= …`,
// Phoenix Ash `default: …`.  The domain factory signature is unchanged —
// the create input still names every field (see `wireCreateDefault`).

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
  deployable honoApi    { platform: hono           contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 3000 }
  deployable dotnetApi  { platform: dotnet         contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 8080 }
  deployable phoenixApi { platform: phoenix contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 4000 }
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

  it("Hono: defaulted fields become optional create input via zod `.default(…)`", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const routes = findFile(files, /counter\.routes\.ts$/i)!;
    // Non-empty request schema carrying count + label (not the old `z.object({})`).
    expect(routes).toMatch(
      /CreateCounterRequest = z\.object\(\{[\s\S]*?count:[\s\S]*?label:[\s\S]*?\}\)\.openapi/,
    );
    // Each `= default` rides onto the wire as a zod `.default(…)`, so the
    // client may omit the field — it is no longer a required input.
    expect(routes).toMatch(/count:\s*z\.coerce\.number\(\)\.int\(\)\.default\(0\)/);
    expect(routes).toMatch(/label:\s*z\.string\(\)\.default\("untitled"\)/);
    // The factory call + domain signature are unchanged — the create input
    // still names every field.
    expect(routes).toMatch(/Counter\.create\(\{ count: body\.count, label: body\.label \}\)/);
    const domain = findFile(files, /domain\/counter\.ts$/i)!;
    expect(domain).toMatch(/static create\(input: \{ count: number; label: string \}\): Counter/);
  });

  it(".NET: defaulted fields become optional request params via record defaults", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const dto = findFile(files, /Counters\/Requests\/CounterRequests\.cs$/)!;
    // Each `= default` becomes a record default value (dropping `[Required]`),
    // so STJ applies it when the field is omitted from the request.
    expect(dto).toMatch(
      /record CreateCounterRequest\(\s*int Count = 0,\s*string Label = "untitled"\s*\)/,
    );
    const domain = findFile(files, /Domain\/Counters\/Counter\.cs$/)!;
    expect(domain).toMatch(/public static Counter Create\(int count, string label\)/);
  });

  it("Phoenix: defaulted fields carry an Ash `default:` so they are optional input", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const resource = findFile(files, /counter\.ex$/i)!;
    // Ash applies the default on create when the attribute is omitted, so the
    // field drops from the required-set — mirroring the Hono/.NET wire shape.
    expect(resource).toMatch(/attribute :count, :integer, allow_nil\?: false, default: 0/);
    expect(resource).toMatch(/attribute :label, :string, allow_nil\?: false, default: "untitled"/);
  });
});
