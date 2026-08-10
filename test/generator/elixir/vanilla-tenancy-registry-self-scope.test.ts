// ---------------------------------------------------------------------------
// Elixir (plain Ecto/Phoenix) backend — derived tenancy registry self-scope
// filter (multi-tenancy Phase 1b, capstone decision 4).
//
// The registry's derived `this.id == currentUser.tenantId` is AND-ed into
// every root read.  It does NOT ride the plain pinned-principal path: Ecto
// casts a pinned param against the `:binary_id` field, so raw token text
// raised `Ecto.Query.CastError` — a 500 for an ordinary bad token, and the
// same cast is why a nil principal raised rather than reading empty despite
// the fail-closed intent (M-T3.7(c)).  The claim is cast in ELIXIR instead
// (nil on failure) and compared through a `fragment`, the same escape the
// deep-scope sentinel uses: a fragment param binds as-is, so nil is NULL and
// `id = NULL` is false for every row.  `dump/1` rather than `cast/1` because
// binding as-is also means Postgrex never sees the field type and needs the
// raw 16-byte binary — `cast/1` returns the hyphenated string and would have
// broken every well-formed claim.  The insert path takes bare attrs — no
// principal, so the claim-less signup bootstrap stays open.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = readFileSync("test/fixtures/corpus/tenancy-owned.ddd", "utf8").replace(
  "__PLATFORM__",
  "elixir",
);
const CAST =
  "^(case Ecto.UUID.dump(current_user && current_user.tenant_id) do {:ok, uuid} -> uuid; :error -> nil end)";
const PINNED = `fragment("? = ?", record.id, ${CAST})`;

describe("elixir vanilla generator — derived registry self-scope filter", () => {
  it("ANDs the pinned self-scope into every registry root read", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/lib/d/accounts/organization_repository.ex")!;
    expect(repo).toContain(`where: ${PINNED})`); // list
    expect(repo).toContain(`where: record.id == ^id and (${PINNED})`); // find_by_id
  });

  it("never pins the raw claim against the binary_id field (M-T3.7(c))", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/lib/d/accounts/organization_repository.ex")!;
    // Reverting the fix restores this shape, which is exactly what Ecto's
    // planner casts — and raises on for a malformed claim.
    expect(repo).not.toContain("record.id == ^(current_user && current_user.tenant_id)");
    // The comparison stays on the uuid column (a fragment param, not a
    // column-to-text cast), so the primary-key index still serves the read.
    expect(repo).toContain('fragment("? = ?", record.id,');
  });

  it("does NOT thread the claim into the registry's insert path (bootstrap stays open)", async () => {
    const files = await generateSystemFiles(SRC);
    const repo = files.get("d/lib/d/accounts/organization_repository.ex")!;
    const insertBody = repo.slice(repo.indexOf("def insert("), repo.indexOf("def update("));
    expect(insertBody).not.toContain("current_user");
    const changeset = files.get("d/lib/d/accounts/organization_changeset.ex")!;
    expect(changeset).not.toContain("tenant_id");
  });
});
