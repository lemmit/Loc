// Optional strongly-typed id from the wire (generated-code-ddd-review P0 #4).
//
// An `X id?` field crosses the .NET wire as `Guid?` — a VALUE type, so the
// null-forgiving `!` does not produce the `Guid` the id ctor takes:
// `new PersonId(request.Owner!)` is a CS1503 under /warnaserror.  Inside the
// null guard the conversion must unwrap with `.Value`.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Team {
    aggregate Person with crudish { name: string }
    aggregate Chore with crudish { title: string  owner: Person id? }
    repository People for Person { }
    repository Chores for Chore { }
  }
`;

describe(".NET wire → command mapping — optional id", () => {
  it("unwraps the Guid? request field with .Value inside the null guard", async () => {
    const files = generateDotnet(await parseValid(SRC));
    const key = [...files.keys()].find((k) => k.endsWith("ChoresController.cs"));
    if (!key) throw new Error(`no ChoresController.cs; have:\n${[...files.keys()].join("\n")}`);
    const ctrl = files.get(key)!;
    expect(ctrl).toContain("(request.Owner is null ? null : new PersonId(request.Owner!.Value))");
    expect(ctrl).not.toContain("new PersonId(request.Owner!)\n");
  });

  it("EF-maps the PersonId? property with a converter over the non-nullable id", async () => {
    // Without a conversion the nullable struct property falls through EF's
    // model validation: "The 'PersonId?' property ... could not be mapped" —
    // a BOOT crash (caught live by the conformance-parity compose run).  The
    // two-lambda nullable form carries explicit (Guid?)/(PersonId?) casts so
    // null round-trips without CS8629 under /warnaserror.
    const files = generateDotnet(await parseValid(SRC));
    const cfg = files.get("Infrastructure/Persistence/Configurations/ChoreConfiguration.cs")!;
    expect(cfg).toContain(
      "builder.Property(x => x.Owner).HasConversion(v => v.HasValue ? v.Value.Value : (Guid?)null, v => v.HasValue ? (PersonId?)new PersonId(v.Value) : (PersonId?)null)",
    );
    expect(cfg).toContain('.HasColumnName("owner")');
  });
});
