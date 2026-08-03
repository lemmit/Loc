// Cross-backend parity for the CREATE-INPUT REQUIRED SET (T6 backend parity).
//
// `field: T = <default>` means "the client may omit this; the server supplies
// the value".  So does a bare `bool` (the language's implicit `false`).  The IR
// already reifies that rule once — `CreateInputFieldIR.requiredInput`, built by
// `buildCreateInput` — and this test asserts every backend's EMITTED create
// surface agrees with it.
//
// Why this test exists: Phoenix used to derive its changeset required-set from
// type nullability alone (`allFields.filter((f) => !f.optional)`), so a
// defaulted field stayed in `validate_required` and a create that every other
// backend answered 201 came back 422 `{"pointer":"/lvl","message":"can't be
// blank"}`.  Nothing caught it:
//
//   * the COMPILE tier is blind — both backends compile fine;
//   * the wire-golden differential is blind — the request 422s before it
//     produces a comparable response body;
//   * even the OpenAPI parity gate was blind, because Phoenix's own *spec*
//     emitter already used the correct rule (`wireCreateDefault`).  The
//     disagreement was between Phoenix's published contract and Phoenix's
//     runtime enforcement, which no spec-vs-spec diff can see.
//
// Hence the assertion here is deliberately against each backend's ENFORCEMENT
// surface (the changeset / DTO / validator the request actually hits), not its
// generated OpenAPI document.

import { describe, expect, it } from "vitest";
import { buildLoomModel } from "../_helpers/ir.js";

/** One aggregate covering every reachable `= default` shape plus the bare
 *  `bool` implicit default, so the required set is a strict subset of the
 *  cast set on every backend.  Field defaults are gated to instance-
 *  INDEPENDENT expressions (`validateFieldDefaults`), so literal / enum-member
 *  / `now()` is the complete space. */
const SYSTEM = (platform: string) => `
system DefaultParity {
  subdomain S {
    context C {
      enum Level { low, high }
      aggregate Thing with crudish {
        name: string
        status: int = 0
        label: string = "n/a"
        lvl: Level = Level.low
        flag: bool
        onoff: bool = true
        note: string?
      }
      repository Things for Thing { }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable d {
    platform: ${platform}
    contexts: [C]
    dataSources: [st]
    serves: A
    port: 4000
  }
}
`;

/** The one field with no default of any kind — every other field is omittable
 *  create input.  Asserted against the IR below rather than trusted. */
const EXPECTED_REQUIRED = ["name"];

async function filesFor(platform: string): Promise<Map<string, string>> {
  // Imported lazily so a generator-side import cycle surfaces per-leg.
  const { generateSystemFiles } = await import("../_helpers/generate.js");
  return generateSystemFiles(SYSTEM(platform));
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `no emitted file ending in ${suffix}`).toBeDefined();
  return files.get(key!)!;
}

describe("create-input required set — cross-backend parity", () => {
  it("the IR's canonical requiredInput set is exactly the undefaulted fields", async () => {
    const model = await buildLoomModel(SYSTEM("node"));
    const agg = model.systems
      .flatMap((s) => s.subdomains)
      .flatMap((sd) => sd.contexts)
      .flatMap((c) => c.aggregates)
      .find((a) => a.name === "Thing");
    expect(agg).toBeDefined();
    const required = (agg!.createInput ?? [])
      .filter((c) => c.requiredInput)
      .map((c) => c.field.name);
    expect(required).toEqual(EXPECTED_REQUIRED);
  });

  it("elixir — the Ecto changeset's @required_fields matches (the T6 regression)", async () => {
    const cs = fileEndingWith(await filesFor("elixir"), "/c/thing_changeset.ex");
    const m = cs.match(/@required_fields \[([^\]]*)\]/);
    expect(m, "no @required_fields in the emitted changeset").not.toBeNull();
    const required = (m![1].match(/:(\w+)/g) ?? []).map((a) => a.slice(1));
    expect(required).toEqual(EXPECTED_REQUIRED);

    // The other half of the fix: a field dropped from `validate_required` must
    // still LAND a value, or the `null: false` column turns the 422 into an
    // insert failure.  The enum default and the bare bool are the two shapes
    // the Ecto schema `default:` cannot carry.
    expect(cs).toContain("|> __default(:lvl, :low)");
    expect(cs).toContain("|> __default(:flag, false)");
    expect(cs).toContain("|> __default(:onoff, true)");
  });

  it("java — the OpenAPI customizer's Create request required-set matches", async () => {
    const files = await filesFor("java");
    const cust = fileEndingWith(files, "/config/OpenApiContractCustomizer.java");
    const m = cust.match(/new RequiredSet\("CreateThingRequest", List\.of\(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const required = (m![1].match(/"(\w+)"/g) ?? []).map((s) => s.replaceAll('"', ""));
    expect(required).toEqual(EXPECTED_REQUIRED);
  });

  it("dotnet — only undefaulted request-record params carry [Required]", async () => {
    const files = await filesFor("dotnet");
    const reqs = fileEndingWith(files, "/Requests/ThingRequests.cs");
    const m = reqs.match(/record CreateThingRequest\(([^;]*)\);/);
    expect(m).not.toBeNull();
    // Split the record's parameter list on top-level commas — an attribute like
    // `[Required(AllowEmptyStrings = true)]` carries no comma, so a plain split
    // is safe here and stays readable.
    const required = m![1]
      .split(/,(?![^(]*\))/)
      .map((p) => p.trim())
      .filter((p) => p.startsWith("[Required"))
      // `[Required(...)] string Name` → `Name` → `name`
      .map((p) => p.replace(/^\[[^\]]*\]\s*/, "").split(/\s+/)[1])
      .map((n) => n[0].toLowerCase() + n.slice(1));
    expect(required).toEqual(EXPECTED_REQUIRED);
  });

  it("python — only undefaulted pydantic model fields lack a default", async () => {
    const files = await filesFor("python");
    const routes = fileEndingWith(files, "/http/thing_routes.py");
    const body = routes.split("class CreateThingRequest(BaseModel):")[1] ?? "";
    const required: string[] = [];
    // The model body runs to the first line that is neither indented nor blank
    // — `.reduce` would run on past it into the NEXT class, so stop explicitly.
    for (const line of body.split("\n").slice(1)) {
      if (line.trim() === "") continue;
      if (!line.startsWith("    ")) break;
      const m = line.trim().match(/^(\w+):\s*(.+)$/);
      if (m && !m[2].includes(" = ")) required.push(m[1]);
    }
    expect(required).toEqual(EXPECTED_REQUIRED);
  });

  it("node — only undefaulted zod create-schema keys are required", async () => {
    const files = await filesFor("node");
    const routes = fileEndingWith(files, "/http/thing.routes.ts");
    const m = routes.match(/const CreateThingRequest = z\.object\(\{([\s\S]*?)\}\)/);
    expect(m).not.toBeNull();
    const required = m![1].split("\n").reduce<string[]>((acc, line) => {
      const f = line.trim().match(/^(\w+):\s*(.+),$/);
      if (!f) return acc;
      const schema = f[2];
      const omittable =
        schema.includes(".default(") ||
        schema.includes(".optional()") ||
        schema.includes(".nullish()");
      if (!omittable) acc.push(f[1]);
      return acc;
    }, []);
    expect(required).toEqual(EXPECTED_REQUIRED);
  });
});
