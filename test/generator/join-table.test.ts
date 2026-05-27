import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateHono, parseString, parseValid, toLoomModel } from "../_helpers/index.js";

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
  it("emits a join table per T id[] field with a composite PK + ordinal, off the owner row", async () => {
    const model = await parseValid(SRC);
    const schema = generateHono(model).get("db/schema.ts")!;
    expect(schema).toMatch(/pgTable\("trainer_party"/);
    expect(schema).toMatch(/pgTable\("trainer_caught"/);
    expect(schema).toMatch(/primaryKey\(\{ columns: \[table\.trainerId, table\.pokemonId\] \}\)/);
    // Ordinal column lives in the TS schema as a notNull integer; the
    // wire contract for `Id<T>[]` is unordered (see docs/language.md),
    // but TS persists & reads back in field order as a backend-local
    // implementation detail.
    expect(schema).toMatch(/ordinal: integer\("ordinal"\)\.notNull\(\)/);
    // The owner table must NOT carry the reference-collection columns.
    const trainersTable = schema.slice(
      schema.indexOf('pgTable("trainers"'),
      schema.indexOf('pgTable("trainer_party"'),
    );
    expect(trainersTable).not.toMatch(/party/);
    expect(trainersTable).not.toMatch(/caught/);
  });

  it("hydrates from the join table in ordinal order and diff-syncs rows on save", async () => {
    const model = await parseValid(SRC);
    const repo = generateHono(model).get("db/repositories/trainer-repository.ts")!;
    // load: select target ids for the owner, ordered by ordinal, branded back
    expect(repo).toMatch(
      /from\(schema\.trainerParty\)\.where\(eq\(schema\.trainerParty\.trainerId, id\)\)\.orderBy\(schema\.trainerParty\.ordinal\)/,
    );
    expect(repo).toMatch(/Ids\.PokemonId\(r\.t\)/);
    // save: delete removed pairs, then upsert current rows carrying their
    // position so reorders persist
    expect(repo).toMatch(/toDeleteParty/);
    expect(repo).toMatch(/ordinal: i/);
    expect(repo).toMatch(
      /onConflictDoUpdate\(\{ target: \[schema\.trainerParty\.trainerId, schema\.trainerParty\.pokemonId\], set: \{ ordinal: i \} \}\)/,
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
