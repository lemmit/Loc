import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `X id[]` reference collections on the vanilla (plain Ecto/Phoenix) foundation.
//
// Regression for the silent runtime-crash gap: vanilla used to emit
// `field :party, {:array, :binary_id}` on the owner schema while the migration
// created NO such column (only a `trainer_party` join table, which nothing
// read) — so the first `Repo.all(Trainer)`/insert hit `column "party" does not
// exist` at runtime, invisible to `mix compile`.  The fix wires the runtime
// layer to the already-correct join migration via an Ecto `many_to_many`
// relationship (mirroring the Ash foundation's `many_to_many … through …`),
// preloaded on read and `put_assoc`'d on write, projected to an id-array on the
// wire.
// ---------------------------------------------------------------------------

const SOURCE = `
system RC {
  subdomain Roster {
    context Roster {
      aggregate Pokemon with crudish {
        species: string
      }
      aggregate Trainer with crudish {
        name: string
        party: Pokemon id[]
      }
      repository Trainers for Trainer {
        find holdingInParty(pokemon: Pokemon id): Trainer[]
            where this.party.contains(pokemon)
      }
      repository Pokemons for Pokemon {}
    }
  }
  api RApi from Roster
  storage pg { type: postgres }
  resource st { for: Roster, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Roster]
    dataSources: [st]
    serves: RApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla `X id[]` reference collections", () => {
  it("the owner schema is a many_to_many through the join table — NOT a phantom array column", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    expect(trainer).toContain("many_to_many :party, Api.Roster.Pokemon");
    // `join_through:` is the BARE table name, NOT schema-qualified: the owner
    // schema's `@schema_prefix "roster"` already qualifies a string join_through
    // at query time, so qualifying it here would DOUBLE-prefix the join insert
    // (`"roster"."roster.trainer_party"` → undefined_table 500 at runtime — caught
    // only by a real boot, invisible to `mix compile`).
    expect(trainer).toContain('join_through: "trainer_party"');
    expect(trainer).not.toContain('join_through: "roster.trainer_party"');
    // the runtime-crash bug: a stored array column with no backing migration column
    expect(trainer).not.toContain("field :party");
  });

  it("the changeset does not cast/require the relationship as a plain field", async () => {
    const cs = file(await generateSystemFiles(SOURCE), "/roster/trainer_changeset.ex");
    expect(cs).not.toMatch(/validate_required\(\[[^\]]*:party/);
    expect(cs).not.toMatch(/cast\(attrs, \[[^\]]*:party/);
  });

  it("the repository preloads the relationship on read and put_assocs it on write", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/roster/trainer_repository.ex");
    expect(repo).toContain("Repo.preload([:party])");
    expect(repo).toContain("put_assoc");
  });

  it("the join-table migration is still emitted (the already-correct half)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const mig = [...files.keys()].find((k) => k.includes("create_trainer_party"));
    expect(mig, "trainer_party join migration not emitted").toBeDefined();
    expect(files.get(mig!)!).toContain("create table(:trainer_party");
  });

  it("the owner-table migration has NO party column (the relationship lives in the join table)", async () => {
    const files = await generateSystemFiles(SOURCE);
    const mig = [...files.keys()].find((k) => k.includes("create_trainers"));
    expect(mig).toBeDefined();
    expect(files.get(mig!)!).not.toMatch(/add :party/);
  });

  // DEBT-13: the collection round-trips in declaration/insertion order, matching
  // node (which writes `ordinal` from the field index and `orderBy`s it on read).
  // Order is preserved by (a) ordering the preload by the join `ordinal`, and
  // (b) stamping that ordinal from the incoming id-list index after persist.
  it("the read preloads in join-`ordinal` order (preload_order over the join binding)", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    // the many_to_many orders its preload by the join column via an MFA helper
    expect(trainer).toContain("preload_order: {__MODULE__, :__ref_coll_order, []}");
    // the helper pins the LAST (join) binding's ordinal — needs `import Ecto.Query`
    expect(trainer).toContain("import Ecto.Query");
    expect(trainer).toMatch(
      /def __ref_coll_order, do: \[asc: dynamic\(\[_assoc, join\], join\.ordinal\)\]/,
    );
  });

  it("the write stamps the join `ordinal` from the id-list index after persist", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/roster/trainer_repository.ex");
    // persist + stamp run atomically in one transaction
    expect(repo).toContain("Repo.transaction(fn ->");
    // the post-persist stamp pass is invoked for the `party` field
    expect(repo).toContain("__stamp_ref_ordinal_party(record, attrs)");
    // ...and it update_all's the join row's ordinal from the enumerated index,
    // scoped to the owner+target join row, in the owner schema's prefix.
    expect(repo).toContain("|> Enum.with_index()");
    expect(repo).toMatch(/set: \[ordinal: idx\]/);
    expect(repo).toMatch(/from\(j in "trainer_party",[\s\S]*j\.trainer_id == \^owner_id/);
    expect(repo).toContain("prefix: prefix");
  });
});
