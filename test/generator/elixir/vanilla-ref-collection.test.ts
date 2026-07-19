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
    platform: elixir
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

  // §4: a `where this.party.contains(pokemon)` find short-circuits to a valid
  // Ecto membership query — a `join: … in assoc(record, :party)` over the
  // many_to_many with `where: join_row.id == ^arg` — NOT the dead Ash-shaped
  // `exists(...)` arm in render-expr.ts (the filter never reaches it).
  it("a contains-in-where find emits the assoc-join membership query", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/roster/trainer_repository.ex");
    expect(repo).toContain("def holding_in_party(pokemon)");
    expect(repo).toContain("join: join_row in assoc(record, :party)");
    expect(repo).toContain("where: join_row.id == ^pokemon");
  });

  // Regression (docs/audits/repo-code-review-2026-07.md E2): a `contains` over a
  // reference collection in an OPERATION BODY (a precondition) must render the
  // in-memory membership form `Enum.member?(__ref_id_list(record.<field>), x)`,
  // NOT the removed Ash `exists(<field>_through, id == ^arg(:x))` filter, which
  // referenced undefined `exists/2`/`arg/1`/`<field>_through` → `mix compile`
  // failed on the generated project.  The context must also emit `__ref_id_list/1`
  // even when the op only READS the collection (no `+=`/`-=`).
  it("a contains precondition in an op body renders in-memory membership, not Ash exists", async () => {
    const src = `
system RC2 {
  subdomain Roster {
    context Roster {
      aggregate Pokemon with crudish { species: string }
      aggregate Trainer with crudish {
        name: string
        party: Pokemon id[]
        operation adopt(pokemon: Pokemon id) {
          precondition !(this.party.contains(pokemon))
          party += pokemon
        }
      }
      repository Trainers for Trainer {}
      repository Pokemons for Pokemon {}
    }
  }
  api RApi from Roster
  storage pg { type: postgres }
  resource st { for: Roster, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Roster], dataSources: [st], serves: RApi, port: 4000 }
}`;
    const ctxMod = file(await generateSystemFiles(src), "/roster.ex");
    expect(ctxMod).toContain("Enum.member?(__ref_id_list(record.party), pokemon)");
    expect(ctxMod).not.toContain("exists(");
    expect(ctxMod).not.toContain("^arg(");
    // The helper the membership form depends on is emitted (a READ alone arms it).
    expect(ctxMod).toContain("defp __ref_id_list(");
  });

  // Same shape but the op ONLY reads the collection (no `+=`) — the helper gate
  // must still arm, or the emitted `__ref_id_list` call is undefined.
  it("emits __ref_id_list even when a contains-only op never mutates the collection", async () => {
    const src = `
system RC3 {
  subdomain Roster {
    context Roster {
      aggregate Pokemon with crudish { species: string }
      aggregate Trainer with crudish {
        name: string
        party: Pokemon id[]
        operation ensureUnseen(pokemon: Pokemon id) {
          precondition !(this.party.contains(pokemon))
        }
      }
      repository Trainers for Trainer {}
      repository Pokemons for Pokemon {}
    }
  }
  api RApi from Roster
  storage pg { type: postgres }
  resource st { for: Roster, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Roster], dataSources: [st], serves: RApi, port: 4000 }
}`;
    const ctxMod = file(await generateSystemFiles(src), "/roster.ex");
    expect(ctxMod).toContain("Enum.member?(__ref_id_list(record.party), pokemon)");
    expect(ctxMod).toContain("defp __ref_id_list(");
  });
});
