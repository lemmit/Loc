import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// The CRUD `delete` seam is gated on a reachable `destroy` operation.
//
// Audit `docs/audits/generated-code-ddd-review-2026-07.md`: a `softDeletable`
// aggregate with no `destroy` op still shipped a hard-`Repo.delete(record)` on
// its repository (plus a `delete_<agg>` context defdelegate and a controller
// `delete` action) even though the ROUTER — correctly — never routed a DELETE to
// it.  That was dead code, and worse, a hard-delete that defeats the very
// soft-delete filter the capability adds.  The router already gated the DELETE
// route on `(agg.destroys ?? []).length > 0`; the controller / context /
// repository seams did not.  `emitsRestDelete` (rest-surface.ts) now gates all
// four so they can never disagree.
//
// The `destroy_<agg>!` LiveView `DestroyForm` seam is a SEPARATE path (its own
// `hasDestroy` gate) and is intentionally unaffected — a detail-page destroy
// button still works.
// ---------------------------------------------------------------------------

const withCap = (cap: string) => `
system Demo {
  subdomain Core {
    context Teams {
      aggregate Squad with ${cap} { name: string }
      repository Squads for Squad { }
    }
  }
  storage s { type: postgres }
  resource st { for: Teams, kind: state, use: s }
  deployable api { platform: elixir  contexts: [Teams]  dataSources: [st]  port: 8080 }
}
`;

async function files(cap: string) {
  const f = await generateSystemFiles(withCap(cap));
  const get = (suffix: string) => f.get([...f.keys()].find((k) => k.endsWith(suffix))!)!;
  return {
    repo: get("/teams/squad_repository.ex"),
    ctx: get("lib/api/teams.ex"),
    ctl: get("/controllers/squad_controller.ex"),
    router: get("/router.ex"),
  };
}

describe("vanilla — CRUD delete seam gated on a reachable destroy", () => {
  it("softDeletable (no destroy): emits NO delete seam at any layer", async () => {
    const { repo, ctx, ctl, router } = await files("softDeletable");

    // Repository: no dead hard-delete (the audit's defect).
    expect(repo).not.toContain("def delete(");
    expect(repo).not.toContain("Repo.delete(record)");
    // The read/write surface it SHOULD keep is intact.
    expect(repo).toContain("def insert(attrs)");
    expect(repo).toContain(
      "def update(%Api.Teams.Squad{} = record, attrs, expected_version \\\\ nil)",
    );
    expect(repo).toContain("def persist_change(");

    // Context: no `delete_squad` defdelegate (and no orphaned `as: :delete`).
    expect(ctx).not.toContain("delete_squad");
    expect(ctx).not.toContain("as: :delete");
    expect(ctx).toContain("defdelegate update_squad(record, attrs, expected_version \\\\ nil)");

    // Controller: no dead `delete` action.
    expect(ctl).not.toContain("def delete(conn");

    // Router: DELETE route was already (correctly) absent.
    expect(router).not.toMatch(/delete "\/squads\/:id"/);
  });

  it("crudish (has destroy): emits the full delete seam + DELETE route", async () => {
    const { repo, ctx, ctl, router } = await files("crudish");

    expect(repo).toContain("def delete(%Api.Teams.Squad{} = record) do");
    expect(repo).toContain("Repo.delete(record)");

    expect(ctx).toContain(
      "defdelegate delete_squad(record), to: Api.Teams.SquadRepository, as: :delete",
    );

    expect(ctl).toContain('def delete(conn, %{"id" => id}) do');
    expect(ctl).toContain("Teams.delete_squad(record)");

    expect(router).toMatch(/delete "\/squads\/:id", SquadController, :delete/);
  });
});
