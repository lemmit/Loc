import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate.js";
import { generateHono, parseString, parseValid, toLoomModel } from "../_helpers/index.js";

// Reference collections (`field: Id<Target>[]`) persist as many-to-many
// join tables (zero new grammar — any aggregate field whose type is a
// collection of references gets one).  These tests pin the three seams:
// schema emission, repository load/save diff-sync, and the membership
// query (`this.<refColl>.contains(param)`) lowering.

const SRC = `
  context Roster {
    aggregate Pokemon { species: string }
    aggregate Trainer {
      name: string
      party: Id<Pokemon>[]
      caught: Id<Pokemon>[]
    }
    repository Trainers for Trainer {
      find holdingInParty(pokemon: Id<Pokemon>): Trainer[] where this.party.contains(pokemon)
    }
  }
`;

describe("reference-collection join tables (TS/Hono)", () => {
  it("emits a join table per Id<T>[] field with a composite PK, off the owner row", async () => {
    const model = await parseValid(SRC);
    const schema = generateHono(model).get("db/schema.ts")!;
    expect(schema).toMatch(/pgTable\("trainer_party"/);
    expect(schema).toMatch(/pgTable\("trainer_caught"/);
    expect(schema).toMatch(
      /primaryKey\(\{ columns: \[table\.trainerId, table\.pokemonId\] \}\)/,
    );
    // The owner table must NOT carry the reference-collection columns.
    const trainersTable = schema.slice(
      schema.indexOf('pgTable("trainers"'),
      schema.indexOf('pgTable("trainer_party"'),
    );
    expect(trainersTable).not.toMatch(/party/);
    expect(trainersTable).not.toMatch(/caught/);
  });

  it("hydrates from the join table on load and diff-syncs rows on save", async () => {
    const model = await parseValid(SRC);
    const repo = generateHono(model).get("db/repositories/trainer-repository.ts")!;
    // load: select target ids for the owner, brand them back
    expect(repo).toMatch(
      /from\(schema\.trainerParty\)\.where\(eq\(schema\.trainerParty\.trainerId, id\)\)/,
    );
    expect(repo).toMatch(/Ids\.PokemonId\(r\.t\)/);
    // save: delete removed pairs, insert current (idempotent)
    expect(repo).toMatch(/__toDeleteParty/);
    expect(repo).toMatch(/onConflictDoNothing\(\)/);
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
        aggregate Trainer { name: string  party: Id<Pokemon>[] }
        repository Trainers for Trainer {
          find holding(pokemon: Id<Pokemon>): Trainer[] where this.party.contains(pokemon)
        }
      }
    `;
    const ok = toLoomModel((await parseString(okSrc)).model);
    expect(validateLoomModel(ok).filter((d) => d.severity === "error")).toEqual([]);

    const badSrc = `
      context Roster {
        aggregate Pokemon { species: string }
        aggregate Trainer { name: string  party: Id<Pokemon>[] }
        repository Trainers for Trainer {
          find big(): Trainer[] where this.party.count > 0
        }
      }
    `;
    const bad = toLoomModel((await parseString(badSrc)).model);
    expect(
      validateLoomModel(bad).some(
        (d) => d.severity === "error" && /not queryable/.test(d.message),
      ),
    ).toBe(true);
  });
});
