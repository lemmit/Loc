// Defaulted aggregate → parameterized create (canonical-create gate).
//
// A `with crudish` aggregate gets a canonical create parameterized by its
// create-input fields.  An explicit `= default` (`count = 0`,
// `label = "untitled"`) makes the field an *optional* create input — the
// default is applied at the wire boundary when the client omits it, so the
// field drops out of the request's required-set.  Each backend renders the
// default in its native slot: Hono zod `.default(…)`, .NET record `= …`,
// Phoenix Ecto `field ... default: ...`.  The domain factory signature is unchanged —
// the create input still names every field (see `wireCreateDefault`).
//
// REST-create gate (symmetric with DELETE): the auto-derived `POST /<coll>`
// endpoint + request DTO + create command now require an EXPLICIT canonical
// `create` (`emitsRestCreate` → `canonicalCreate != null`), NOT mere
// `isConstructible`.  A bare constructible aggregate (no `create`, no
// `crudish`) still gets the DOMAIN factory (`Agg.create(...)` that seeds/tests
// call) but NO REST create surface — this file's fixtures therefore carry
// `with crudish` so the wire-level default assertions have a create route to
// land on.

import { describe, expect, it } from "vitest";
import {
  emitsRestCreate,
  hasCreate,
  isConstructible,
} from "../../src/ir/enrich/wire-projection.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel, generateSystemFiles } from "../_helpers/index.js";

const FIXTURE = `
system Demo {
  subdomain Shop {
    context Catalog {
      aggregate Counter with crudish {
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
  deployable honoApi    { platform: node           contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 3000 }
  deployable dotnetApi  { platform: dotnet         contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 8080 }
  deployable phoenixApi { platform: elixir contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 4000 }
}
`;

// A BARE constructible aggregate — no `create`, no `crudish`.  Constructible
// (vacuous invariant set), so the DOMAIN factory is emitted, but it exposes NO
// REST create surface under the canonical-create gate.
const BARE_FIXTURE = `
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
  deployable honoApi    { platform: node           contexts: [Catalog] dataSources: [catalogState] serves: ShopApi port: 3000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

describe("defaulted aggregate — parameterized create (invariant gate)", () => {
  it("crudish aggregate has a canonical create + REST create surface", async () => {
    const loom = await buildLoomModel(FIXTURE);
    const counter = allAggregates(loom).find((a) => a.name === "Counter")!;
    expect(counter.canonicalCreate ?? null).not.toBe(null);
    expect(isConstructible(counter)).toBe(true);
    expect(hasCreate(counter)).toBe(true);
    expect(emitsRestCreate(counter)).toBe(true);
  });

  it("a bare constructible aggregate keeps the domain factory but exposes NO REST create", async () => {
    const loom = await buildLoomModel(BARE_FIXTURE);
    const counter = allAggregates(loom).find((a) => a.name === "Counter")!;
    // Constructible (no blocking invariant) — the domain `create(...)` factory
    // seeds/tests call is still emitted…
    expect(counter.canonicalCreate ?? null).toBe(null);
    expect(isConstructible(counter)).toBe(true);
    expect(hasCreate(counter)).toBe(true);
    // …but the auto-derived REST create endpoint is gated on an explicit
    // canonical create, so it is suppressed.
    expect(emitsRestCreate(counter)).toBe(false);

    const files = await generateSystemFiles(BARE_FIXTURE);
    const routes = findFile(files, /counter\.routes\.ts$/i)!;
    // No create request schema and no create-route factory call (the only
    // POST that remains is the `bump` operation endpoint, not a create).
    expect(routes).not.toMatch(/CreateCounterRequest/);
    expect(routes).not.toMatch(/Counter\.create\(/);
    // The domain factory is still emitted for seeds/tests.
    const domain = findFile(files, /domain\/counter\.ts$/i)!;
    expect(domain).toMatch(/static create\(/);
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

  it("Phoenix: defaulted fields carry an Ecto `default:` so they are optional input", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const schema = findFile(files, /counter\.ex$/i)!;
    // Ecto applies the schema default when the field is omitted from the
    // changeset, so it drops from the required-set — mirroring the Hono/.NET
    // wire shape.
    expect(schema).toMatch(/field :count, :integer, default: 0/);
    expect(schema).toMatch(/field :label, :string, default: "untitled"/);
  });
});

// B14: a `bool = true` create default must reach the wire.  The previous
// behaviour dropped EVERY bool default at the wire boundary and let each
// backend's hardcoded bool rule apply `.default(false)`, so an omitted
// `enabled` arrived `false` even though the source declared `= true`.  A
// `bool = false` masks the bug (it agrees with the hardcoded false), so this
// fixture asserts on `= true` (and a bare bool, which must STAY `false`).
const BOOL_FIXTURE = `
system Flags {
  subdomain D {
    context Settings {
      aggregate Toggle {
        label: string
        enabled: bool = true
        plain: bool
        create(label: string, enabled: bool, plain: bool) {
          label := label
          enabled := enabled
          plain := plain
        }
      }
      repository Toggles for Toggle { }
    }
  }
  api SettingsApi from D
  storage primarySql { type: postgres }
  resource settingsState { for: Settings, kind: state, use: primarySql }
  deployable honoApi   { platform: node   contexts: [Settings] dataSources: [settingsState] serves: SettingsApi port: 3000 }
  deployable dotnetApi { platform: dotnet contexts: [Settings] dataSources: [settingsState] serves: SettingsApi port: 8080 }
}
`;

describe("bool create default reaches the wire (B14)", () => {
  it("Hono: `bool = true` emits `.default(true)`, a bare bool stays `.default(false)`", async () => {
    const files = await generateSystemFiles(BOOL_FIXTURE);
    const routes = findFile(files, /toggle\.routes\.ts$/i)!;
    expect(routes).toMatch(/enabled:\s*z\.coerce\.boolean\(\)\.default\(true\)/);
    // No stale `.default(false)` slipped in front of the real default.
    expect(routes).not.toMatch(/enabled:\s*z\.coerce\.boolean\(\)\.default\(false\)/);
    expect(routes).toMatch(/plain:\s*z\.coerce\.boolean\(\)\.default\(false\)/);
  });

  it(".NET: `bool = true` becomes a record default, sorted after required params", async () => {
    const files = await generateSystemFiles(BOOL_FIXTURE);
    const dto = findFile(files, /Toggles\/Requests\/ToggleRequests\.cs$/)!;
    // The defaulted param must trail the required ones (C# CS1737), and carry
    // the declared `= true` — not a silent `false`.
    expect(dto).toMatch(/bool Enabled = true/);
    expect(dto).not.toMatch(/bool Enabled = false/);
    // Optional (defaulted) param comes last; `Label`/`Plain` precede it.
    expect(dto).toMatch(
      /record CreateToggleRequest\([\s\S]*string Label[\s\S]*bool Plain[\s\S]*bool Enabled = true\)/,
    );
  });
});
