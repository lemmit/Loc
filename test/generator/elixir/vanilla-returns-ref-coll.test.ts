import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-03 (vanilla) — a reference-collection (`X id[]` → `many_to_many`)
// `add`/`remove` inside an `or`-union *returning* operation.
//
// Regression for a silent miscompile: the returning-op emitter omitted the
// enriched aggregate from its render context (unlike the non-returning path),
// so `members += t` fell through to the containment-jsonb branch and the success
// tail returned an in-memory projection with NO join-table write — `mix compile`
// passed, but the row never persisted and `many_to_many` structs leaked on the
// wire.  The returning op must now mirror the non-returning `addToParty`: bind
// the id-list local, persist via a `put_assoc` changeset, and project the
// ref-collection field to ids (`__ref_id_list/1`) on the success wire.
// ---------------------------------------------------------------------------

const SOURCE = `
system Club {
  subdomain Core {
    context Membership {
      error Full { reason: string }
      aggregate Tag { label: string }
      aggregate Team {
        name: string
        members: Tag id[]
        operation enroll(t: Tag id): Team or Full {
          precondition members.count < 5
          members += t
        }
        operation drop(t: Tag id): Team or Full {
          precondition members.count > 0
          members -= t
        }
      }
      repository Teams for Team { }
      repository Tags for Tag { }
    }
  }
  api ClubApi from Core
  storage pg { type: postgres }
  resource st { for: Membership, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Membership]
    dataSources: [st]
    serves: ClubApi
    port: 4000
  }
}`;

describe("vanilla returning op — reference-collection add/remove (DEBT-03)", () => {
  it("binds the id-list local, persists via put_assoc, and projects the wire to ids", async () => {
    const files = await generateSystemFiles(SOURCE);
    const ctx = [...files.entries()].find(([k]) => k.endsWith("/lib/api/membership.ex"))?.[1];
    expect(ctx).toBeDefined();

    // `add` binds the id-list local off the loaded assoc (NOT a struct-rebind).
    expect(ctx!).toMatch(/members = __ref_id_list\(record\.members\) \+\+ \[t\]/);
    // `remove` drops from the id list.
    expect(ctx!).toMatch(/members = List\.delete\(__ref_id_list\(record\.members\), t\)/);
    // The success path persists the join table via a put_assoc changeset.
    expect(ctx!).toMatch(
      /Ecto\.Changeset\.put_assoc\(:members, __resolve_refs\(members, Api\.Membership\.Tag\)\)/,
    );
    expect(ctx!).toMatch(/case Api\.Membership\.TeamRepository\.persist_change\(changeset\) do/);
    // The success wire projects the ref collection to ids, off the SAVED struct.
    expect(ctx!).toMatch(/\{:ok, %\{[^}]*members: __ref_id_list\(saved\.members\)[^}]*\}\}/);
    // The broken containment-jsonb branch must NOT appear for the ref collection.
    expect(ctx!).not.toMatch(/record = %\{record \| members: \(record\.members \|\| \[\]\)/);
    // And no in-memory success tuple over the unsaved `record` for a ref-coll op.
    expect(ctx!).not.toMatch(/\{:ok, %\{[^}]*members: record\.members/);
  });
});
