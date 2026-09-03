// The .NET "ambient kernel" — the shared `Domain/Enums/*` + `Domain/
// ValueObjects/*` files every deployable gets from the root-level
// declarations — and the two ways it used to stop a project compiling.
//
// Both defects were found on `web/src/examples/erp`, whose two .NET services
// (`finance_api`, `people_api`) did not build.  Neither shape existed in the
// dotnet compile corpus, and `web/src/examples/**` was not even in that
// workflow's trigger paths, so nothing could have caught them.  The compile
// tier now carries a fixture for each (`vo-enum-field.ddd`,
// `no-create-vo-field.ddd`) plus the ERP itself; these are the fast-tier
// assertions on the exact emitted text.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

describe(".NET value-object emitter — usings derived from FIELD types", () => {
  const SRC = `
    enum Country { US, DE }
    enum Priority { Low, High }

    valueobject Address {
      line1: string
      country: Country
    }
    valueobject Routing {
      preferred: Priority?
      fallbacks: Priority[]
    }
    valueobject Weight {
      grams: int
      invariant grams > 0
    }

    context Catalog {
      aggregate Parcel {
        shipTo: Address
        routing: Routing
        weight: Weight
      }
      repository Parcels for Parcel {}
    }
  `;

  it("an enum-typed field pulls in `using <ns>.Domain.Enums;`", async () => {
    const files = generateDotnet(await parseValid(SRC));
    const address = files.get("Domain/ValueObjects/Address.cs");
    expect(address, "Address.cs not emitted").toBeDefined();
    // The property, the ctor parameter and the assignment all render a BARE
    // `Country`; without the using this is CS0246 three times over.
    expect(address).toContain("public Country Country { get; init; }");
    expect(address).toContain("using Catalog.Domain.Enums;");
  });

  it("reaches an enum through `optional` and `array` wrappers", async () => {
    const files = generateDotnet(await parseValid(SRC));
    const routing = files.get("Domain/ValueObjects/Routing.cs");
    expect(routing, "Routing.cs not emitted").toBeDefined();
    expect(routing).toContain("using Catalog.Domain.Enums;");
  });

  it("a value object with no enum field keeps a using-clean header", async () => {
    // CS8019 (unnecessary using) is fatal in the generated projects'
    // `/warnaserror` build, so the using is COLLECTED, never unconditional.
    const files = generateDotnet(await parseValid(SRC));
    const weight = files.get("Domain/ValueObjects/Weight.cs");
    expect(weight, "Weight.cs not emitted").toBeDefined();
    expect(weight).not.toContain("Domain.Enums");
  });
});

describe(".NET request validators — gated by what emits the create RECORD", () => {
  const SRC = `
    valueobject PersonName {
      first: string
      last: string
      invariant first.length >= 1
      invariant last.length >= 1
    }

    context Staffing {
      aggregate Employee {
        name: PersonName
        email: string
        operation rename(newName: PersonName) { name := newName }
      }
      aggregate Contractor {
        create(name: PersonName, agency: string) {
          name := name
          agency := agency
        }
        name: PersonName
        agency: string
      }
      repository Employees for Employee {}
      repository Contractors for Contractor {}
    }
  `;

  it("an aggregate with no canonical create emits neither the record nor its validator", async () => {
    const files = generateDotnet(await parseValid(SRC));
    const requests = files.get("Application/Employees/Requests/EmployeeRequests.cs");
    const validators = files.get("Application/Employees/Requests/EmployeeRequestValidators.cs");
    // The validators FILE still exists — the rule-bearing VO earns its own
    // `PersonNameRequestValidator`.  That is what made the orphan reachable.
    expect(validators, "EmployeeRequestValidators.cs not emitted").toBeDefined();
    expect(validators).toContain("PersonNameRequestValidator");
    expect(requests).not.toContain("record CreateEmployeeRequest");
    expect(validators).not.toContain("CreateEmployeeRequest");
  });

  it("an aggregate that DOES declare a create keeps both halves", async () => {
    const files = generateDotnet(await parseValid(SRC));
    const requests = files.get("Application/Contractors/Requests/ContractorRequests.cs");
    const validators = files.get("Application/Contractors/Requests/ContractorRequestValidators.cs");
    expect(requests).toContain("record CreateContractorRequest");
    expect(validators).toContain("AbstractValidator<CreateContractorRequest>");
  });
});

describe(".NET ambient-kernel pruning", () => {
  const SRC = `
    enum UsedStatus { On, Off }
    enum GhostStatus { Yes, No }

    valueobject UsedTag { label: string }
    valueobject GhostTag { label: string }

    context Shop {
      aggregate Item {
        status: UsedStatus
        tag: UsedTag
      }
      repository Items for Item {}
    }
  `;

  it("drops the root enums / value objects no other file in the project names", async () => {
    const files = generateDotnet(await parseValid(SRC));
    expect(files.has("Domain/Enums/UsedStatus.cs")).toBe(true);
    expect(files.has("Domain/ValueObjects/UsedTag.cs")).toBe(true);
    expect(files.has("Domain/Enums/GhostStatus.cs")).toBe(false);
    expect(files.has("Domain/ValueObjects/GhostTag.cs")).toBe(false);
  });

  it("keeps the namespace markers, so `using <ns>.Domain.Enums;` still resolves", async () => {
    // Emitters elsewhere write that using unconditionally; the marker is what
    // makes it legal in a project whose enums were all pruned.
    const files = generateDotnet(await parseValid(SRC));
    expect(files.has("Domain/Enums/_namespace.cs")).toBe(true);
    expect(files.has("Domain/ValueObjects/_namespace.cs")).toBe(true);
  });

  it("keeps an enum reached only THROUGH a kept value object", async () => {
    // The fixpoint: `Shade` is named by nothing but `UsedTag`'s own file, and
    // `UsedTag` survives only because the aggregate names it.
    const files = generateDotnet(
      await parseValid(`
        enum Shade { Light, Dark }
        valueobject UsedTag { label: string  shade: Shade }
        context Shop {
          aggregate Item { tag: UsedTag }
          repository Items for Item {}
        }
      `),
    );
    expect(files.has("Domain/ValueObjects/UsedTag.cs")).toBe(true);
    expect(files.has("Domain/Enums/Shade.cs")).toBe(true);
  });
});
