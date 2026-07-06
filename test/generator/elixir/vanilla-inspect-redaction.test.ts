// Vanilla Phoenix `sensitive(...)` inspect-redaction (vanilla-phoenix-gaps §3).
//
// A field tagged `sensitive(...)` must NOT leak its value into a struct's
// debug/inspect output.  On Elixir this is the `Inspect` protocol: the schema
// module gets a `defimpl Inspect, for: <Module>` block rendering the IR's
// synthesized `inspect` derived member (sensitive leaves → "<redacted>") via
// ELIXIR_TARGET.  An aggregate with no sensitive field emits no impl.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (body: string): string => `
system Bank {
  subdomain M {
    context People {
      ${body}
      repository People for Person { }
    }
  }
  api PeopleApi from M
  storage primary { type: postgres }
  resource peopleState { for: People, kind: state, use: primary }
  deployable elixirApi {
    platform: elixir
    contexts: [People]
    dataSources: [peopleState]
    serves: PeopleApi
    port: 4000
  }
}
`;

const PATH = "elixir_api/lib/elixir_api/people/person.ex";

describe("vanilla elixir — sensitive(...) Inspect redaction", () => {
  it("emits a `defimpl Inspect` redacting a top-level sensitive field", async () => {
    const files = await generateSystemFiles(
      SYS(`aggregate Person { fullName: string  ssn: string sensitive(pii) }`),
    );
    const ex = files.get(PATH)!;
    expect(ex).toBeDefined();

    expect(ex).toContain("defimpl Inspect, for: ElixirApi.People.Person do");
    expect(ex).toContain("import Inspect.Algebra");
    expect(ex).toContain("def inspect(record, _opts) do");

    const line = ex.split("\n").find((l) => l.includes("string("))!;
    // ssn redacted, value never accessed; non-sensitive field reached.
    expect(line).toContain('"<redacted>"');
    expect(line).toContain('"ssn: "');
    expect(line).not.toMatch(/\brecord\.ssn\b/);
    expect(line).toMatch(/\brecord\.full_name\b/);
  });

  it("redacts a sensitive field inside an embedded value object", async () => {
    const files = await generateSystemFiles(
      SYS(`
        valueobject ContactInfo { email: string  phone: string sensitive(pii) }
        aggregate Person { fullName: string  contact: ContactInfo }
      `),
    );
    const ex = files.get(PATH)!;
    expect(ex).toContain("defimpl Inspect, for: ElixirApi.People.Person do");

    const line = ex.split("\n").find((l) => l.includes("string("))!;
    expect(line).toContain('"<redacted>"');
    expect(line).toContain('"phone: "');
    expect(line).not.toMatch(/record\.contact\.phone\b/);
    // Non-sensitive VO sibling reached normally — read via the key-type-agnostic
    // VO-subfield fallback (a VO is a string- or atom-keyed map; #1660), not
    // struct-dot (`record.contact.email` would KeyError on the string-keyed map).
    expect(line).toContain('Map.get(record.contact, :email, Map.get(record.contact, "email"))');
  });

  it("emits NO Inspect impl when no field is sensitive (byte-identical to before)", async () => {
    const files = await generateSystemFiles(
      SYS(`aggregate Person { fullName: string  ssn: string }`),
    );
    const ex = files.get(PATH)!;
    expect(ex).toBeDefined();
    expect(ex).not.toContain("defimpl Inspect");
  });
});
