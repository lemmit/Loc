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
    expect(repo).toContain(
      "Map.merge(record.data || %{}, __normalize_keys(stringify_keys(attrs)))",
    );
    expect(repo).toContain("change(%{data: data, version: record.version + 1})");
    // Same fn names as the relational repo (so context defdelegates are unchanged).
    expect(repo).toContain("def list do");
    expect(repo).toContain("def find_by_id(id)");
  });

  it("serializes the document via the camelCase wireShape projection (§14)", async () => {
    const ctrl = file(await generateSystemFiles(DOC), "/controllers/cart_controller.ex");
    // wireShape-driven: each stored field keyed by its declared (camelCase)
    // name, read from the snake-cased `data` jsonb key — a multi-word field
    // ships `itemCount`, not the raw `item_count` the old merge leaked.
    expect(ctrl).toContain(
      "data = Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)",
    );
    expect(ctrl).toContain('"id" => record.id');
    expect(ctrl).toContain('"itemCount" => Map.get(data, "item_count")');
    expect(ctrl).toContain('"reference" => Map.get(data, "reference")');
    // NOT the old raw-merge (snake keys) or a struct dump.
    expect(ctrl).not.toContain("Map.merge(%{id: record.id}, record.data");
    expect(ctrl).not.toContain("Map.from_struct()");
  });

  it("normalizes camelCase inbound keys to snake before the schemaless cast (§15)", async () => {
    const repo = file(await generateSystemFiles(DOC), "/carts/cart_repository.ex");
    // insert: raw params snaked before the changeset (a camelCase `itemCount`
    // body casts into `:item_count` instead of silently dropping → 422).
    expect(repo).toContain("attrs = __normalize_keys(attrs)");
    // update: attrs snaked BEFORE the merge, so a camelCase field overwrites the
    // stored snake key cleanly rather than landing beside it.
    expect(repo).toContain(
      "Map.merge(record.data || %{}, __normalize_keys(stringify_keys(attrs)))",
    );
    expect(repo).toContain("defp __normalize_keys(attrs) when is_map(attrs) do");
    expect(repo).toContain("{k, v} when is_binary(k) -> {Macro.underscore(k), v}");
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

// ---------------------------------------------------------------------------
// Scalar custom finds + named operations on a document aggregate (DEBT-07).
// A document row has no flattened columns, so a find filters IN MEMORY over the
// jsonb `data` map and a named op runs its body over that map, persisting via
// the document repo's `update/2`.
// ---------------------------------------------------------------------------
const DOC_OPS = `
system Carting {
  subdomain Sales {
    context Carts {
      enum CartStatus { open, checkedOut }
      aggregate Cart shape(document) with crudish {
        reference: string
        status: CartStatus
        itemCount: int
        invariant itemCount >= 0
        operation addItem() {
          precondition itemCount >= 0
          itemCount := itemCount + 1
        }
        operation checkOut() {
          precondition status == open
          status := checkedOut
        }
      }
      repository Carts for Cart {
        find byReference(reference: string): Cart? where this.reference == reference
        find checkedOutOnes(): Cart[] where this.status == checkedOut
      }
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

describe("vanilla shape(document) scalar finds + named ops (DEBT-07)", () => {
  it("emits in-memory custom finds that read the jsonb data map", async () => {
    const repo = file(await generateSystemFiles(DOC_OPS), "/carts/cart_repository.ex");
    // A list find returns every match; the predicate projects the field out of
    // the normalised `data` map (not a struct column), enums compared as strings.
    expect(repo).toContain("def checked_out_ones() do");
    expect(repo).toContain("|> Repo.all()");
    expect(repo).toContain("|> Enum.filter(fn record ->");
    expect(repo).toContain("data = __doc_data(record)");
    expect(repo).toContain('data["status"] == "checkedOut"');
    expect(repo).toContain("{:ok, results}");
    // A single-return find (`Cart?`) yields the first match (or nil).
    expect(repo).toContain("def by_reference(reference) do");
    expect(repo).toContain('data["reference"] == reference');
    expect(repo).toContain("{:ok, List.first(results)}");
    // The normaliser helper is emitted (gated on custom finds referencing it).
    expect(repo).toContain(
      "defp __doc_data(record), do: Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)",
    );
  });

  it("emits scalar named-op context fns that run over the data map + persist via update/2", async () => {
    const ctx = file(await generateSystemFiles(DOC_OPS), "/carts.ex");
    // The op body normalises the jsonb, guards, and Map.put's the assigned field.
    expect(ctx).toContain(
      "def add_item_cart(%Api.Carts.Cart{} = record, params) when is_map(params) do",
    );
    expect(ctx).toContain("data = Map.new(record.data || %{}, fn {k, v} -> {to_string(k), v} end)");
    expect(ctx).toContain('if not (data["item_count"] >= 0), do: raise(ArgumentError');
    expect(ctx).toContain('data = Map.put(data, "item_count", data["item_count"] + 1)');
    // Persist re-runs the schemaless changeset + bumps version via update/2.
    expect(ctx).toContain("Api.Carts.CartRepository.update(record, data)");
    // An enum assign uses the stored string form.
    expect(ctx).toContain('data = Map.put(data, "status", "checkedOut")');
    // The find defdelegates front the repository fns.
    expect(ctx).toContain(
      "defdelegate by_reference_cart(reference), to: Api.Carts.CartRepository, as: :by_reference",
    );
    // A document op must NOT use the relational struct-update / put_change path.
    expect(ctx).not.toContain("Ecto.Changeset.put_change(:item_count");
  });
});

// ---------------------------------------------------------------------------
// Non-scalar residual now emitted (DEBT-07 follow-up): value-object-subfield
// reads, pure-function calls, and RETURNING (`: A or B`) operations.
// ---------------------------------------------------------------------------
const DOC_RICH = `
system Carting {
  subdomain Sales {
    context Carts {
      valueobject Money { amount: int  currency: string }
      error AlreadyClosed { message: string }
      aggregate Cart shape(document) with crudish {
        subtotal: Money
        itemCount: int
        function isCheap(): bool = subtotal.amount < 100
        operation discount() {
          precondition isCheap()
          precondition subtotal.amount >= 0
          itemCount := itemCount + 1
        }
        operation tryClose(): Cart or AlreadyClosed {
          return AlreadyClosed { message: "closed" }
        }
        operation bumpOrClose(): Cart or AlreadyClosed {
          itemCount := itemCount + 1
        }
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

describe("vanilla shape(document) non-scalar residual (DEBT-07 follow-up)", () => {
  it("emits document functions over the data map + value-object-subfield reads", async () => {
    const ctx = file(await generateSystemFiles(DOC_RICH), "/carts.ex");
    // A pure function on a document aggregate takes the jsonb `data` map (guarded
    // is_map), reading the value-object subfield via the key-type-agnostic
    // fallback (a VO map may be string- or atom-keyed; #1660).
    expect(ctx).toContain("def is_cheap(data) when is_map(data) do");
    expect(ctx).toContain(
      'Map.get(data["subtotal"], :amount, Map.get(data["subtotal"], "amount")) < 100',
    );
    // The op guard calls the function passing the data map, and reads the VO sub-field.
    expect(ctx).toContain("if not (is_cheap(data)), do: raise(ArgumentError");
    expect(ctx).toContain(
      'if not (Map.get(data["subtotal"], :amount, Map.get(data["subtotal"], "amount")) >= 0), do: raise(ArgumentError',
    );
  });

  it("emits returning ops as tagged tuples (error variant + fall-through success wire)", async () => {
    const ctx = file(await generateSystemFiles(DOC_RICH), "/carts.ex");
    // An error-variant `return` → {:error, "<tag>", <map>}; `record` is unused
    // (no data touched) so it's underscored to avoid a -Werror unused warning.
    expect(ctx).toContain(
      "def try_close_cart(%Api.Carts.Cart{} = _record, params) when is_map(params) do",
    );
    expect(ctx).toContain('{:error, "AlreadyClosed", %{message: "closed"}}');
    // A fall-through success projects the in-memory wire off the mutated data —
    // `id` + every stored document field (camelCase keys, matching serialize/1).
    expect(ctx).toContain(
      "def bump_or_close_cart(%Api.Carts.Cart{} = record, params) when is_map(params) do",
    );
    expect(ctx).toContain(
      '{:ok, %{"id" => record.id, "subtotal" => data["subtotal"], "itemCount" => data["item_count"]}}',
    );
  });
});
