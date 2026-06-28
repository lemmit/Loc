import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateHono, parseString, parseValid, toLoomModel } from "../../_helpers/index.js";

// Reference collections (`field: Target id[]`) persist as many-to-many
// join tables (zero new grammar — any aggregate field whose type is a
// collection of references gets one).  These tests pin the three seams:
// schema emission, repository load/save diff-sync, and the membership
// query (`this.<refColl>.contains(param)`) lowering.

const SRC = `
  context Roster {
    aggregate Pokemon { species: string }
    aggregate Trainer {
      name: string
      party: Pokemon id[]
      caught: Pokemon id[]
    }
    repository Trainers for Trainer {
      find holdingInParty(pokemon: Pokemon id): Trainer[] where this.party.contains(pokemon)
    }
  }
`;

describe("reference-collection join tables (TS/Hono)", () => {
  it("emits a join table per T id[] field with a composite PK (set semantics, no ordinal), off the owner row", async () => {
    const model = await parseValid(SRC);
    const schema = generateHono(model).get("db/schema.ts")!;
    expect(schema).toMatch(/pgTable\("trainer_party"/);
    expect(schema).toMatch(/pgTable\("trainer_caught"/);
    expect(schema).toMatch(/primaryKey\(\{ columns: \[table\.trainerId, table\.pokemonId\] \}\)/);
    // `Id<T>[]` is contractually a set (membership only, no order): the
    // composite PK is the whole row, so the join table carries NO ordinal
    // column.  Deterministic read-back order is a read-time projection
    // (ORDER BY the target FK id), not stored state.
    const partyTable = schema.slice(
      schema.indexOf('pgTable("trainer_party"'),
      schema.indexOf('pgTable("trainer_caught"'),
    );
    expect(partyTable).not.toMatch(/ordinal/);
    // The owner table must NOT carry the reference-collection columns.
    const trainersTable = schema.slice(
      schema.indexOf('pgTable("trainers"'),
      schema.indexOf('pgTable("trainer_party"'),
    );
    expect(trainersTable).not.toMatch(/party/);
    expect(trainersTable).not.toMatch(/caught/);
  });

  it("hydrates from the join table ordered by the target FK id and diff-syncs rows on save", async () => {
    const model = await parseValid(SRC);
    const repo = generateHono(model).get("db/repositories/trainer-repository.ts")!;
    // load: select target ids for the owner, ordered by the target FK id
    // (deterministic, content-addressed), branded back
    expect(repo).toMatch(
      /from\(schema\.trainerParty\)\.where\(eq\(schema\.trainerParty\.trainerId, id\)\)\.orderBy\(schema\.trainerParty\.pokemonId\)/,
    );
    expect(repo).toMatch(/Ids\.PokemonId\(r\.t\)/);
    // save: delete removed pairs, then insert current ones — the pair IS
    // the whole row, so it's a plain composite-PK no-op upsert (no payload)
    expect(repo).toMatch(/toDeleteParty/);
    expect(repo).not.toMatch(/ordinal/);
    expect(repo).toMatch(
      /onConflictDoNothing\(\{ target: \[schema\.trainerParty\.trainerId, schema\.trainerParty\.pokemonId\] \}\)/,
    );
  });

  it("lowers this.<refColl>.contains(param) to a join-table subquery", async () => {
    const model = await parseValid(SRC);
    const repo = generateHono(model).get("db/repositories/trainer-repository.ts")!;
    expect(repo).toMatch(
      /inArray\(schema\.trainers\.id, this\.db\.select\(\{ id: schema\.trainerParty\.trainerId \}\)/,
    );
    expect(repo).toMatch(/where\(eq\(schema\.trainerParty\.pokemonId, pokemon\)\)/);
  });

  it("admits this.<refColl>.contains(p) as queryable but still rejects .count", async () => {
    const okSrc = `
      context Roster {
        aggregate Pokemon { species: string }
        aggregate Trainer { name: string  party: Pokemon id[] }
        repository Trainers for Trainer {
          find holding(pokemon: Pokemon id): Trainer[] where this.party.contains(pokemon)
        }
      }
    `;
    const ok = toLoomModel((await parseString(okSrc)).model);
    expect(validateLoomModel(ok).filter((d) => d.severity === "error")).toEqual([]);

    const badSrc = `
      context Roster {
        aggregate Pokemon { species: string }
        aggregate Trainer { name: string  party: Pokemon id[] }
        repository Trainers for Trainer {
          find big(): Trainer[] where this.party.count > 0
        }
      }
    `;
    const bad = toLoomModel((await parseString(badSrc)).model);
    expect(
      validateLoomModel(bad).some((d) => d.severity === "error" && /not queryable/.test(d.message)),
    ).toBe(true);
  });
});
