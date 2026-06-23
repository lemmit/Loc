import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `X id[]` reference collections on the ASH foundation.
//
// Regression for the silent runtime gap a real boot surfaced: the Ash path
// emitted the m2m relationships block + a calculate but left the feature broken
// end-to-end (`mix compile` clean, but every request 4xx/5xx):
//   1. the create/update ACTIONS never wired the join — create `accept`ed only
//      the scalars (POST 422 "No such input party"), and the crudish update
//      emitted `change_attribute(:party, …)` on a NON-attribute.
//   2. the Jason encoder OMITTED the field, so it never reached the wire.
//   3. the join RESOURCE carried no `schema`, so reads queried
//      `public.<join>` while the table lives in the context schema
//      (`undefined_table`).
//   4. the read projection was `calculate :party, {:array,:uuid}, expr(
//      party_through.id)` — `expr(<to-many>.id)` is single-valued, so Postgres
//      rejected the `::uuid[]` cast (`cannot cast type uuid to uuid[]`).
//
// The fix mirrors the VO-collection seam: a `manage_relationship` set-replace on
// create+update, the field in the encoder, a `schema` on the join resource, and
// a `list` AGGREGATE (not a calculate) for the read projection.  All four were
// boot-verified (POST party=[a,b] → 201 → GET → ids round-trip → UPDATE
// set-replace → GET shows the reduced set).
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
      repository Trainers for Trainer {}
      repository Pokemons for Pokemon {}
    }
  }
  api RApi from Roster
  storage pg { type: postgres }
  resource st { for: Roster, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: ash }
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

describe("ash `X id[]` reference collections", () => {
  it("create wires manage_relationship and does NOT accept the field as an attribute", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    const create = trainer.slice(trainer.indexOf("create :create"), trainer.indexOf("update :"));
    expect(create).toContain("argument :party, {:array, :uuid}");
    expect(create).toContain(
      "change manage_relationship(:party, :party_through, type: :append_and_remove)",
    );
    // the runtime 422 bug: party must NOT be in the `accept` list (it's not a
    // stored attribute) and must NOT be matched against a named `:id` identity.
    expect(create).toMatch(/accept \[:name\]/);
    expect(create).not.toContain("use_identities");
  });

  it("the crudish update set-replaces via manage_relationship, NOT change_attribute", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    const update = trainer.slice(trainer.indexOf("update :update"));
    expect(update).toContain(
      "change manage_relationship(:party, :party_through, type: :append_and_remove)",
    );
    // the broken form: `change_attribute(:party, …)` on the calculated field.
    expect(update).not.toContain("change_attribute(:party");
  });

  it("the wire encoder includes the reference-collection field", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    expect(trainer).toMatch(/encode_struct\(value, \[[^\]]*:party[^\]]*\]/);
  });

  it("the read projection is a `list` aggregate, NOT a single-valued calculate", async () => {
    const trainer = file(await generateSystemFiles(SOURCE), "/roster/trainer.ex");
    expect(trainer).toContain("list :party, :party_through, :id");
    // the `cannot cast type uuid to uuid[]` bug: a calculate over the to-many id.
    expect(trainer).not.toContain("calculate :party, {:array, :uuid}, expr(party_through.id)");
  });

  it("the join resource declares the context schema (else reads hit public.<table>)", async () => {
    const join = file(await generateSystemFiles(SOURCE), "/roster/trainer_party.ex");
    const postgres = join.slice(join.indexOf("postgres do"), join.indexOf("end"));
    expect(postgres).toContain('table "trainer_party"');
    expect(postgres).toContain('schema "roster"');
  });
});
