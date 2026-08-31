// .NET × TPH × capability `filter` (F2-CB-C2).
//
// The config emitter short-circuited the WHOLE query-filter list to `[]` for
// any TPH participant (`const filterLines = tph ? [] : …`), so a declared read
// restriction on a subtype — a criterion, a `softDeletable` visibility rule, a
// tenancy filter — was absent from every emitted query.  It compiled green, so
// no compile gate could see it: `LiveCriterion.cs` was emitted and referenced
// nowhere, and `CarRepository` read `_db.Cars` unfiltered.
//
// The short-circuit was hiding a real EF Core constraint rather than solving
// it.  EF applies a query filter to the ROOT entity type of a hierarchy only —
// `HasQueryFilter` on `IEntityTypeConfiguration<Car>` throws at MODEL BUILD
// ("A filter may only be applied to the root entity type 'Vehicle'"), which is
// exactly what the PRINCIPAL half did emit (`modelBuilder.Entity<Car>()`,
// never tph-gated), killing the generated app on its first request.
//
// So filters move to the root, `kind`-guarded and name-prefixed, and the
// residue EF structurally cannot express (a predicate reading a SUBTYPE-only
// column) gets the honest `loom.tph-filter-unsupported` gate — verified against
// EF Core 10.0.10, where both root-hosting workarounds fail as soon as the
// query source is a sibling subtype.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

async function emit(body: string): Promise<{
  files: Map<string, string>;
  diags: ReturnType<typeof validateLoomModel>;
}> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(body, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value as Model));
  const diags = validateLoomModel(loom);
  const sys = loom.systems[0]!;
  const dep = sys.deployables.find((d) => d.platform === "dotnet")!;
  const contexts = sys.subdomains.flatMap((m) => m.contexts);
  const ns = dep.name[0]!.toUpperCase() + dep.name.slice(1);
  return { files: generateDotnetForContexts(contexts, ns, { deployable: dep, sys }), diags };
}

/** `abstract Vehicle { name, retired }` + two concretes; `Car` carries the
 *  capability filter.  `criterionBody` picks whose column the criterion reads:
 *  a base one (expressible on the root) or `Car`'s own (not expressible). */
const model = (criterionBody: string): string => `
  system Acme {
    subdomain Registry {
      context Fleet {
        criterion Live of Car = ${criterionBody}
        abstract aggregate Vehicle { name: string  retired: bool }
        aggregate Car extends Vehicle { doors: int  filter Live }
        aggregate Truck extends Vehicle { payloadKg: int }
        repository Cars for Car { }
        repository Trucks for Truck { }
      }
    }
    storage primary { type: postgres }
    resource fleetState { for: Fleet, kind: state, use: primary }
    deployable api {
      platform: dotnet
      contexts: [Fleet]
      dataSources: [fleetState]
      port: 8080
    }
  }
`;

const fileNamed = (files: Map<string, string>, suffix: string): string =>
  [...files].find(([p]) => p.endsWith(suffix))?.[1] ?? "";

describe(".NET TPH × capability filter", () => {
  it("a subtype's filter over ROOT columns registers on the root config, kind-guarded", async () => {
    const { files, diags } = await emit(model("!this.retired"));
    expect(
      diags.filter((d) => d.severity === "error"),
      "a root-column filter is expressible — nothing is gated",
    ).toEqual([]);

    const baseCfg = fileNamed(files, "VehicleConfiguration.cs");
    expect(baseCfg, "base config emitted").not.toEqual("");
    // Registered on the ROOT — the only entity type EF accepts a filter on.
    expect(baseCfg, "the subtype's filter lands on the root config").toContain(
      'builder.HasQueryFilter("Car_LiveFilter", x => EF.Property<string>(x, "kind") != "Car" || (!x.Retired));',
    );

    // …and NOT on the subtype's own config, which is what threw at model build.
    const carCfg = fileNamed(files, "CarConfiguration.cs");
    expect(carCfg, "concrete config emitted").not.toEqual("");
    expect(carCfg, "a TPH subtype config hosts no query filter").not.toContain("HasQueryFilter");
  });

  it("the guard uses EF.Property, not a CLR downcast", async () => {
    // Both root-hosting workarounds were tried against EF Core 10.0.10.  A CLR
    // downcast (`!(x is Car) || ((Car)x).Doors > 0`) builds the model fine but
    // throws the moment a SIBLING subtype is queried: "No coercion operator is
    // defined between types 'Truck' and 'Car'".  The discriminator column
    // exists on every type in the hierarchy, so `EF.Property<string>(x, "kind")`
    // translates for all of them.
    const { files } = await emit(model("!this.retired"));
    const baseCfg = fileNamed(files, "VehicleConfiguration.cs");
    expect(baseCfg, "no `is` type-test in the guard").not.toContain("x is Car");
    expect(baseCfg, "no CLR downcast in the guard").not.toContain("((Car)x)");
  });

  it("a filter reading a SUBTYPE-only column is gated, not dropped and not mis-emitted", async () => {
    const { diags } = await emit(model("this.doors > 0"));
    const gated = diags.filter((d) => d.code === "loom.tph-filter-unsupported");
    expect(gated, "exactly one honest gate").toHaveLength(1);
    expect(gated[0]!.severity).toBe("error");
    expect(gated[0]!.message, "names the offending column").toContain("'doors'");
    expect(gated[0]!.message, "names the root it would have to live on").toContain("'Vehicle'");
  });

  it("`softDeletable` on the BASE emits its visibility filter (it used to be dropped whole)", async () => {
    // The realistic shape of C2, not a hand-written criterion: a soft-delete
    // capability on the hierarchy's base.  The short-circuit dropped its
    // `HasQueryFilter` entirely, so `_db.Cars` served rows the model says are
    // deleted.  It reads a ROOT column, so it registers unguarded — it applies
    // to every subtype, which is what a base-level capability means.
    const { files, diags } = await emit(`
      system Acme {
        subdomain Registry {
          context Fleet {
            abstract aggregate Vehicle with softDeletable { name: string }
            aggregate Car extends Vehicle with crudish { doors: int }
            repository Cars for Car { }
          }
        }
        storage primary { type: postgres }
        resource fleetState { for: Fleet, kind: state, use: primary }
        deployable api {
          platform: dotnet
          contexts: [Fleet]
          dataSources: [fleetState]
          port: 8080
        }
      }
    `);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(fileNamed(files, "VehicleConfiguration.cs")).toContain(
      'builder.HasQueryFilter("IsDeletedFilter", x => !x.IsDeleted);',
    );
  });

  it("`softDeletable` on the SUBTYPE is gated, and the gate's remedy is the case above", async () => {
    // The capability's column lands on the subtype, so EF cannot host its
    // filter — the gate names the column and points at the base.  Before, the
    // rows a soft delete hides were simply served.
    const { diags } = await emit(`
      system Acme {
        subdomain Registry {
          context Fleet {
            abstract aggregate Vehicle { name: string }
            aggregate Car extends Vehicle with softDeletable, crudish { doors: int }
            repository Cars for Car { }
          }
        }
        storage primary { type: postgres }
        resource fleetState { for: Fleet, kind: state, use: primary }
        deployable api {
          platform: dotnet
          contexts: [Fleet]
          dataSources: [fleetState]
          port: 8080
        }
      }
    `);
    const gated = diags.filter((d) => d.code === "loom.tph-filter-unsupported");
    expect(gated).toHaveLength(1);
    expect(gated[0]!.message).toContain("'isDeleted'");
  });

  it("a PRINCIPAL filter on a subtype registers on the root, with distinct names per subtype", async () => {
    // `modelBuilder.Entity<Car>().HasQueryFilter(…)` threw at model build; and
    // because both subtypes' `tenantOwned` produces the same base name
    // ("TenantIdFilter"), hosting them on one root type without a prefix would
    // have had the second registration silently OVERWRITE the first — one
    // subtype's tenant isolation vanishing.
    const { files, diags } = await emit(`
      system Acme {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain Registry {
          context Accounts { aggregate Org { title: string } }
          context Fleet {
            abstract aggregate Vehicle with tenantOwned { name: string }
            aggregate Car extends Vehicle with tenantOwned { doors: int }
            aggregate Truck extends Vehicle with tenantOwned { payloadKg: int }
            repository Cars for Car { }
            repository Trucks for Truck { }
          }
        }
        storage primary { type: postgres }
        resource fleetState { for: Fleet, kind: state, use: primary }
        resource accountsState { for: Accounts, kind: state, use: primary }
        deployable api {
          platform: dotnet
          contexts: [Fleet, Accounts]
          dataSources: [fleetState, accountsState]
          port: 8080
          auth: required
        }
      }
    `);
    expect(
      diags.filter((d) => d.code === "loom.tph-filter-unsupported"),
      "`tenantOwned` on the base puts tenantId on the ROOT — expressible, not gated",
    ).toEqual([]);

    const dbCtx = fileNamed(files, "AppDbContext.cs");
    expect(dbCtx, "AppDbContext emitted").not.toEqual("");
    expect(dbCtx, "no filter is registered on a derived entity type").not.toMatch(
      /modelBuilder\.Entity<(Car|Truck)>\(\)\.HasQueryFilter/,
    );
    expect(dbCtx, "Car's filter is on the root, guarded and prefixed").toContain(
      'modelBuilder.Entity<Vehicle>().HasQueryFilter("Car_TenantIdFilter", x => EF.Property<string>(x, "kind") != "Car" || (x.TenantId == _currentUser.User.TenantId));',
    );
    expect(dbCtx, "Truck's filter is a DISTINCT key, so neither overwrites the other").toContain(
      '"Truck_TenantIdFilter"',
    );
    // The abstract base was excluded from the walk entirely, so its own
    // principal filter was dropped on top of everything else.
    expect(dbCtx, "the base's own filter is registered too, unguarded").toContain(
      'modelBuilder.Entity<Vehicle>().HasQueryFilter("TenantIdFilter", x => x.TenantId == _currentUser.User.TenantId);',
    );
  });
});

// ---------------------------------------------------------------------------
// The stamp half of the same capability.  Found while compiling the fixture
// above: `abstract aggregate Vehicle with tenantOwned` + `Car extends Vehicle
// with tenantOwned` emitted an `AuditableInterceptor` whose `switch
// (entry.Entity)` listed the BASE's arm before its subtypes' — and C# matches
// type patterns in order, so `case Car e:` was unreachable.  Under
// `/warnaserror` that is `error CS8120` ×2: the generated project did not
// build at all, which no unit test could see because none of them compiled it.
// ---------------------------------------------------------------------------
describe(".NET TPH × capability stamp", () => {
  it("orders the interceptor's switch arms most-derived-first", async () => {
    const { files } = await emit(`
      system Acme {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain Registry {
          context Accounts { aggregate Org { title: string } }
          context Fleet {
            abstract aggregate Vehicle with tenantOwned { name: string }
            aggregate Car extends Vehicle with tenantOwned { doors: int }
            aggregate Truck extends Vehicle with tenantOwned { payloadKg: int }
            repository Cars for Car { }
            repository Trucks for Truck { }
          }
        }
        storage primary { type: postgres }
        resource fleetState { for: Fleet, kind: state, use: primary }
        resource accountsState { for: Accounts, kind: state, use: primary }
        deployable api {
          platform: dotnet
          contexts: [Fleet, Accounts]
          dataSources: [fleetState, accountsState]
          port: 8080
          auth: required
        }
      }
    `);
    const interceptor = fileNamed(files, "AuditableInterceptor.cs");
    expect(interceptor, "interceptor emitted").not.toEqual("");
    const at = (name: string) => interceptor.indexOf(`case ${name} e:`);
    expect(at("Car"), "Car arm present").toBeGreaterThan(-1);
    expect(at("Truck"), "Truck arm present").toBeGreaterThan(-1);
    expect(
      at("Vehicle"),
      "the base's arm is kept — a subtype with no stamps of its own falls through to it",
    ).toBeGreaterThan(-1);
    expect(at("Car"), "Car precedes its base (else CS8120: unreachable case)").toBeLessThan(
      at("Vehicle"),
    );
    expect(at("Truck"), "Truck precedes its base").toBeLessThan(at("Vehicle"));
  });
});
