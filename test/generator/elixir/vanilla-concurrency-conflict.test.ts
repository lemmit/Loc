import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// Vanilla (Ecto/Phoenix) — the `versioned` capability drives Ecto's native
// optimistic lock.  The update changeset is `base |> optimistic_lock(:version)`;
// the context/repo update takes `expected_version \\ nil`, overrides the
// struct's version before the changeset, and rescues `Ecto.StaleEntryError ->
// {:error, :conflict}`; the controller reads the expected version off the
// `if-match` header and maps `{:error, :conflict}` to `conflict_response/1`
// (409 Conflict, a DISTINCT `conflict` catalog event — parity with the
// Hono/Python/Java/.NET arms).  A NON-versioned aggregate is byte-identical,
// gated on `aggregateIsVersioned`.
//
// Sibling of vanilla-unique-conflict.test.ts (the 23505 → 409 mapping).

const SOURCE = (cap: string) => `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Customer ${cap} {
        email: string
        name: string
        operation update(newName: string) { name := newName }
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource ordState { for: Ordering, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 4000
  }
}
`;

const fileEndingWith = (files: Map<string, string>, suffix: string): string => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} missing`).toBeDefined();
  return files.get(key!)!;
};

describe("vanilla — versioned optimistic-concurrency", () => {
  it("update changeset applies optimistic_lock(:version)", async () => {
    const cs = fileEndingWith(
      await generateSystemFiles(SOURCE("with versioned")),
      "customer_changeset.ex",
    );
    expect(cs).toContain("def update_changeset(struct, attrs) do");
    expect(cs).toContain("|> optimistic_lock(:version)");
    expect(cs).toContain(":version");
  });

  it("repository update overrides the struct version and rescues StaleEntryError", async () => {
    const repo = fileEndingWith(
      await generateSystemFiles(SOURCE("with versioned")),
      "customer_repository.ex",
    );
    expect(repo).toContain("expected_version \\\\ nil");
    expect(repo).toContain("record = %{record | version: expected_version || record.version}");
    expect(repo).toContain("Ecto.StaleEntryError -> {:error, :conflict}");
  });

  it("controller reads the if-match header and maps :conflict to conflict_response", async () => {
    const ctrl = fileEndingWith(
      await generateSystemFiles(SOURCE("with versioned")),
      "customer_controller.ex",
    );
    expect(ctrl).toContain("expected_version = __expected_version(conn)");
    expect(ctrl).toContain('get_req_header(conn, "if-match")');
    expect(ctrl).toContain("{:error, :conflict} ->");
    expect(ctrl).toContain("ProblemDetails.conflict_response(conn)");
  });

  it("ProblemDetails.conflict_response emits 409 with a distinct `conflict` event", async () => {
    const pd = fileEndingWith(
      await generateSystemFiles(SOURCE("with versioned")),
      "_web/problem_details.ex",
    );
    expect(pd).toContain("def conflict_response(conn) do");
    expect(pd).toContain('Logger.warning("conflict", event: "conflict"');
    expect(pd).toContain("status: 409,");
    expect(pd).toContain('title: "Conflict",');
    expect(pd).toContain("send_resp(409,");
  });

  it("migration carries the version column with default: 1", async () => {
    const migration = fileEndingWith(
      await generateSystemFiles(SOURCE("with versioned")),
      "_create_customers.exs",
    );
    expect(migration).toContain(":version");
    expect(migration).toContain("default: 1");
  });

  it("an aggregate WITHOUT `with versioned` still gets the optimistic lock — versioning is default-on (M-T3.4)", async () => {
    // There is no opt-out: every plain (non-event-sourced) aggregate is
    // auto-versioned by the macro expander, so the bare-capability source emits
    // exactly the same optimistic-concurrency machinery as `with versioned`.
    const files = await generateSystemFiles(SOURCE(""));
    const cs = fileEndingWith(files, "customer_changeset.ex");
    const repo = fileEndingWith(files, "customer_repository.ex");
    const pd = fileEndingWith(files, "_web/problem_details.ex");
    expect(cs).toContain("|> optimistic_lock(:version)");
    expect(cs).toContain(":version");
    expect(repo).toContain("expected_version \\\\ nil");
    expect(repo).toContain("Ecto.StaleEntryError -> {:error, :conflict}");
    expect(pd).toContain("def conflict_response(conn) do");
    // …and it is byte-identical to the explicitly `with versioned` emission.
    const explicit = await generateSystemFiles(SOURCE("with versioned"));
    expect(cs).toBe(fileEndingWith(explicit, "customer_changeset.ex"));
    expect(repo).toBe(fileEndingWith(explicit, "customer_repository.ex"));
  });
});
