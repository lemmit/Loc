// Cross-backend parity for the CREATE- and UPDATE-INPUT REQUIRED SETS
// (T6 backend parity).
//
// `field: T = <default>` means "the client may omit this; the server supplies
// the value".  So does a bare `bool` (the language's implicit `false`).  The IR
// reifies both rules once — `isRequiredCreateInput` and `isRequiredUpdateInput`
// in `ir/enrich/wire-projection.ts` — and this file asserts every backend's
// EMITTED surface agrees with them.
//
// The two rules deliberately DIFFER, which is why both seams are pinned: an
// explicit `= default` relaxes CREATE input only (a PATCH names the value it is
// writing), while the bare-`bool` relaxation applies to both.  Asserting only
// the create side would let a backend collapse the two into one rule and stay
// green.
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

/** The UPDATE-side required set.  A PATCH names the value it is writing, so an
 *  explicit `= default` does NOT relax it — only the bare-`bool` implicit
 *  default and plain optionality do.  So `status`/`label`/`lvl` come back as
 *  required here while `flag`/`onoff`/`note` stay omittable, and all five
 *  backends agree on that (`isRequiredUpdateInput`). */
const EXPECTED_UPDATE_REQUIRED = ["name", "status", "label", "lvl"];

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

// --- per-backend ENFORCEMENT-surface extractors -----------------------------
// Each pulls the required-field set out of the artefact the request actually
// hits.  Parameterised by DTO verb so the create and update seams share one
// reader apiece rather than duplicating five regexes.

/** Java: the OpenAPI customizer's declared `RequiredSet` for one component. */
function javaRequired(customizer: string, dto: string): string[] {
  const m = customizer.match(
    new RegExp(`new RequiredSet\\("${dto}ThingRequest", List\\.of\\(([^)]*)\\)\\)`),
  );
  expect(m, `no RequiredSet for ${dto}ThingRequest`).not.toBeNull();
  return (m![1].match(/"(\w+)"/g) ?? []).map((s) => s.replaceAll('"', ""));
}

/** .NET: request-record params carrying a `[Required…]` attribute. */
function dotnetRequired(requests: string, dto: string): string[] {
  const m = requests.match(new RegExp(`record ${dto}ThingRequest\\(([^;]*)\\);`));
  expect(m, `no ${dto}ThingRequest record`).not.toBeNull();
  // Split the record's parameter list on top-level commas — an attribute like
  // `[Required(AllowEmptyStrings = true)]` carries no comma, so a plain split
  // is safe here and stays readable.
  return (
    m![1]
      .split(/,(?![^(]*\))/)
      .map((p) => p.trim())
      .filter((p) => p.startsWith("[Required"))
      // `[Required(...)] string Name` → `Name` → `name`
      .map((p) => p.replace(/^\[[^\]]*\]\s*/, "").split(/\s+/)[1])
      .map((n) => n[0].toLowerCase() + n.slice(1))
  );
}

/** Python: pydantic model fields declared without a default. */
function pythonRequired(routes: string, dto: string): string[] {
  const body = routes.split(`class ${dto}ThingRequest(BaseModel):`)[1] ?? "";
  expect(body, `no ${dto}ThingRequest model`).not.toBe("");
  const required: string[] = [];
  // The model body runs to the first line that is neither indented nor blank
  // — a `.reduce` would run on past it into the NEXT class, so stop explicitly.
  for (const line of body.split("\n").slice(1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("    ")) break;
    const m = line.trim().match(/^(\w+):\s*(.+)$/);
    if (m && !m[2].includes(" = ")) required.push(m[1]);
  }
  return required;
}

/** node: zod object keys with no `.default()` / `.optional()` / `.nullish()`. */
function nodeRequired(routes: string, dto: string): string[] {
  const m = routes.match(
    new RegExp(`const ${dto}ThingRequest = z\\.object\\(\\{([\\s\\S]*?)\\}\\)`),
  );
  expect(m, `no ${dto}ThingRequest zod object`).not.toBeNull();
  return m![1].split("\n").reduce<string[]>((acc, line) => {
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
}

/** elixir: the atoms in a changeset module attribute (`@required_fields`, …). */
function elixirAttr(changeset: string, attr: string): string[] {
  const m = changeset.match(new RegExp(`${attr} \\[([^\\]]*)\\]`));
  expect(m, `no ${attr} in the emitted changeset`).not.toBeNull();
  return (m![1].match(/:(\w+)/g) ?? []).map((a) => a.slice(1));
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
    expect(elixirAttr(cs, "@required_fields")).toEqual(EXPECTED_REQUIRED);

    // The other half of the fix: a field dropped from `validate_required` must
    // still LAND a value, or the `null: false` column turns the 422 into an
    // insert failure.  The enum default and the bare bool are the two shapes
    // the Ecto schema `default:` cannot carry.
    expect(cs).toContain("|> __default(:lvl, :low)");
    expect(cs).toContain("|> __default(:flag, false)");
    expect(cs).toContain("|> __default(:onoff, true)");
  });

  it("java — the OpenAPI customizer's Create request required-set matches", async () => {
    const cust = fileEndingWith(await filesFor("java"), "/config/OpenApiContractCustomizer.java");
    expect(javaRequired(cust, "Create")).toEqual(EXPECTED_REQUIRED);
  });

  it("dotnet — only undefaulted request-record params carry [Required]", async () => {
    const reqs = fileEndingWith(await filesFor("dotnet"), "/Requests/ThingRequests.cs");
    expect(dotnetRequired(reqs, "Create")).toEqual(EXPECTED_REQUIRED);
  });

  it("python — only undefaulted pydantic model fields lack a default", async () => {
    const routes = fileEndingWith(await filesFor("python"), "/http/thing_routes.py");
    expect(pythonRequired(routes, "Create")).toEqual(EXPECTED_REQUIRED);
  });

  it("node — only undefaulted zod create-schema keys are required", async () => {
    const routes = fileEndingWith(await filesFor("node"), "/http/thing.routes.ts");
    expect(nodeRequired(routes, "Create")).toEqual(EXPECTED_REQUIRED);
  });
});

// ---------------------------------------------------------------------------
// The UPDATE seam — the twin of the above, and a DIFFERENT rule.
//
// `isRequiredUpdateInput`: a PATCH names the value it is writing, so an
// explicit `= default` does not relax it; only the bare-`bool` implicit default
// and plain optionality do.  Both halves therefore have to be pinned, because
// asserting only the create set would let a backend collapse the two rules into
// one and stay green — which is exactly the shape of the create-side bug that
// motivated this file.
// ---------------------------------------------------------------------------

describe("update-input required set — cross-backend parity", () => {
  it("elixir — the changeset's @update_required keeps defaulted fields required", async () => {
    const cs = fileEndingWith(await filesFor("elixir"), "/c/thing_changeset.ex");
    expect(elixirAttr(cs, "@update_required")).toEqual(EXPECTED_UPDATE_REQUIRED);
  });

  it("java — the OpenAPI customizer's Update request required-set matches", async () => {
    const cust = fileEndingWith(await filesFor("java"), "/config/OpenApiContractCustomizer.java");
    // The customizer emits its RequiredSet entries sorted; compare as sets so
    // this pins membership, not the emitter's incidental ordering.
    expect([...javaRequired(cust, "Update")].sort()).toEqual([...EXPECTED_UPDATE_REQUIRED].sort());
  });

  it("dotnet — the Update request record marks the defaulted fields [Required]", async () => {
    const reqs = fileEndingWith(await filesFor("dotnet"), "/Requests/ThingRequests.cs");
    expect(dotnetRequired(reqs, "Update")).toEqual(EXPECTED_UPDATE_REQUIRED);
  });

  it("python — the Update model gives only bools and optionals a default", async () => {
    const routes = fileEndingWith(await filesFor("python"), "/http/thing_routes.py");
    expect(pythonRequired(routes, "Update")).toEqual(EXPECTED_UPDATE_REQUIRED);
  });

  it("node — the Update zod schema defaults only the bools", async () => {
    const routes = fileEndingWith(await filesFor("node"), "/http/thing.routes.ts");
    expect(nodeRequired(routes, "Update")).toEqual(EXPECTED_UPDATE_REQUIRED);
  });
});
