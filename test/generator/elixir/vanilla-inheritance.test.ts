import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Aggregate inheritance (inheritance.md) on the vanilla (plain Ecto/Phoenix)
// foundation — the §8 runtime-500 fix (vanilla-phoenix-gaps.md).
//
// TPH (`sharedTable`) regression: a concrete subtype's Ecto schema used to
// point at `snake(plural(agg.name))` (`customers` / `vendors`) — tables the
// migration NEVER creates (TPH shares ONE table named for the abstract base,
// `parties`, with a `kind` discriminator).  Every read 500'd at runtime with
// "relation customers does not exist", invisible to `mix compile` (no DB).
//
// The fix: a TPH concrete's schema points at the shared base table and carries
// `kind`; its repository filters every read by `kind == "<Concrete>"` and
// stamps `kind` on insert.  The abstract base emits a read-only polymorphic
// reader (`find all <Base>`).  TPC (`ownTable`) per-concrete tables are left
// untouched; only its abstract base reader changes (delegate, no phantom table).
// ---------------------------------------------------------------------------

const TPH = `
system Parties {
  subdomain Registry {
    context Parties {
      abstract aggregate Party inheritanceUsing(sharedTable) {
        name: string
        email: string
      }
      aggregate Customer extends Party {
        creditLimit: int
      }
      aggregate Vendor extends Party { rating: int }
      repository Customers for Customer {
        find byEmail(email: string): Customer? where this.email == email
      }
      repository Vendors for Vendor { }
    }
  }
  api PartiesApi from Registry
  storage pg { type: postgres }
  resource partiesState { for: Parties, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Parties]
    dataSources: [partiesState]
    serves: PartiesApi
    port: 4000
  }
}
`;

const TPC = `
system Assets {
  subdomain Registry {
    context Assets {
      abstract aggregate Asset inheritanceUsing(ownTable) { label: string }
      aggregate Machine extends Asset { serial: string }
      aggregate Vehicle extends Asset { plate: string }
      repository Machines for Machine { }
      repository Vehicles for Vehicle { }
    }
  }
  api AssetsApi from Registry
  storage pg { type: postgres }
  resource assetsState { for: Assets, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Assets]
    dataSources: [assetsState]
    serves: AssetsApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla aggregate inheritance — TPH (sharedTable)", () => {
  it("a concrete subtype's schema points at the SHARED base table and carries the kind discriminator", async () => {
    const files = await generateSystemFiles(TPH);
    const customer = file(files, "/parties/customer.ex");
    // The shared base table — NOT the phantom `customers` table the migration
    // never creates (the §8 runtime 500).
    expect(customer).toContain('schema "parties" do');
    expect(customer).not.toContain('schema "customers"');
    // The `kind` discriminator + the merged base + own fields.
    expect(customer).toContain("field :kind, :string");
    expect(customer).toContain("field :name, :string");
    expect(customer).toContain("field :credit_limit, :integer");

    const vendor = file(files, "/parties/vendor.ex");
    expect(vendor).toContain('schema "parties" do');
    expect(vendor).toContain("field :rating, :integer");
  });

  it("a concrete repository filters every read by kind and stamps kind on insert", async () => {
    const repo = file(await generateSystemFiles(TPH), "/parties/customer_repository.ex");
    // list + find_by_id scope to this subtype's rows on the shared table.
    expect(repo).toMatch(/def list do[\s\S]*where: record\.kind == "Customer"/);
    expect(repo).toMatch(/def find_by_id\(id\)[\s\S]*record\.kind == "Customer"/);
    // insert stamps the discriminator so the shared-table row is routable back.
    expect(repo).toContain('Ecto.Changeset.put_change(:kind, "Customer")');
    // a custom find ALSO scopes to the subtype.
    expect(repo).toMatch(/def by_email\([\s\S]*record\.kind == "Customer"/);
  });

  it("the abstract base emits a read-only polymorphic reader over the shared table (find all <Base>)", async () => {
    const files = await generateSystemFiles(TPH);
    // The base schema declares the UNION of every subtype's columns + kind so
    // the reader can SELECT them off the shared table.
    const base = file(files, "/parties/party.ex");
    expect(base).toContain('schema "parties" do');
    expect(base).toContain("field :kind, :string");
    expect(base).toContain("field :credit_limit, :integer");
    expect(base).toContain("field :rating, :integer");
    // The base reader is read-only: list/find_by_id over the shared table, no
    // insert/update/delete (the base is never instantiated).
    const repo = file(files, "/parties/party_repository.ex");
    expect(repo).toContain("Repo.all(Api.Parties.Party)");
    expect(repo).toContain("Repo.get(Api.Parties.Party, id)");
    expect(repo).not.toContain("def insert");
    expect(repo).not.toContain("def delete");
    // No changeset is emitted for the abstract base.
    expect([...files.keys()].some((k) => k.endsWith("/parties/party_changeset.ex"))).toBe(false);
  });

  it("the abstract base's controller is read-only (index + show, no write actions)", async () => {
    const ctl = file(await generateSystemFiles(TPH), "/controllers/party_controller.ex");
    expect(ctl).toContain("def index(conn");
    expect(ctl).toContain("def show(conn");
    expect(ctl).not.toContain("def create(conn");
    expect(ctl).not.toContain("def update(conn");
    expect(ctl).not.toContain("def delete(conn");
  });
});

describe("vanilla aggregate inheritance — TPC (ownTable) unchanged + base reader", () => {
  it("a TPC concrete keeps its own standalone table and carries NO kind discriminator", async () => {
    const machine = file(await generateSystemFiles(TPC), "/assets/machine.ex");
    expect(machine).toContain('schema "machines" do');
    expect(machine).toContain("field :serial, :string");
    // TPC concretes are NOT shared-table — no `kind` discriminator.
    expect(machine).not.toContain("field :kind");
  });

  it("the TPC abstract base emits no schema and a delegating read-only reader", async () => {
    const files = await generateSystemFiles(TPC);
    // No `assets` table exists, so no Asset schema is emitted (a schema over the
    // phantom `assets` table would 500 on read).
    expect([...files.keys()].some((k) => k.endsWith("/assets/asset.ex"))).toBe(false);
    const repo = file(files, "/assets/asset_repository.ex");
    // Delegates to each concrete repository (the polymorphic find-all reader).
    expect(repo).toContain("Api.Assets.MachineRepository");
    expect(repo).toContain("Api.Assets.VehicleRepository");
    // Read-only — no write seam.
    expect(repo).not.toContain("def insert");
  });
});
