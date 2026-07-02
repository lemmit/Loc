import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `shape(document)` persistence on the vanilla (plain Ecto) foundation —
// DEBT-07.  The whole aggregate persists as ONE jsonb `data` blob in an
// `(id, data, version)` table.  Writes validate the domain fields through a
// SCHEMALESS changeset (cast + validate_required + invariant validators — the
// same contract the relational `base_changeset` runs) and store the validated
// map; reads merge `data` back over the id.  v1 scope: CRUD.
// ---------------------------------------------------------------------------

const DOC = `
system Carting {
  subdomain Sales {
    context Carts {
      valueobject Money { amount: int  currency: string }
      enum CartStatus { open, checkedOut }
      aggregate Cart shape(document) with crudish {
        reference: string
        status: CartStatus
        subtotal: Money
        itemCount: int
        invariant itemCount >= 0
      }
      repository Carts for Cart { }
    }
  }
  api CartsApi from Sales
  storage pg { type: postgres }
  resource cartState { for: Carts, kind: state, use: pg }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

// Same aggregate without shape(document) — asserts the document path is gated
// off (relational columns + Map.from_struct serialize stay byte-identical).
const RELATIONAL = DOC.replace(" shape(document)", "");

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla shape(document) persistence (DEBT-07)", () => {
  it("emits an (id, data, version) schema, not flattened columns", async () => {
    const schema = file(await generateSystemFiles(DOC), "/carts/cart.ex");
    expect(schema).toContain("field :data, :map");
    expect(schema).toContain("field :version, :integer, default: 1");
    // No flattened domain columns on a document schema.
    expect(schema).not.toContain("field :reference");
    expect(schema).not.toContain("field :item_count");
  });

  it("validates through a schemaless changeset (cast + required + invariants)", async () => {
    const cs = file(await generateSystemFiles(DOC), "/carts/cart_changeset.ex");
    // Schemaless form: a {%{}, @types} cast, not a struct cast.
    expect(cs).toContain(
      "@types %{reference: :string, status: :string, subtotal: :map, item_count: :integer}",
    );
    expect(cs).toContain("{%{}, @types}");
    expect(cs).toContain("|> cast(attrs, @all_fields)");
    expect(cs).toContain("|> validate_required(@required_fields)");
    // The same invariant-derived validator the relational path emits.
    expect(cs).toContain("validate_number(:item_count, greater_than_or_equal_to: 0)");
  });

  it("repository CRUD round-trips the document (validated fold + version bump)", async () => {
    const repo = file(await generateSystemFiles(DOC), "/carts/cart_repository.ex");
    // Insert: validate → store the applied map as data, version 1.
    expect(repo).toContain(
      "Ecto.Changeset.apply_action(Api.Carts.CartChangeset.document_changeset(attrs), :insert)",
    );
    expect(repo).toContain("%Api.Carts.Cart{id: Ecto.UUID.generate(), data: data, version: 1}");
    // Update: merge over the current doc, re-validate, bump version.
    expect(repo).toContain("Map.merge(record.data || %{}, stringify_keys(attrs))");
    expect(repo).toContain("change(%{data: data, version: record.version + 1})");
    // Same fn names as the relational repo (so context defdelegates are unchanged).
    expect(repo).toContain("def list do");
    expect(repo).toContain("def find_by_id(id)");
  });

  it("serializes by merging the document data over the id (not Map.from_struct)", async () => {
    const ctrl = file(await generateSystemFiles(DOC), "/controllers/cart_controller.ex");
    expect(ctrl).toContain("Map.merge(%{id: record.id}, record.data || %{})");
    expect(ctrl).not.toContain("Map.from_struct()");
  });

  it("emits the canonical (id, data, version) document migration", async () => {
    const mig = file(await generateSystemFiles(DOC), "_create_carts.exs");
    expect(mig).toContain("add :data, :map");
    expect(mig).toContain("add :version, :integer");
    expect(mig).not.toContain("add :reference");
  });

  it("gates the document path off for a relational aggregate (byte-identical)", async () => {
    const schema = file(await generateSystemFiles(RELATIONAL), "/carts/cart.ex");
    expect(schema).toContain("field :reference, :string");
    expect(schema).not.toContain("field :data, :map");
    const ctrl = file(await generateSystemFiles(RELATIONAL), "/controllers/cart_controller.ex");
    // The relational serializer projects from the aggregate's wireShape (the
    // canonical cross-backend wire), NOT a raw `Map.from_struct` struct dump.
    expect(ctrl).not.toContain("Map.from_struct()");
    expect(ctrl).toContain('"reference" => record.reference');
    expect(ctrl).toContain('"itemCount" => record.item_count');
  });
});
