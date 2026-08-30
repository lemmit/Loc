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

// ---------------------------------------------------------------------------
// EVENT-SOURCED aggregates with a reference collection.
//
// The ES controller serializes the FOLDED struct from `wireShape` — except when
// the aggregate carried an `X id[]` field, where it fell back to the raw
// `Map.from_struct |> Map.drop` dump: `wireShape`'s ref-collection projection
// calls `__ref_ids/1`, and the relational helper (`Enum.map(records, & &1.id)`)
// is wrong here — an ES fold has no Ecto association, it appends the id VALUE
// (`crewIds += e.sailor`), so the field already holds the id list.  The result
// was a snake_cased body that contradicted this backend's OWN served
// `<Agg>Response` schema, on the one aggregate shape that hit the fallback.
// ---------------------------------------------------------------------------
const ES_SRC = `
system EsRC {
  subdomain Fleet {
    context Fleet {
      event ShipNamed { ship: Ship id, name: string }
      event SailorHired { ship: Ship id, sailor: Sailor id }
      aggregate Ship persistedAs: eventLog {
        homePort: string
        crewIds: Sailor id[]
        create launch(homePort: string) { emit ShipNamed { ship: id, name: homePort } }
        operation hire(sailor: Sailor id) { emit SailorHired { ship: id, sailor: sailor } }
        apply(e: ShipNamed) { homePort := e.name }
        apply(e: SailorHired) { crewIds += e.sailor }
      }
      aggregate Sailor with crudish {
        name: string
        mateIds: Sailor id[]
      }
      repository Ships for Ship { }
      repository Sailors for Sailor { }
    }
  }
  api FleetApi from Fleet
  storage pg { type: postgres }
  resource fleetState { for: Fleet, kind: state, use: pg }
  resource fleetLog { for: Fleet, kind: eventLog, use: pg }
  deployable api { platform: elixir, contexts: [Fleet], dataSources: [fleetState, fleetLog], serves: FleetApi, port: 4000 }
}`;

describe("vanilla elixir — ES aggregate with a reference collection serializes its wireShape", () => {
  it("projects the folded struct through wireShape, not the raw struct dump", async () => {
    const ctrl = file(await generateSystemFiles(ES_SRC), "/ship_controller.ex");
    expect(ctrl).toContain('"id" => record.id');
    expect(ctrl).toContain('"homePort" => record.home_port');
    expect(ctrl).toContain('"crewIds" => __ref_ids(record.crew_ids)');
    // The snake-cased raw dump is gone.
    expect(ctrl).not.toContain("Map.from_struct()");
    expect(ctrl).not.toContain("Map.drop([:__meta__, :__struct__])");
  });

  it("emits the IN-MEMORY __ref_ids/1 (identity over the folded id list)", async () => {
    const ctrl = file(await generateSystemFiles(ES_SRC), "/ship_controller.ex");
    expect(ctrl).toContain("defp __ref_ids(ids) when is_list(ids), do: ids");
    expect(ctrl).toContain("defp __ref_ids(_), do: []");
    // NOT the relational assoc helper — `& &1.id` on a folded id binary raises.
    expect(ctrl).not.toContain("Enum.map(records, & &1.id)");
    expect(ctrl).not.toContain("%Ecto.Association.NotLoaded{}");
  });

  it("serves the SAME wire keys its own OpenAPI ShipResponse declares", async () => {
    const files = await generateSystemFiles(ES_SRC);
    const schema = file(files, "/schemas/ship_response.ex");
    expect(schema).toContain("crewIds:");
    expect(schema).toContain("homePort:");
    const ctrl = file(files, "/ship_controller.ex");
    for (const key of ["id", "homePort", "crewIds"]) expect(ctrl).toContain(`"${key}" =>`);
  });

  it("matches the RELATIONAL twin's projection shape for the same field kind", async () => {
    const files = await generateSystemFiles(ES_SRC);
    const es = file(files, "/ship_controller.ex");
    const rel = file(files, "/sailor_controller.ex");
    // Both project an `X id[]` to a camelCase id array through `__ref_ids/1`;
    // only the helper body differs (Ecto assoc vs in-memory fold).
    expect(rel).toContain('"mateIds" => __ref_ids(record.mate_ids)');
    expect(es).toContain('"crewIds" => __ref_ids(record.crew_ids)');
    expect(rel).toContain(
      "defp __ref_ids(records) when is_list(records), do: Enum.map(records, & &1.id)",
    );
  });
});
