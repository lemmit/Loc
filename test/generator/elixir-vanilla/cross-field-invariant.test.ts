import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Cross-field aggregate invariants on the vanilla (Ecto/Phoenix) foundation
// (`validate_invariants/1`, changeset-invariant-emit).
//
// A single-field invariant (`price >= 0`) maps to an idiomatic `validate_number`
// line.  A CROSS-field invariant (`handle != email`) fits no such chain, so
// before this seam it was silently DROPPED on every path — the audit's
// signable-blocking gap (`docs/audits/generated-code-ddd-review-2026-07.md`).
// It now renders as a custom Ecto validation piped onto base_changeset,
// update_changeset, AND the operation-persist path (parity with the other
// backends' domain-floor `AssertInvariants()`).
// ---------------------------------------------------------------------------

function sys(body: string): string {
  return `
system S {
  subdomain Accounts {
    context Accounts {
      ${body}
      repository Profiles for Profile { }
    }
  }
  api A from Accounts
  storage pg { type: postgres }
  resource st { for: Accounts, kind: state, use: pg }
  deployable api { platform: elixir contexts: [Accounts] dataSources: [st] serves: A port: 4000 }
}
`;
}

async function changesetOf(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith("/accounts/profile_changeset.ex"))!;
  return files.get(key)!;
}

describe("vanilla — cross-field invariant enforcement", () => {
  it("emits validate_invariants/1 and pipes it onto base_changeset", async () => {
    const cs = await changesetOf(
      sys(`aggregate Profile with crudish {
        handle: string
        email: string
        invariant handle != email
      }`),
    );
    expect(cs).toContain("def validate_invariants(changeset) do");
    expect(cs).toContain("data = apply_changes(changeset)");
    // The predicate renders against the applied struct, byte-for-byte the domain
    // comparison, and attaches the error to the first referenced field.
    expect(cs).toContain(
      'if data.handle != data.email, do: changeset, else: add_error(changeset, :handle, "must satisfy: handle != email")',
    );
    // Piped onto the create seam.
    expect(cs).toMatch(/def base_changeset[\s\S]*\|> validate_invariants\(\)/);
  });

  it("renders a guarded (when) cross-field invariant as a conditional block", async () => {
    const cs = await changesetOf(
      sys(`aggregate Profile with crudish {
        handle: string
        email: string
        status: string
        invariant handle != email when status == "active"
      }`),
    );
    expect(cs).toContain('if data.status == "active" do');
    expect(cs).toMatch(/if data\.status == "active" do\s*\n\s*if data\.handle != data\.email/);
  });

  it("routes the operation-persist path through validate_invariants (force_change then validate)", async () => {
    const files = await generateSystemFiles(
      sys(`aggregate Profile with crudish {
        handle: string
        email: string
        invariant handle != email
        operation rename(newHandle: string) { handle := newHandle }
      }`),
    );
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/accounts.ex"))!)!;
    expect(ctx).toMatch(
      /force_change\(:handle[\s\S]*\|> Api\.Accounts\.ProfileChangeset\.validate_invariants\(\)\s*\n\s*\|> Api\.Accounts\.ProfileRepository\.persist_change\(\)/,
    );
  });

  it("is byte-identical (no seam) when the aggregate has only single-field invariants", async () => {
    const cs = await changesetOf(
      sys(`aggregate Profile with crudish {
        handle: string
        email: string
        invariant handle.length <= 40
      }`),
    );
    expect(cs).not.toContain("validate_invariants");
    expect(cs).toContain("|> validate_length(:handle, max: 40)");
  });
});
